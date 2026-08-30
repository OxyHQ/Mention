/**
 * The request-body readers every post-composition handler shares.
 *
 * `createPost`, `createThread` and `updatePost` all accept the same
 * client-supplied composition payload — sources, article, event, room,
 * attachment order — and all three must bound and normalise it identically. The
 * readers live here so a bound tightened on create cannot be missed on update.
 */

import { PostAttachmentDescriptor, PostAttachmentType } from '@mention/shared-types';
import { config } from '../../config';
import type { NormalizedMediaItem } from '../../utils/mediaInput';

/**
 * An article whose id is minted but whose row is not written yet.
 *
 * The post's content document has to carry `articleId`, and the article row must
 * not exist until the post it belongs to does — so the id is minted first and
 * the insert happens after the post succeeds. See `db/posts/articleRepository.ts`.
 */
export interface PendingArticle {
  id: string;
  createdBy: string;
  title?: string;
  body?: string;
}

// Constants from centralized config
const MAX_SOURCES = config.posts.maxSources;
const MAX_SOURCE_TITLE_LENGTH = config.posts.maxSourceTitleLength;
const MAX_ARTICLE_TITLE_LENGTH = config.posts.maxArticleTitleLength;
export const MAX_ARTICLE_EXCERPT_LENGTH = config.posts.maxArticleExcerptLength;
export const DEFAULT_POLL_DURATION_DAYS = config.posts.defaultPollDurationDays;
export const MAX_POLL_DURATION_DAYS = config.posts.maxPollDurationDays;
export const MAX_HASHTAG_LENGTH = config.posts.maxHashtagLength;
export const MAX_HASHTAGS_PER_POST = config.posts.maxHashtagsPerPost;
const MAX_EVENT_NAME_LENGTH = config.posts.maxEventNameLength;
const MAX_EVENT_LOCATION_LENGTH = config.posts.maxEventLocationLength;
const MAX_EVENT_DESCRIPTION_LENGTH = config.posts.maxEventDescriptionLength;
export const MAX_TEXT_LENGTH = config.posts.maxTextLength;

export const buildPostMetadata = (metadata: unknown): Record<string, unknown> => {
  if (!metadata || typeof metadata !== 'object') {
    return {};
  }

  const incomingMetadata = metadata as Record<string, unknown>;
  const postMetadata: Record<string, unknown> = {};

  if (incomingMetadata.isSensitive === true) {
    postMetadata.isSensitive = true;
  }

  return postMetadata;
};

/**
 * Sanitize and validate sources array.
 * Returns { sources, error } — error is set if the array exceeds the max size.
 */
export const sanitizeSources = (arr: unknown): { sources: Array<{ url: string; title?: string }>; error?: string } => {
  if (!Array.isArray(arr)) return { sources: [] };

  if (arr.length > MAX_SOURCES) {
    return { sources: [], error: `Too many sources: maximum is ${MAX_SOURCES}, received ${arr.length}` };
  }

  const normalized = arr
    .map((item: unknown) => {
      if (!item) return null;
      const rawUrl = typeof item === 'string' ? item : (item as Record<string, unknown>).url;
      if (!rawUrl || typeof rawUrl !== 'string') return null;

      const urlTrimmed = rawUrl.trim();
      if (!urlTrimmed) return null;

      try {
        const parsed = new URL(urlTrimmed);
        const normalizedUrl = parsed.toString();
        const titleRaw = (item as Record<string, unknown>)?.title;
        const title = typeof titleRaw === 'string' ? titleRaw.trim().slice(0, MAX_SOURCE_TITLE_LENGTH) : undefined;
        return title ? { url: normalizedUrl, title } : { url: normalizedUrl };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Array<{ url: string; title?: string }>;

  return { sources: normalized };
};

export const sanitizeArticle = (input: unknown): { title?: string; body?: string } | undefined => {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const title = typeof obj.title === 'string' ? obj.title.trim().slice(0, MAX_ARTICLE_TITLE_LENGTH) : undefined;
  const body = typeof obj.body === 'string' ? obj.body.trim() : undefined;
  if (!title && !body) return undefined;
  return { ...(title ? { title } : {}), ...(body ? { body } : {}) };
};

export const sanitizeEventData = (eventData: unknown): { eventId?: string; name?: string; date?: string; location?: string; description?: string } | null => {
  if (!eventData || typeof eventData !== 'object') return null;
  const obj = eventData as Record<string, unknown>;

  const sanitized = {
    eventId: typeof obj.eventId === 'string' ? obj.eventId.trim() : undefined,
    name: typeof obj.name === 'string' ? obj.name.trim().slice(0, MAX_EVENT_NAME_LENGTH) : undefined,
    date: typeof obj.date === 'string'
      ? obj.date.trim()
      : (obj.date instanceof Date ? obj.date.toISOString() : undefined),
    location: typeof obj.location === 'string' ? obj.location.trim().slice(0, MAX_EVENT_LOCATION_LENGTH) : undefined,
    description: typeof obj.description === 'string' ? obj.description.trim().slice(0, MAX_EVENT_DESCRIPTION_LENGTH) : undefined,
  };

  if (!sanitized.name || !sanitized.date) return null;

  try {
    const dateObj = new Date(sanitized.date);
    if (isNaN(dateObj.getTime())) return null;
  } catch {
    return null;
  }

  return sanitized;
};

export const sanitizeRoomData = (roomData: unknown): { roomId: string; title: string; status?: string; topic?: string; host?: string } | null => {
  if (!roomData || typeof roomData !== 'object') return null;
  const obj = roomData as Record<string, unknown>;
  const id = obj.roomId;
  if (typeof id !== 'string' || typeof obj.title !== 'string') return null;

  return {
    roomId: id.trim(),
    title: obj.title.trim().slice(0, 200),
    ...(typeof obj.status === 'string' && ['scheduled', 'live', 'ended'].includes(obj.status) ? { status: obj.status } : {}),
    ...(typeof obj.topic === 'string' ? { topic: obj.topic.trim().slice(0, 100) } : {}),
    ...(typeof obj.host === 'string' ? { host: obj.host.trim() } : {}),
  };
};

type RawAttachmentInput =
  | string
  | {
      type?: string;
      id?: string;
      mediaId?: string;
      mediaType?: string;
      attachmentType?: string;
      kind?: string;
    };

const ATTACHMENT_TYPES: PostAttachmentType[] = ['media', 'poll', 'article', 'event', 'room', 'location', 'sources', 'podcast'];

const normalizeAttachmentInput = (entry: RawAttachmentInput): PostAttachmentDescriptor | null => {
  if (!entry) return null;

  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    if (!trimmed) return null;

    if (trimmed.toLowerCase().startsWith('media:')) {
      const id = trimmed.slice('media:'.length).trim();
      if (!id) return null;
      return { type: 'media', id };
    }

    const lower = trimmed.toLowerCase();
    if ((ATTACHMENT_TYPES as string[]).includes(lower)) {
      return { type: lower as PostAttachmentType };
    }
    return null;
  }

  if (typeof entry === 'object') {
    const typeValue = entry.type || entry.attachmentType || entry.kind;
    if (!typeValue) return null;
    const lowerType = String(typeValue).toLowerCase();
    if (!(ATTACHMENT_TYPES as string[]).includes(lowerType)) return null;

    const descriptor: PostAttachmentDescriptor = { type: lowerType as PostAttachmentType };

    if (descriptor.type === 'media') {
      const id = entry.id || entry.mediaId;
      if (!id) return null;
      descriptor.id = String(id);
      if (entry.mediaType) {
        const mt = String(entry.mediaType).toLowerCase();
        if (mt === 'image' || mt === 'video' || mt === 'gif') {
          descriptor.mediaType = mt as 'image' | 'video' | 'gif';
        }
      }
    }

    return descriptor;
  }

  return null;
};

interface AttachmentBuildOptions {
  rawAttachments?: unknown;
  media: NormalizedMediaItem[];
  includePoll?: boolean;
  includeArticle?: boolean;
  includeEvent?: boolean;
  includeRoom?: boolean;
  includeLocation?: boolean;
  includeSources?: boolean;
  includePodcast?: boolean;
}

export const buildOrderedAttachments = ({
  rawAttachments,
  media,
  includePoll = false,
  includeArticle = false,
  includeEvent = false,
  includeRoom = false,
  includeLocation = false,
  includeSources = false,
  includePodcast = false
}: AttachmentBuildOptions): PostAttachmentDescriptor[] | undefined => {
  const descriptors: PostAttachmentDescriptor[] = [];
  const nonMediaTypes = new Set<PostAttachmentType>();
  const mediaById = new Map<string, NormalizedMediaItem>();
  const usedMedia = new Set<string>();

  media.forEach((item) => {
    mediaById.set(String(item.id), item);
  });

  const addNonMedia = (type: PostAttachmentType) => {
    if (type === 'media') return;
    if (nonMediaTypes.has(type)) return;
    nonMediaTypes.add(type);
    descriptors.push({ type });
  };

  const addMedia = (id: string, explicitType?: 'image' | 'video' | 'gif') => {
    const mediaId = String(id);
    if (usedMedia.has(mediaId)) return;
    const mediaItem = mediaById.get(mediaId);
    if (!mediaItem) return;
    usedMedia.add(mediaId);
    descriptors.push({
      type: 'media',
      id: mediaId,
      mediaType: explicitType || mediaItem.type
    });
  };

  const processEntry = (entry: unknown) => {
    const descriptor = normalizeAttachmentInput(entry as RawAttachmentInput);
    if (!descriptor) return;

    switch (descriptor.type) {
      case 'media': {
        if (descriptor.id) {
          addMedia(descriptor.id, descriptor.mediaType);
        }
        break;
      }
      case 'poll':
        if (includePoll) addNonMedia('poll');
        break;
      case 'article':
        if (includeArticle) addNonMedia('article');
        break;
      case 'event':
        if (includeEvent) addNonMedia('event');
        break;
      case 'room':
        if (includeRoom) addNonMedia('room');
        break;
      case 'location':
        if (includeLocation) addNonMedia('location');
        break;
      case 'sources':
        if (includeSources) addNonMedia('sources');
        break;
      case 'podcast':
        if (includePodcast) addNonMedia('podcast');
        break;
      default:
        break;
    }
  };

  if (Array.isArray(rawAttachments)) {
    rawAttachments.forEach(processEntry);
  } else if (rawAttachments) {
    // Support objects with { order: [...] }
    const rawObj = rawAttachments as Record<string, unknown>;
    const maybeOrder = rawObj.order || rawObj.attachments || rawObj.attachmentOrder;
    if (Array.isArray(maybeOrder)) {
      maybeOrder.forEach(processEntry);
    }
  }

  if (includePoll) addNonMedia('poll');
  if (includeArticle) addNonMedia('article');
  if (includeEvent) addNonMedia('event');
  if (includeRoom) addNonMedia('room');
  if (includeSources) addNonMedia('sources');
  if (includeLocation) addNonMedia('location');
  if (includePodcast) addNonMedia('podcast');

  media.forEach((item) => {
    const id = String(item.id);
    if (!usedMedia.has(id)) {
      addMedia(id);
    }
  });

  return descriptors.length ? descriptors : undefined;
};
