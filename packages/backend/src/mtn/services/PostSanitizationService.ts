/**
 * PostSanitizationService
 *
 * Centralised input-sanitisation helpers for post creation and updates.
 * Extracted from posts.controller.ts so they can be reused across
 * controllers, queue workers, and migration scripts.
 */

import {
  PostAttachmentDescriptor,
  PostAttachmentType,
  Facet,
  validateFacets,
} from '@mention/shared-types';
import { config } from '../../config';

// ---- Constants (mirrors posts.controller) ----

const MAX_SOURCES = config.posts.maxSources;
const MAX_SOURCE_TITLE_LENGTH = config.posts.maxSourceTitleLength;
const MAX_ARTICLE_TITLE_LENGTH = config.posts.maxArticleTitleLength;
const MAX_ARTICLE_EXCERPT_LENGTH = config.posts.maxArticleExcerptLength;
const MAX_EVENT_NAME_LENGTH = config.posts.maxEventNameLength;
const MAX_EVENT_LOCATION_LENGTH = config.posts.maxEventLocationLength;
const MAX_EVENT_DESCRIPTION_LENGTH = config.posts.maxEventDescriptionLength;

// ---- Internal types ----

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

interface NormalizedMediaItem {
  id: string;
  type: 'image' | 'video' | 'gif';
  mime?: string;
}

interface AttachmentBuildOptions {
  rawAttachments?: unknown;
  media: NormalizedMediaItem[];
  includePoll?: boolean;
  includeArticle?: boolean;
  includeEvent?: boolean;
  includeRoom?: boolean;
  includeLocation?: boolean;
  includeSources?: boolean;
}

const ATTACHMENT_TYPES: PostAttachmentType[] = [
  'media', 'poll', 'article', 'event', 'room', 'space', 'location', 'sources',
];

// ---- Private helpers ----

function normalizeAttachmentInput(entry: RawAttachmentInput): PostAttachmentDescriptor | null {
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
}

// ---- Service class ----

export class PostSanitizationService {
  /**
   * Sanitize and validate a sources array.
   * Returns `{ sources, error }` — error is set when the array exceeds the max size.
   */
  static sanitizeSources(
    arr: unknown,
  ): { sources: Array<{ url: string; title?: string }>; error?: string } {
    if (!Array.isArray(arr)) return { sources: [] };

    if (arr.length > MAX_SOURCES) {
      return {
        sources: [],
        error: `Too many sources: maximum is ${MAX_SOURCES}, received ${arr.length}`,
      };
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
          const title =
            typeof titleRaw === 'string'
              ? titleRaw.trim().slice(0, MAX_SOURCE_TITLE_LENGTH)
              : undefined;
          return title ? { url: normalizedUrl, title } : { url: normalizedUrl };
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Array<{ url: string; title?: string }>;

    return { sources: normalized };
  }

  /**
   * Sanitize article input, returning undefined when the data is empty/invalid.
   */
  static sanitizeArticle(
    input: any,
  ): { title?: string; body?: string } | undefined {
    if (!input || typeof input !== 'object') return undefined;
    const title =
      typeof input.title === 'string'
        ? input.title.trim().slice(0, MAX_ARTICLE_TITLE_LENGTH)
        : undefined;
    const body = typeof input.body === 'string' ? input.body.trim() : undefined;
    if (!title && !body) return undefined;
    return { ...(title ? { title } : {}), ...(body ? { body } : {}) };
  }

  /**
   * Sanitize event data. Returns null when required fields (name, date) are missing.
   */
  static sanitizeEventData(
    eventData: any,
  ): {
    eventId?: string;
    name?: string;
    date?: string;
    location?: string;
    description?: string;
  } | null {
    if (!eventData || typeof eventData !== 'object') return null;

    const sanitized = {
      eventId:
        typeof eventData.eventId === 'string' ? eventData.eventId.trim() : undefined,
      name:
        typeof eventData.name === 'string'
          ? eventData.name.trim().slice(0, MAX_EVENT_NAME_LENGTH)
          : undefined,
      date:
        typeof eventData.date === 'string'
          ? eventData.date.trim()
          : eventData.date instanceof Date
            ? eventData.date.toISOString()
            : undefined,
      location:
        typeof eventData.location === 'string'
          ? eventData.location.trim().slice(0, MAX_EVENT_LOCATION_LENGTH)
          : undefined,
      description:
        typeof eventData.description === 'string'
          ? eventData.description.trim().slice(0, MAX_EVENT_DESCRIPTION_LENGTH)
          : undefined,
    };

    if (!sanitized.name || !sanitized.date) return null;

    try {
      const dateObj = new Date(sanitized.date);
      if (isNaN(dateObj.getTime())) return null;
    } catch {
      return null;
    }

    return sanitized;
  }

  /**
   * Sanitize room / space data. Returns null when required fields are missing.
   */
  static sanitizeRoomData(
    roomData: any,
  ): {
    roomId: string;
    title: string;
    status?: string;
    topic?: string;
    host?: string;
  } | null {
    if (!roomData || typeof roomData !== 'object') return null;
    const id = roomData.roomId ?? roomData.spaceId;
    if (typeof id !== 'string' || typeof roomData.title !== 'string') return null;

    return {
      roomId: id.trim(),
      title: roomData.title.trim().slice(0, 200),
      ...(typeof roomData.status === 'string' &&
      ['scheduled', 'live', 'ended'].includes(roomData.status)
        ? { status: roomData.status }
        : {}),
      ...(typeof roomData.topic === 'string'
        ? { topic: roomData.topic.trim().slice(0, 100) }
        : {}),
      ...(typeof roomData.host === 'string' ? { host: roomData.host.trim() } : {}),
    };
  }

  /**
   * Normalize a heterogeneous media array into a deduplicated list of
   * `{ id, type, mime? }` items.
   */
  static normalizeMediaItems(arr: any): NormalizedMediaItem[] {
    if (!Array.isArray(arr)) return [];

    const seen = new Set<string>();
    const normalized: NormalizedMediaItem[] = [];

    arr.forEach((item: any) => {
      if (!item) return;

      if (typeof item === 'string') {
        const id = item.trim();
        if (!id || seen.has(id)) return;
        seen.add(id);
        normalized.push({ id, type: 'image' });
        return;
      }

      if (typeof item === 'object') {
        const rawId = item.id || item.fileId || item._id || item.mediaId;
        if (!rawId) return;
        const id = String(rawId);
        if (!id || seen.has(id)) return;

        const rawType = (item.type || item.mediaType || '').toString().toLowerCase();
        const mimeValue = item.mime || item.contentType;
        const rawMime = mimeValue ? mimeValue.toString().toLowerCase() : '';

        let resolvedType: 'image' | 'video' | 'gif';
        if (rawType === 'video' || rawMime.startsWith('video/')) {
          resolvedType = 'video';
        } else if (rawType === 'gif' || rawMime.includes('gif')) {
          resolvedType = 'gif';
        } else {
          resolvedType = 'image';
        }

        seen.add(id);
        normalized.push({
          id,
          type: resolvedType,
          ...(mimeValue ? { mime: String(mimeValue) } : {}),
        });
      }
    });

    return normalized;
  }

  /**
   * Build an ordered attachments array from raw input, normalised media, and
   * boolean flags indicating which non-media attachment types are present.
   */
  static buildOrderedAttachments({
    rawAttachments,
    media,
    includePoll = false,
    includeArticle = false,
    includeEvent = false,
    includeRoom = false,
    includeLocation = false,
    includeSources = false,
  }: AttachmentBuildOptions): PostAttachmentDescriptor[] | undefined {
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
        mediaType: explicitType || mediaItem.type,
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
        case 'space':
          if (includeRoom) addNonMedia('room');
          break;
        case 'location':
          if (includeLocation) addNonMedia('location');
          break;
        case 'sources':
          if (includeSources) addNonMedia('sources');
          break;
        default:
          break;
      }
    };

    if (Array.isArray(rawAttachments)) {
      rawAttachments.forEach(processEntry);
    } else if (rawAttachments) {
      const rawObj = rawAttachments as Record<string, unknown>;
      const maybeOrder = rawObj.order || rawObj.attachments || rawObj.attachmentOrder;
      if (Array.isArray(maybeOrder)) {
        maybeOrder.forEach(processEntry);
      }
    }

    // Ensure all expected non-media types are present even when
    // the raw attachments didn't explicitly list them.
    if (includePoll) addNonMedia('poll');
    if (includeArticle) addNonMedia('article');
    if (includeEvent) addNonMedia('event');
    if (includeRoom) addNonMedia('room');
    if (includeSources) addNonMedia('sources');
    if (includeLocation) addNonMedia('location');

    // Append any remaining media items that weren't referenced in the order list.
    media.forEach((item) => {
      const id = String(item.id);
      if (!usedMedia.has(id)) {
        addMedia(id);
      }
    });

    return descriptors.length ? descriptors : undefined;
  }

  /**
   * Validate an array of rich-text facets against the post text.
   * Returns an array of human-readable error strings (empty = valid).
   */
  static validateFacets(facets: Facet[], textByteLength: number): string[] {
    return validateFacets(facets, textByteLength);
  }
}
