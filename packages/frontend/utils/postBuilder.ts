import { MentionData } from '@/components/MentionTextInput';
import { GeoJSONPoint } from '@mention/shared-types';
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

interface BuildMainPostParams {
  postContent: string;
  mentions: MentionData[];
  mediaIds: ComposerMediaItem[];
  pollTitle: string;
  pollOptions: string[];
  article: any;
  hasArticleContent: boolean;
  event: any;
  hasEventContent: boolean;
  room: any;
  hasRoomContent: boolean;
  location: any;
  formattedSources: any[];
  attachmentOrder: string[];
  replyPermission: string[];
  reviewReplies: boolean;
  quotesDisabled: boolean;
  scheduledAt: Date | null;
  isSensitive?: boolean;
}

export const buildMainPost = (params: BuildMainPostParams) => {
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
    location,
    formattedSources,
    attachmentOrder,
    replyPermission,
    reviewReplies,
    quotesDisabled,
    scheduledAt,
    isSensitive,
  } = params;

  const hasPoll = pollOptions.length > 0 && pollOptions.some(opt => opt.trim().length > 0);
  const wasScheduled = Boolean(scheduledAt);

  const attachmentsPayload = buildAttachmentsPayload(attachmentOrder, mediaIds, {
    includePoll: hasPoll,
    includeArticle: Boolean(hasArticleContent && article),
    includeEvent: Boolean(hasEventContent && event),
    includeRoom: Boolean(hasRoomContent && room),
    includeLocation: Boolean(location),
    includeSources: formattedSources.length > 0,
  });

  const articlePayload = hasArticleContent && article ? {
    ...(article.title?.trim() ? { title: article.title.trim() } : {}),
    ...(article.body?.trim() ? { body: article.body.trim() } : {}),
  } : undefined;

  return {
    content: {
      text: postContent.trim(),
      media: mediaIds.map(m => ({ id: m.id, type: m.type })),
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
      ...(attachmentsPayload.length > 0 && { attachments: attachmentsPayload })
    },
    mentions: mentions.map(m => m.userId),
    hashtags: [],
    replyPermission: replyPermission,
    reviewReplies: reviewReplies,
    quotesDisabled: quotesDisabled,
    ...(isSensitive ? { metadata: { isSensitive: true } } : {}),
    ...(wasScheduled && scheduledAt ? {
      status: 'scheduled' as const,
      scheduledFor: scheduledAt.toISOString()
    } : {})
  };
};

export const buildThreadPost = (item: ThreadItem) => {
  const threadHasPoll = item.pollOptions.length > 0 && item.pollOptions.some(opt => opt.trim().length > 0);
  const threadHasLocation = Boolean(item.location);
  const threadHasArticle = Boolean(item.article && (item.article.title?.trim() || item.article.body?.trim()));
  const threadHasEvent = Boolean(item.event && item.event.name?.trim());
  const threadHasRoom = Boolean(item.room && item.room.roomId);
  const threadFormattedSources = (item.sources || []).filter(s => s.url.trim().length > 0);
  const threadHasSources = threadFormattedSources.length > 0;

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
      media: item.mediaIds.map(m => ({ id: m.id, type: m.type })),
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
    mentions: item.mentions?.map(m => m.userId) || [],
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
