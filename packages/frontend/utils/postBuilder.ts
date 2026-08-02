import type { MentionData } from '@/utils/mentions';
import { reconcileMentionIds } from '@mention/shared-types/mentions';
import type {
  CreatePostRequest,
  CreateThreadPostRequest,
  GeoJSONPoint,
  PostContentVariant,
  PostSourceLink,
  ReplyPermission,
  UpdatePostRequest,
} from '@mention/shared-types';
import { buildAttachmentsPayload } from './attachmentsUtils';
import {
  ComposerMediaItem,
  POLL_ATTACHMENT_KEY,
  LOCATION_ATTACHMENT_KEY,
  SOURCES_ATTACHMENT_KEY,
  ARTICLE_ATTACHMENT_KEY,
  EVENT_ATTACHMENT_KEY,
  ROOM_ATTACHMENT_KEY,
  createMediaAttachmentKey,
} from './composeUtils';
import type { ThreadItem } from '@/hooks/useThreadManager';
import type { ArticleData } from '@/hooks/useArticleManager';
import type { EventData } from '@/hooks/useEventManager';
import type { RoomAttachmentData } from '@/hooks/useRoomManager';
import type { PodcastAttachmentData } from '@/hooks/usePodcastManager';

type ComposeLocation = {
  latitude: number;
  longitude: number;
  address?: string;
};

interface BuildMainPostParams {
  postContent: string;
  mentions: MentionData[];
  mediaIds: ComposerMediaItem[];
  pollTitle: string;
  pollOptions: string[];
  article: ArticleData | null;
  hasArticleContent: boolean;
  event: EventData | null;
  hasEventContent: boolean;
  room: RoomAttachmentData | null;
  hasRoomContent: boolean;
  podcast: PodcastAttachmentData | null;
  hasPodcastContent: boolean;
  location: ComposeLocation | null;
  formattedSources: PostSourceLink[];
  attachmentOrder: string[];
  replyPermission: ReplyPermission[];
  reviewReplies: boolean;
  quotesDisabled: boolean;
  scheduledAt: Date | null;
  isSensitive?: boolean;
  /** When set, links the new post as a quote of this post id. */
  quotedPostId?: string;
  collaboratorIds?: string[];
  /**
   * The author's own lane for this post.
   *
   * Only ever set on an ORIGINAL post: the server refuses a lane on a reply or a
   * boost (400), and the composer hides the affordance entirely while replying
   * rather than letting the author pick one that gets dropped. A quote takes one
   * — it is an original post with its own body and its own row on the profile.
   */
  laneId?: string;
  /**
   * The channel this post is published TO.
   *
   * A destination rather than a lens: the post belongs to the channel and only to
   * the channel — never the author's profile, never their followers' timeline,
   * and it accepts no replies. Only ever set on an ORIGINAL post: the server
   * refuses a channel on a reply, a boost and a federated ingest (400/403), and
   * the composer hides the affordance on those paths rather than letting the
   * author pick a destination that gets dropped.
   *
   * To put a channel post on your own profile you BOOST it; there is no field
   * for that, because a boost is already the right row with the right owner.
   */
  channelId?: string;
  /**
   * The author renditions of this post, PRIMARY FIRST — order is what names the
   * primary. `null` when the author declared no language, which keeps a
   * single-language post's payload exactly what it has always been and leaves the
   * language to server-side detection.
   */
  variantContent?: PostContentVariant[] | null;
}

export const buildMainPost = (params: BuildMainPostParams): CreatePostRequest => {
  const {
    postContent,
    mentions,
    mediaIds,
    pollTitle,
    pollOptions,
    article,
    hasArticleContent,
    event,
    hasEventContent,
    room,
    hasRoomContent,
    podcast,
    hasPodcastContent,
    location,
    formattedSources,
    attachmentOrder,
    replyPermission,
    reviewReplies,
    quotesDisabled,
    scheduledAt,
    isSensitive,
    quotedPostId,
    collaboratorIds,
    laneId,
    channelId,
    variantContent,
  } = params;

  const hasPoll = pollOptions.length > 0 && pollOptions.some(opt => opt.trim().length > 0);
  const wasScheduled = Boolean(scheduledAt);
  const mentionIds = reconcileMentionIds(
    [
      postContent,
      ...(variantContent ?? []).map((variant) => variant.text),
    ],
    mentions.map((mention) => mention.userId),
  );

  const podcastId = hasPodcastContent && podcast ? podcast.syraPodcastId : undefined;

  const attachmentsPayload = buildAttachmentsPayload(attachmentOrder, mediaIds, {
    includePoll: hasPoll,
    includeArticle: Boolean(hasArticleContent && article),
    includeEvent: Boolean(hasEventContent && event),
    includeRoom: Boolean(hasRoomContent && room),
    includeLocation: Boolean(location),
    includeSources: formattedSources.length > 0,
    podcastId,
  });

  const articlePayload = hasArticleContent && article ? {
    ...(article.title?.trim() ? { title: article.title.trim() } : {}),
    ...(article.body?.trim() ? { body: article.body.trim() } : {}),
  } : undefined;

  return {
    content: {
      text: postContent.trim(),
      ...(variantContent ? { variants: variantContent } : {}),
      media: mediaIds.map(m => ({
        id: m.id,
        type: m.type,
        ...(m.type === 'image' && m.alt?.trim() ? { alt: m.alt.trim() } : {}),
      })),
      ...(hasPoll && {
        poll: {
          question: pollTitle.trim() || postContent.trim() || 'Poll',
          options: pollOptions.filter(opt => opt.trim().length > 0),
          endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          votes: {},
          userVotes: {}
        }
      }),
      ...(location && {
        location: {
          type: 'Point' as const,
          coordinates: [location.longitude, location.latitude],
          address: location.address
        } as GeoJSONPoint
      }),
      ...(formattedSources.length > 0 && { sources: formattedSources }),
      ...(articlePayload && { article: articlePayload }),
      ...(hasEventContent && event && {
        event: {
          name: event.name.trim(),
          date: event.date,
          ...(event.location?.trim() && { location: event.location.trim() }),
          ...(event.description?.trim() && { description: event.description.trim() }),
        }
      }),
      ...(hasRoomContent && room && {
        room: {
          roomId: room.roomId,
          title: room.title.trim(),
          ...(room.status && { status: room.status }),
          ...(room.topic?.trim() && { topic: room.topic.trim() }),
          ...(room.host && { host: room.host }),
        }
      }),
      ...(podcastId && { podcast: { syraPodcastId: podcastId } }),
      ...(attachmentsPayload.length > 0 && { attachments: attachmentsPayload })
    },
    mentions: mentionIds,
    hashtags: [],
    replyPermission: replyPermission,
    reviewReplies: reviewReplies,
    quotesDisabled: quotesDisabled,
    ...(quotedPostId ? { quotedPostId } : {}),
    ...(collaboratorIds && collaboratorIds.length > 0 ? { collaboratorIds } : {}),
    ...(laneId ? { laneId } : {}),
    ...(channelId ? { channelId } : {}),
    ...(isSensitive ? { metadata: { isSensitive: true } } : {}),
    ...(wasScheduled && scheduledAt ? {
      status: 'scheduled' as const,
      scheduledFor: scheduledAt.toISOString()
    } : {})
  };
};

interface BuildEditPostParams {
  postContent: string;
  mediaIds: ComposerMediaItem[];
  mentions: string[];
  hashtags: string[];
  collaboratorIds?: string[];
  variantContent?: PostContentVariant[] | null;
  /**
   * The publish time when the post being edited is still SCHEDULED. Sent on
   * every such save, not only when it changed, so a save can never be the thing
   * that quietly drops a schedule.
   */
  scheduledAt?: Date | null;
}

/**
 * The payload of an EDIT.
 *
 * Editing does not go through {@link buildMainPost} — an edit may only touch the
 * body, the media and the collaborators, so it sends `UpdatePostRequest`, not a
 * whole post. It still has to carry the renditions: without them, editing a
 * multilingual post would silently strip every language but the primary.
 */
export const buildEditPost = (params: BuildEditPostParams): UpdatePostRequest => {
  const { postContent, mediaIds, mentions, hashtags, collaboratorIds, variantContent, scheduledAt } = params;
  const mentionIds = reconcileMentionIds(
    [
      postContent,
      ...(variantContent ?? []).map((variant) => variant.text),
    ],
    mentions,
  );

  return {
    content: {
      text: postContent,
      ...(variantContent ? { variants: variantContent } : {}),
      media: mediaIds.map(m => ({
        id: m.id,
        type: m.type,
        ...(m.type === 'image' && m.alt?.trim() ? { alt: m.alt.trim() } : {}),
      })),
    },
    hashtags,
    mentions: mentionIds,
    ...(collaboratorIds && collaboratorIds.length > 0 ? { collaboratorIds } : {}),
    ...(scheduledAt ? { scheduledFor: scheduledAt.toISOString() } : {}),
  };
};

export const buildThreadPost = (
  item: ThreadItem,
  variantContent?: PostContentVariant[] | null,
): CreateThreadPostRequest => {
  const threadHasPoll = item.pollOptions.length > 0 && item.pollOptions.some(opt => opt.trim().length > 0);
  const threadHasLocation = Boolean(item.location);
  const threadHasArticle = Boolean(item.article && (item.article.title?.trim() || item.article.body?.trim()));
  const threadHasEvent = Boolean(item.event && item.event.name?.trim());
  const threadHasRoom = Boolean(item.room && item.room.roomId);
  const threadFormattedSources = (item.sources || []).filter(s => s.url.trim().length > 0);
  const threadHasSources = threadFormattedSources.length > 0;
  const mentionIds = reconcileMentionIds(
    [
      item.text,
      ...(variantContent ?? []).map((variant) => variant.text),
    ],
    item.mentions.map((mention) => mention.userId),
  );

  // Use explicit attachment order if provided, otherwise auto-build
  let threadOrder: string[];
  if (item.attachmentOrder && item.attachmentOrder.length > 0) {
    threadOrder = item.attachmentOrder;
  } else {
    threadOrder = [];
    if (threadHasPoll) threadOrder.push(POLL_ATTACHMENT_KEY);
    if (threadHasArticle) threadOrder.push(ARTICLE_ATTACHMENT_KEY);
    if (threadHasEvent) threadOrder.push(EVENT_ATTACHMENT_KEY);
    if (threadHasRoom) threadOrder.push(ROOM_ATTACHMENT_KEY);
    item.mediaIds.forEach((media) => {
      threadOrder.push(createMediaAttachmentKey(media.id));
    });
    if (threadHasSources) threadOrder.push(SOURCES_ATTACHMENT_KEY);
    if (threadHasLocation) threadOrder.push(LOCATION_ATTACHMENT_KEY);
  }

  const threadAttachmentsPayload = buildAttachmentsPayload(threadOrder, item.mediaIds, {
    includePoll: threadHasPoll,
    includeArticle: threadHasArticle,
    includeEvent: threadHasEvent,
    includeRoom: threadHasRoom,
    includeLocation: threadHasLocation,
    includeSources: threadHasSources,
  });

  const threadArticlePayload = threadHasArticle && item.article ? {
    ...(item.article.title?.trim() ? { title: item.article.title.trim() } : {}),
    ...(item.article.body?.trim() ? { body: item.article.body.trim() } : {}),
  } : undefined;

  return {
    content: {
      text: item.text.trim(),
      ...(variantContent ? { variants: variantContent } : {}),
      media: item.mediaIds.map(m => ({
        id: m.id,
        type: m.type,
        ...(m.type === 'image' && m.alt?.trim() ? { alt: m.alt.trim() } : {}),
      })),
      ...(threadHasPoll && {
        poll: {
          question: (item.pollTitle && item.pollTitle.trim()) || item.text.trim() || 'Poll',
          options: item.pollOptions.filter(opt => opt.trim().length > 0),
          endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          votes: {},
          userVotes: {}
        }
      }),
      ...(item.location && {
        location: {
          type: 'Point' as const,
          coordinates: [item.location.longitude, item.location.latitude],
          address: item.location.address
        } as GeoJSONPoint
      }),
      ...(threadHasSources && { sources: threadFormattedSources.map(s => ({ url: s.url.trim(), title: s.title?.trim() || '' })) }),
      ...(threadArticlePayload && { article: threadArticlePayload }),
      ...(threadHasEvent && item.event && {
        event: {
          name: item.event.name.trim(),
          date: item.event.date,
          ...(item.event.location?.trim() && { location: item.event.location.trim() }),
          ...(item.event.description?.trim() && { description: item.event.description.trim() }),
        }
      }),
      ...(threadHasRoom && item.room && {
        room: {
          roomId: item.room.roomId,
          title: item.room.title.trim(),
          ...(item.room.status && { status: item.room.status }),
          ...(item.room.topic?.trim() && { topic: item.room.topic.trim() }),
          ...(item.room.host && { host: item.room.host }),
        }
      }),
      ...(threadAttachmentsPayload.length > 0 && { attachments: threadAttachmentsPayload })
    },
    mentions: mentionIds,
    hashtags: [],
    replyPermission: item.replyPermission || ['anyone'],
    reviewReplies: item.reviewReplies || false,
    quotesDisabled: item.quotesDisabled || false,
    ...(item.isSensitive ? { metadata: { isSensitive: true } } : {}),
  };
};

export const shouldIncludeThreadItem = (item: ThreadItem): boolean => {
  return item.text.trim().length > 0 ||
         item.mediaIds.length > 0 ||
         (item.pollOptions.length > 0 && item.pollOptions.some(opt => opt.trim().length > 0)) ||
         Boolean(item.article && (item.article.title?.trim() || item.article.body?.trim())) ||
         Boolean(item.event && item.event.name?.trim()) ||
         Boolean(item.room && item.room.roomId) ||
         Boolean(item.sources && item.sources.length > 0 && item.sources.some(s => s.url.trim().length > 0));
};
