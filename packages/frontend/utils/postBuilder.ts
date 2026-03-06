import { MentionData } from '@/components/MentionTextInput';
import { GeoJSONPoint } from '@mention/shared-types';
import { buildAttachmentsPayload } from './attachmentsUtils';
import {
  ComposerMediaItem,
  POLL_ATTACHMENT_KEY,
  LOCATION_ATTACHMENT_KEY,
  createMediaAttachmentKey,
} from './composeUtils';

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
  replyPermission: string;
  reviewReplies: boolean;
  scheduledAt: Date | null;
}

interface ThreadItem {
  id: string;
  text: string;
  mentions?: MentionData[];
  mediaIds: ComposerMediaItem[];
  pollTitle?: string;
  pollOptions: string[];
  location?: {
    latitude: number;
    longitude: number;
    address?: string;
  } | null;
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
    scheduledAt,
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
    ...(wasScheduled && scheduledAt ? {
      status: 'scheduled' as const,
      scheduledFor: scheduledAt.toISOString()
    } : {})
  };
};

export const buildThreadPost = (
  item: ThreadItem,
  replyPermission: string,
  reviewReplies: boolean
) => {
  const threadHasPoll = item.pollOptions.length > 0 && item.pollOptions.some(opt => opt.trim().length > 0);
  const threadHasLocation = Boolean(item.location);
  const threadOrder: string[] = [];
  
  if (threadHasPoll) threadOrder.push(POLL_ATTACHMENT_KEY);
  item.mediaIds.forEach((media) => {
    threadOrder.push(createMediaAttachmentKey(media.id));
  });
  if (threadHasLocation) threadOrder.push(LOCATION_ATTACHMENT_KEY);

  const threadAttachmentsPayload = buildAttachmentsPayload(threadOrder, item.mediaIds, {
    includePoll: threadHasPoll,
    includeArticle: false,
    includeLocation: threadHasLocation,
    includeSources: false,
  });

  return {
    content: {
      text: item.text.trim(),
      media: item.mediaIds.map(m => ({ id: m.id, type: m.type })),
      ...(item.pollOptions.length > 0 && item.pollOptions.some(opt => opt.trim().length > 0) && {
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
      ...(threadAttachmentsPayload.length > 0 && { attachments: threadAttachmentsPayload })
    },
    mentions: item.mentions?.map(m => m.userId) || [],
    hashtags: [],
    replyPermission: replyPermission,
    reviewReplies: reviewReplies
  };
};

export const shouldIncludeThreadItem = (item: ThreadItem): boolean => {
  return item.text.trim().length > 0 || 
         item.mediaIds.length > 0 ||
         (item.pollOptions.length > 0 && item.pollOptions.some(opt => opt.trim().length > 0));
};
