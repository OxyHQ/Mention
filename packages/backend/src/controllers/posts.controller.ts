import { Request, Response } from 'express';
import { Post, POST_CLASSIFICATION_PENDING } from '../models/Post';
import { baselineContentClassifier } from '../services/BaselineContentClassifier';
import Poll from '../models/Poll';
import Like from '../models/Like';
import Bookmark from '../models/Bookmark';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import mongoose from 'mongoose';
import { createNotification, createMentionNotifications, createBatchNotifications, createPostAuthorNotifications } from '../utils/notificationUtils';
import PostSubscription from '../models/PostSubscription';
import { PostVisibility, PostAttachmentDescriptor, PostAttachmentType, PostContent, PostUser } from '@mention/shared-types';
import { userPreferenceService, readInteractionSurface } from '../services/UserPreferenceService';
import { affinityEventService } from '../services/AffinityEventService';
import { postCreationService } from '../services/PostCreationService';
import ArticleModel, { IArticle } from '../models/Article';
import { logger } from '../utils/logger';
import { postHydrationService, resolveUserSummaries, degradedActorSummary } from '../services/PostHydrationService';
import { config } from '../config';
import { mergeHashtags, escapeRegex } from '../utils/textProcessing';
import { createScopedOxyClient } from '../utils/oxyHelpers';
import { queryInt, queryString } from '../utils/queryParams';
import { warmLinkPreviewForText } from '../utils/linkPreviewWarm';
import { aliaChat } from '../utils/alia';
import { validatePublicShareTarget } from '../utils/postAccessControl';
import { sanitizePodcast, resolvePodcastContent } from '../utils/syraPodcast';
import {
  emitPostCreated,
  emitLikeCreated,
  emitTombstone,
  emitBookmarkCreated,
  likeRecordUri,
  bookmarkRecordUri,
  postRecordUri,
} from '../services/mtn/MentionRecordEmitter';
import { postCollaborationService, CollabValidationError, CollabStateError } from '../services/PostCollaborationService';
import { resolveMcpAutoAcceptIds } from '../mcp/utils/resolveMcpAutoAcceptIds';

// Constants from centralized config
const MAX_SOURCES = config.posts.maxSources;
const MAX_SOURCE_TITLE_LENGTH = config.posts.maxSourceTitleLength;
const MAX_ARTICLE_TITLE_LENGTH = config.posts.maxArticleTitleLength;
const MAX_ARTICLE_EXCERPT_LENGTH = config.posts.maxArticleExcerptLength;
const DEFAULT_POLL_DURATION_DAYS = config.posts.defaultPollDurationDays;
const MAX_POLL_DURATION_DAYS = config.posts.maxPollDurationDays;
const MAX_HASHTAG_LENGTH = config.posts.maxHashtagLength;
const MAX_HASHTAGS_PER_POST = config.posts.maxHashtagsPerPost;
const MAX_EVENT_NAME_LENGTH = config.posts.maxEventNameLength;
const MAX_EVENT_LOCATION_LENGTH = config.posts.maxEventLocationLength;
const MAX_EVENT_DESCRIPTION_LENGTH = config.posts.maxEventDescriptionLength;
const DEFAULT_PAGE_SIZE = config.posts.defaultPageSize;
const MAX_PAGE_SIZE = config.posts.maxPageSize;
const DEFAULT_NEARBY_RADIUS_METERS = config.posts.defaultNearbyRadiusMeters;
const MAX_NEARBY_POSTS = config.posts.maxNearbyPosts;
const MAX_AREA_POSTS = config.posts.maxAreaPosts;
const DEFAULT_LIKES_LIMIT = config.posts.defaultLikesLimit;
const MAX_TEXT_LENGTH = config.posts.maxTextLength;
const MAX_ALT_TEXT_LENGTH = config.posts.maxAltTextLength;

/**
 * Page size for the engagement lists (`GET /posts/:id/likes` and `.../boosts`).
 * Both handlers read the page's last row by index (`rows[limit - 1]`), so the
 * limit has to be a bounded positive integer: an absent, zero, or negative limit
 * would index outside the page and throw on the missing document.
 */
const clampLikesLimit = (limit: number | undefined): number =>
  Math.min(Math.max(limit || DEFAULT_LIKES_LIMIT, 1), MAX_PAGE_SIZE);

/**
 * Resolve the canonical Oxy {@link PostUser} for an engagement-list entry
 * (`GET /posts/:id/likes` and `GET /posts/:id/boosts`). Oxy owns identity, so the
 * response embeds the raw Oxy user (same shape as `post.user` / Who-to-follow):
 * `name.displayName`, `avatar` file id, `username`, `verified`, `isFederated`,
 * `federation`. When the resolver could not resolve a user, fall back to the
 * degraded user (neutral name, EMPTY username) — never the raw id as a handle,
 * which would render a ghost `@<oxyUserId>` and a broken profile link.
 */
const mapActorSummary = (
  userId: string,
  user: PostUser | undefined,
): PostUser => user ?? degradedActorSummary(userId);

const buildPostMetadata = (metadata: unknown): Record<string, unknown> => {
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
const sanitizeSources = (arr: unknown): { sources: Array<{ url: string; title?: string }>; error?: string } => {
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

const sanitizeArticle = (input: unknown): { title?: string; body?: string } | undefined => {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const title = typeof obj.title === 'string' ? obj.title.trim().slice(0, MAX_ARTICLE_TITLE_LENGTH) : undefined;
  const body = typeof obj.body === 'string' ? obj.body.trim() : undefined;
  if (!title && !body) return undefined;
  return { ...(title ? { title } : {}), ...(body ? { body } : {}) };
};

const sanitizeEventData = (eventData: unknown): { eventId?: string; name?: string; date?: string; location?: string; description?: string } | null => {
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

const sanitizeRoomData = (roomData: unknown): { roomId: string; title: string; status?: string; topic?: string; host?: string } | null => {
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

interface NormalizedMediaItem {
  id: string;
  type: 'image' | 'video' | 'gif';
  mime?: string;
  /** Accessibility description (alt text) for the image; trimmed + length-capped. */
  alt?: string;
}

/** Untrusted media entry shape accepted from the request body before normalization. */
interface RawMediaInput {
  id?: unknown;
  fileId?: unknown;
  _id?: unknown;
  mediaId?: unknown;
  type?: unknown;
  mediaType?: unknown;
  mime?: unknown;
  contentType?: unknown;
  alt?: unknown;
}

const normalizeMediaItems = (arr: unknown): NormalizedMediaItem[] => {
  if (!Array.isArray(arr)) return [];

  const seen = new Set<string>();
  const normalized: NormalizedMediaItem[] = [];

  arr.forEach((item: unknown) => {
    if (!item) return;

    if (typeof item === 'string') {
      const id = item.trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      normalized.push({ id, type: 'image' });
      return;
    }

    if (typeof item === 'object') {
      const obj = item as RawMediaInput;
      const rawId = obj.id || obj.fileId || obj._id || obj.mediaId;
      if (!rawId) return;
      const id = String(rawId);
      if (!id || seen.has(id)) return;

      const rawType = (obj.type || obj.mediaType || '').toString().toLowerCase();
      const mimeValue = obj.mime || obj.contentType;
      const rawMime = mimeValue ? mimeValue.toString().toLowerCase() : '';

      let resolvedType: 'image' | 'video' | 'gif';
      if (rawType === 'video' || rawMime.startsWith('video/')) {
        resolvedType = 'video';
      } else if (rawType === 'gif' || rawMime.includes('gif')) {
        resolvedType = 'gif';
      } else {
        resolvedType = 'image';
      }

      // Accessibility description (alt text). Explicitly whitelisted, trimmed, and
      // length-capped — never spread from the raw body. Empty/whitespace-only
      // values are dropped so the field stays absent rather than an empty string.
      const altRaw = typeof obj.alt === 'string' ? obj.alt.trim().slice(0, MAX_ALT_TEXT_LENGTH) : '';

      seen.add(id);
      normalized.push({
        id,
        type: resolvedType,
        ...(mimeValue ? { mime: String(mimeValue) } : {}),
        ...(altRaw ? { alt: altRaw } : {})
      });
    }
  });

  return normalized;
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

const buildOrderedAttachments = ({
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

// Create a new post
export const createPost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { content, hashtags, mentions, quoted_post_id, boost_of, in_reply_to_status_id, parentPostId, threadId, contentLocation, postLocation, replyPermission, reviewReplies, quotesDisabled, status: incomingStatus, scheduledFor, collaboratorIds, collaboratorHandles } = req.body;

    // Support both new content structure and legacy text/media structure
    const text = content?.text || req.body.text;
    const media = content?.media || content?.images || req.body.media; // Support both new media field and legacy images
    const video = content?.video;
    const poll = content?.poll;
    const contentLocationData = content?.location || contentLocation;


    // Validate text length
    if (text && typeof text === 'string' && text.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({ message: `Post text exceeds maximum length of ${MAX_TEXT_LENGTH} characters` });
    }

    // Validate hashtags
    if (Array.isArray(hashtags)) {
      if (hashtags.length > MAX_HASHTAGS_PER_POST) {
        return res.status(400).json({ message: `Too many hashtags: maximum is ${MAX_HASHTAGS_PER_POST}` });
      }
      const invalidTag = hashtags.find((tag: unknown) =>
        typeof tag !== 'string' || tag.length > MAX_HASHTAG_LENGTH
      );
      if (invalidTag !== undefined) {
        return res.status(400).json({ message: `Invalid hashtag: each must be a string of at most ${MAX_HASHTAG_LENGTH} characters` });
      }
    }

    // Extract and merge hashtags from text with user-provided ones
    const uniqueTags = mergeHashtags(text || '', hashtags);

    // Process content location data (user's shared location)
    let processedContentLocation = null;
    if (contentLocationData) {
      let longitude, latitude, address;
      
      // Handle GeoJSON format: { type: 'Point', coordinates: [lng, lat], address?: string }
      if (contentLocationData.type === 'Point' && Array.isArray(contentLocationData.coordinates) && contentLocationData.coordinates.length === 2) {
        longitude = contentLocationData.coordinates[0];
        latitude = contentLocationData.coordinates[1];
        address = contentLocationData.address;
      }
      // Handle legacy format: { latitude: number, longitude: number, address?: string }
      else if (typeof contentLocationData.latitude === 'number' && typeof contentLocationData.longitude === 'number') {
        longitude = contentLocationData.longitude;
        latitude = contentLocationData.latitude;
        address = contentLocationData.address;
      }
      
      // Validate coordinates
      if (typeof longitude === 'number' && typeof latitude === 'number' &&
          latitude >= -90 && latitude <= 90 &&
          longitude >= -180 && longitude <= 180) {
        processedContentLocation = {
          type: 'Point' as const,
          coordinates: [longitude, latitude] as [number, number],
          address: address || undefined
        };
      } else {
        return res.status(400).json({ 
          error: 'Invalid location coordinates. Latitude must be between -90 and 90, longitude between -180 and 180.' 
        });
      }
    }

    // Process post location data (creation location metadata)
    let processedPostLocation = null;
    if (postLocation) {
      let longitude, latitude, address;
      
      // Handle GeoJSON format: { type: 'Point', coordinates: [lng, lat], address?: string }
      if (postLocation.type === 'Point' && Array.isArray(postLocation.coordinates) && postLocation.coordinates.length === 2) {
        longitude = postLocation.coordinates[0];
        latitude = postLocation.coordinates[1];
        address = postLocation.address;
      }
      // Handle legacy format: { latitude: number, longitude: number, address?: string }
      else if (typeof postLocation.latitude === 'number' && typeof postLocation.longitude === 'number') {
        longitude = postLocation.longitude;
        latitude = postLocation.latitude;
        address = postLocation.address;
        logger.debug('Received legacy format post location');
      }
      
      // Validate coordinates
      if (typeof longitude === 'number' && typeof latitude === 'number' &&
          latitude >= -90 && latitude <= 90 &&
          longitude >= -180 && longitude <= 180) {
        processedPostLocation = {
          type: 'Point' as const,
          coordinates: [longitude, latitude] as [number, number],
          address: address || undefined
        };
      } else {
        return res.status(400).json({ 
          error: 'Invalid post location coordinates. Latitude must be between -90 and 90, longitude between -180 and 180.' 
        });
      }
    }

    const normalizedMedia = normalizeMediaItems(media);

    // Build complete content object
    const postContent: PostContent = {
      text: text || '',
      media: normalizedMedia
    };

    // Add video to media array if provided
    if (video) {
      if (!postContent.media) postContent.media = [];
      postContent.media.push({ id: video, type: 'video' });
    }

    // Create poll separately if provided and add pollId to content
    let pollId = null;
    if (poll) {
      // Validate poll endTime is in the future and within max duration
      if (poll.endTime) {
        const endTimeMs = new Date(poll.endTime).getTime();
        if (isNaN(endTimeMs)) {
          return res.status(400).json({ message: 'Invalid poll end time' });
        }
        if (endTimeMs <= Date.now()) {
          return res.status(400).json({ message: 'Poll end time must be in the future' });
        }
        const maxEndTimeMs = Date.now() + MAX_POLL_DURATION_DAYS * 24 * 60 * 60 * 1000;
        if (endTimeMs > maxEndTimeMs) {
          return res.status(400).json({ message: `Poll duration cannot exceed ${MAX_POLL_DURATION_DAYS} days` });
        }
      }

      try {
        const pollDoc = new Poll({
          question: poll.question,
          options: poll.options.map((option: string) => ({ text: option, votes: [] })),
          postId: 'temp_' + Date.now(), // Temporary ID, will be updated after post creation
          createdBy: userId,
          endsAt: new Date(poll.endTime || Date.now() + DEFAULT_POLL_DURATION_DAYS * 24 * 60 * 60 * 1000),
          isMultipleChoice: poll.isMultipleChoice || false,
          isAnonymous: poll.isAnonymous || false
        });
        
        const savedPoll = await pollDoc.save();
        pollId = String(savedPoll._id);
        postContent.pollId = pollId;
        
      } catch (pollError) {
        logger.error('Failed to create poll', pollError);
        return res.status(400).json({ message: 'Failed to create poll' });
      }
    }

    // Add location if provided
    if (processedContentLocation) {
      postContent.location = processedContentLocation;
    }

    const { sources, error: sourcesError } = sanitizeSources(content?.sources || req.body.sources);
    if (sourcesError) {
      return res.status(400).json({ message: sourcesError });
    }
    if (sources.length) {
      postContent.sources = sources;
    }

    const sanitizedArticle = sanitizeArticle(content?.article || req.body.article);
    let pendingArticleDoc: IArticle | null = null;
    if (sanitizedArticle) {
      pendingArticleDoc = new ArticleModel({
        createdBy: userId,
        title: sanitizedArticle.title || undefined,
        body: sanitizedArticle.body || undefined,
      });
      postContent.article = {
        articleId: pendingArticleDoc._id.toString(),
        title: sanitizedArticle.title,
        excerpt: sanitizedArticle.body ? sanitizedArticle.body.slice(0, MAX_ARTICLE_EXCERPT_LENGTH) : undefined,
      };
    }

    // Handle event data
    const eventData = content?.event || req.body.event;
    const sanitizedEvent = sanitizeEventData(eventData);
    if (sanitizedEvent && sanitizedEvent.name && sanitizedEvent.date) {
      postContent.event = sanitizedEvent as import('@mention/shared-types').PostEventContent;
    }

    // Handle room data
    const roomData = content?.room || req.body.room;
    const sanitizedRoom = sanitizeRoomData(roomData);
    if (sanitizedRoom) {
      postContent.room = sanitizedRoom as import('@mention/shared-types').PostRoomContent;
    }

    // Handle podcast data: a single Syra podcast show attached to the post. The
    // client only sends an untrusted `{ syraPodcastId }` reference; the canonical
    // title/author/artwork and show URL are resolved + denormalized server-side
    // from the Syra catalog via @syra.fm/sdk — never trusted from the client.
    const sanitizedPodcast = sanitizePodcast(content?.podcast || req.body.podcast);
    if (sanitizedPodcast) {
      try {
        postContent.podcast = await resolvePodcastContent(sanitizedPodcast.syraPodcastId);
      } catch (podcastError) {
        logger.warn('Failed to resolve Syra podcast for post', { userId, syraPodcastId: sanitizedPodcast.syraPodcastId, error: podcastError });
        return res.status(400).json({ message: 'Unable to resolve the selected podcast' });
      }
    }

    const attachmentsInput = content?.attachments || content?.attachmentOrder || req.body.attachments || req.body.attachmentOrder;
    const computedAttachments = buildOrderedAttachments({
      rawAttachments: attachmentsInput || postContent.attachments,
      media: Array.isArray(postContent.media) ? postContent.media : [],
      includePoll: Boolean(postContent.pollId),
      includeArticle: Boolean(postContent.article),
      includeEvent: Boolean(postContent.event),
      includeRoom: Boolean(postContent.room),
      includeLocation: Boolean(postContent.location),
      includeSources: Boolean(postContent.sources && postContent.sources.length),
      includePodcast: Boolean(postContent.podcast)
    });

    if (computedAttachments) {
      postContent.attachments = computedAttachments;
    } else {
      delete postContent.attachments;
    }

    let postStatus: 'draft' | 'published' | 'scheduled' = 'published';
    let scheduledForDate: Date | null = null;

    if (scheduledFor) {
      const parsed = new Date(scheduledFor);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ message: 'Invalid scheduled time' });
      }
      if (parsed.getTime() <= Date.now()) {
        return res.status(400).json({ message: 'Scheduled time must be in the future' });
      }
      postStatus = 'scheduled';
      scheduledForDate = parsed;
    } else if (incomingStatus === 'draft') {
      postStatus = 'draft';
    } else if (incomingStatus === 'scheduled') {
      return res.status(400).json({ message: 'scheduledFor is required when scheduling a post' });
    }

    const isScheduled = postStatus === 'scheduled';

    const postMetadata = buildPostMetadata(req.body.metadata);

    if (quoted_post_id) {
      const quotedPost = await Post.findById(quoted_post_id).maxTimeMS(5000).lean();
      const quoteValidation = validatePublicShareTarget(quotedPost, { action: 'quote' });
      if (!quoteValidation.ok) {
        return res.status(quoteValidation.status).json({ message: quoteValidation.message });
      }
    }

    if (boost_of) {
      const boostedPost = await Post.findById(boost_of).maxTimeMS(5000).lean();
      const boostValidation = validatePublicShareTarget(boostedPost, { action: 'boost' });
      if (!boostValidation.ok) {
        return res.status(boostValidation.status).json({ message: boostValidation.message });
      }
    }

    const rawVisibility = typeof req.body.visibility === 'string' ? req.body.visibility : undefined;
    let resolvedVisibility = PostVisibility.PUBLIC;
    if (rawVisibility === 'followers' || rawVisibility === 'followers_only') {
      resolvedVisibility = PostVisibility.FOLLOWERS_ONLY;
    } else if (rawVisibility === 'private') {
      resolvedVisibility = PostVisibility.PRIVATE;
    } else if (rawVisibility === 'public') {
      resolvedVisibility = PostVisibility.PUBLIC;
    }

    const invitedCollaboratorIds = await postCollaborationService.resolveCollaboratorRefs(
      userId,
      Array.isArray(collaboratorIds) ? collaboratorIds : undefined,
      Array.isArray(collaboratorHandles) ? collaboratorHandles : undefined,
    );
    const autoAcceptCollaboratorIds = await resolveMcpAutoAcceptIds(req, invitedCollaboratorIds);

    const post = await postCreationService.create({
      oxyUserId: userId,
      content: postContent,
      location: processedPostLocation,
      hashtags: uniqueTags,
      mentions: mentions || [],
      collaboratorIds: invitedCollaboratorIds,
      autoAcceptCollaboratorIds,
      quoteOf: quoted_post_id || null,
      boostOf: boost_of || null,
      parentPostId: parentPostId || in_reply_to_status_id || null,
      threadId: threadId || null,
      visibility: resolvedVisibility,
      replyPermission: replyPermission || ['anyone'],
      reviewReplies: reviewReplies || false,
      quotesDisabled: quotesDisabled || false,
      status: postStatus,
      scheduledFor: scheduledForDate || undefined,
      metadata: postMetadata,
      senderUsername: req.user?.username,
    });

    if (pendingArticleDoc) {
      try {
        pendingArticleDoc.postId = String(post._id);
        await pendingArticleDoc.save();
      } catch (articleError) {
        logger.error('Failed to save article content', articleError);
      }
    }

    if (!isScheduled && pollId) {
      try {
        await Poll.findByIdAndUpdate(pollId, { postId: String(post._id) });
      } catch (pollUpdateError) {
        logger.error('Failed to update poll postId', pollUpdateError);
      }
    }

    // Affinity graph: a quote / reply created via POST /posts expresses affinity
    // from the author toward the quoted / replied-to post's author. Fire-and-
    // forget — buffering must never block or fail post creation. Only published
    // (non-draft/non-scheduled) posts emit; a quote and a reply are independent
    // (a post can be both). Resolve the target author with a lean lookup.
    if (postStatus === 'published') {
      const parentIdForAffinity = parentPostId || in_reply_to_status_id;
      const affinityTargets: Array<{ targetPostId: string; type: 'quote' | 'reply' }> = [];
      if (quoted_post_id) affinityTargets.push({ targetPostId: String(quoted_post_id), type: 'quote' });
      if (parentIdForAffinity) affinityTargets.push({ targetPostId: String(parentIdForAffinity), type: 'reply' });

      for (const { targetPostId, type } of affinityTargets) {
        void (async () => {
          const target = await Post.findById(targetPostId).select('oxyUserId').lean();
          const targetAuthorId = target?.oxyUserId?.toString?.();
          if (!targetAuthorId) return;
          await affinityEventService.record({
            fromUserId: userId,
            toUserId: targetAuthorId,
            type,
            eventId: `${type}:${String(post._id)}`,
          });
        })().catch(() => undefined);
      }
    }

    await warmLinkPreviewForText(post.content?.text);

    const [hydratedPost] = await postHydrationService.hydratePosts([post.toObject()], {
      viewerId: userId,
      oxyClient: createScopedOxyClient(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });

    if (!hydratedPost) {
      return res.status(500).json({ message: 'Post created but could not be hydrated' });
    }

    res.status(201).json({ success: true, post: hydratedPost });
  } catch (error) {
    if (error instanceof CollabValidationError) {
      return res.status(400).json({ message: error.message });
    }
    logger.error('Error creating post', error);
    res.status(500).json({ message: 'Error creating post' });
  }
};

// Accept a collaboration invite
export const acceptCollabInvite = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const post = await postCollaborationService.accept(String(req.params.id), userId);
    const [hydratedPost] = await postHydrationService.hydratePosts([post.toObject()], {
      viewerId: userId,
      oxyClient: createScopedOxyClient(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });
    return res.status(200).json({ success: true, post: hydratedPost ?? null });
  } catch (error) {
    if (error instanceof CollabStateError) {
      return res.status(400).json({ message: error.message });
    }
    logger.error('Error accepting collab invite', error);
    return res.status(500).json({ message: 'Error accepting collaboration invite' });
  }
};

export const declineCollabInvite = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    await postCollaborationService.decline(String(req.params.id), userId);
    return res.status(200).json({ success: true });
  } catch (error) {
    if (error instanceof CollabStateError) {
      return res.status(400).json({ message: error.message });
    }
    logger.error('Error declining collab invite', error);
    return res.status(500).json({ message: 'Error declining collaboration invite' });
  }
};

export const stopCollabSharing = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const post = await postCollaborationService.stopSharing(String(req.params.id), userId);
    const [hydratedPost] = await postHydrationService.hydratePosts([post.toObject()], {
      viewerId: userId,
      oxyClient: createScopedOxyClient(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });
    return res.status(200).json({ success: true, post: hydratedPost ?? null });
  } catch (error) {
    if (error instanceof CollabStateError) {
      return res.status(400).json({ message: error.message });
    }
    logger.error('Error stopping collab sharing', error);
    return res.status(500).json({ message: 'Error stopping collaboration sharing' });
  }
};

// Create a thread of posts
export const createThread = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (req.body.status || req.body.scheduledFor) {
      return res.status(400).json({ message: 'Scheduling threads is not supported yet' });
    }

    // Collaborative authorship is a single-post feature; a thread has no single
    // owner/collaborator surface, so reject any collaborator invites up front
    // (both the top-level field and any per-post field) rather than silently
    // dropping them.
    const threadHasCollaborators =
      (Array.isArray(req.body.collaboratorIds) && req.body.collaboratorIds.length > 0) ||
      (Array.isArray(req.body.posts) &&
        req.body.posts.some(
          (p: { collaboratorIds?: unknown }) =>
            Array.isArray(p?.collaboratorIds) && p.collaboratorIds.length > 0,
        ));
    if (threadHasCollaborators) {
      return res.status(400).json({ message: 'Collaborators are not supported on threads' });
    }

    logger.debug('Creating thread with body', JSON.stringify(req.body, null, 2));

    const { mode, posts } = req.body;

    if (!Array.isArray(posts) || posts.length === 0) {
      return res.status(400).json({ message: 'Posts array is required and cannot be empty' });
    }

    const createdPostObjects: Array<{ content?: { text?: string } }> = [];
    let mainPostId: string | null = null;
    let previousPostId: string | null = null;

    for (let i = 0; i < posts.length; i++) {
      const postData = posts[i];
      const { content, hashtags, mentions, visibility, replyPermission, reviewReplies, quotesDisabled, metadata } = postData;

      // Process content location data
      let processedContentLocation = null;
      if (content?.location) {
        const locationData = content.location;
        let longitude, latitude, address;
        
        if (locationData.type === 'Point' && Array.isArray(locationData.coordinates)) {
          longitude = locationData.coordinates[0];
          latitude = locationData.coordinates[1];
          address = locationData.address;
        }
        
        if (typeof longitude === 'number' && typeof latitude === 'number' &&
            latitude >= -90 && latitude <= 90 &&
            longitude >= -180 && longitude <= 180) {
          processedContentLocation = {
            type: 'Point' as const,
            coordinates: [longitude, latitude] as [number, number],
            address: address || undefined
          };
        }
      }

      // Build post content
      const postContent: PostContent = {
        text: content?.text || '',
        media: normalizeMediaItems(content?.media)
      };

      if (processedContentLocation) {
        postContent.location = processedContentLocation;
      }

      const { sources } = sanitizeSources(content?.sources);
      if (sources.length) {
        postContent.sources = sources;
      }

      let pendingArticleDoc: IArticle | null = null;
      if (i === 0) {
        const sanitizedArticle = sanitizeArticle(content?.article);
        if (sanitizedArticle) {
          pendingArticleDoc = new ArticleModel({
            createdBy: userId,
            title: sanitizedArticle.title || undefined,
            body: sanitizedArticle.body || undefined,
          });
          postContent.article = {
            articleId: pendingArticleDoc._id.toString(),
            title: sanitizedArticle.title,
            excerpt: sanitizedArticle.body ? sanitizedArticle.body.slice(0, MAX_ARTICLE_EXCERPT_LENGTH) : undefined,
          };
        }
      }

      // Handle event data
      const threadSanitizedEvent = sanitizeEventData(content?.event);
      if (threadSanitizedEvent && threadSanitizedEvent.name && threadSanitizedEvent.date) {
        postContent.event = threadSanitizedEvent as import('@mention/shared-types').PostEventContent;
      }

      // Handle room data
      const threadSanitizedRoom = sanitizeRoomData(content?.room);
      if (threadSanitizedRoom) {
        postContent.room = threadSanitizedRoom as import('@mention/shared-types').PostRoomContent;
      }

      // Handle podcast data: verify + denormalize the Syra show server-side (as
      // in createPost). The thread path is best-effort and never aborts the loop
      // mid-creation, so an unresolvable show is dropped (logged) rather than
      // 400'd — matching how the article/event/room attachments behave here.
      const threadSanitizedPodcast = sanitizePodcast(content?.podcast);
      if (threadSanitizedPodcast) {
        try {
          postContent.podcast = await resolvePodcastContent(threadSanitizedPodcast.syraPodcastId);
        } catch (podcastError) {
          logger.warn('Failed to resolve Syra podcast for thread post; dropping', { userId, syraPodcastId: threadSanitizedPodcast.syraPodcastId, error: podcastError });
        }
      }

      // Handle poll creation
      let pollId = null;
      if (content?.poll) {
        const poll = content.poll;
        const newPoll = new Poll({
          question: poll.question || 'Poll',
          options: poll.options || [],
          endTime: poll.endTime || new Date(Date.now() + DEFAULT_POLL_DURATION_DAYS * 24 * 60 * 60 * 1000).toISOString(),
          votes: poll.votes || {},
          userVotes: poll.userVotes || {},
          createdBy: userId
        });
        await newPoll.save();
        pollId = String(newPoll._id);
        postContent.pollId = pollId;
      }

      // Extract and merge hashtags from text with user-provided ones
      const text = content?.text || '';
      const uniqueTags = mergeHashtags(text, hashtags);

      // Create post
      const attachmentsInput = content?.attachments || content?.attachmentOrder || postData.attachments || postData.attachmentOrder;
      const computedAttachments = buildOrderedAttachments({
        rawAttachments: attachmentsInput || postContent.attachments,
        media: Array.isArray(postContent.media) ? postContent.media : [],
        includePoll: Boolean(postContent.pollId),
        includeArticle: Boolean(postContent.article),
        includeEvent: Boolean(postContent.event),
        includeRoom: Boolean(postContent.room),
        includeLocation: Boolean(postContent.location),
        includeSources: Boolean(postContent.sources && postContent.sources.length),
        includePodcast: Boolean(postContent.podcast)
      });

      if (computedAttachments) {
        postContent.attachments = computedAttachments;
      } else {
        delete postContent.attachments;
      }

      // Route every thread post through PostCreationService so Stage-A
      // classification AND the MTN dual-write (signed `app.mention.feed.post`
      // record per thread post, with reply.root/reply.parent for continuations)
      // live in ONE place. The thread keeps its own per-post mention
      // notifications and its own single main-post socket emit below, so we
      // suppress PCS's notification/socket/federation stages to preserve the
      // EXACT pre-existing side-effect behavior (the response is byte-identical).
      const isThreadContinuation = mode === 'thread' && i > 0 && Boolean(previousPostId);
      const post = await postCreationService.create({
        oxyUserId: userId,
        content: postContent,
        hashtags: uniqueTags,
        mentions: mentions || [],
        visibility: (visibility as PostVisibility) || PostVisibility.PUBLIC,
        replyPermission: replyPermission || ['anyone'],
        reviewReplies: reviewReplies || false,
        quotesDisabled: quotesDisabled || false,
        metadata: buildPostMetadata(metadata),
        // For thread mode: chain each continuation post to the immediately
        // previous post (sequential thread), with a shared threadId root.
        // For beast mode: all posts are independent.
        ...(isThreadContinuation ? { parentPostId: previousPostId, threadId: mainPostId } : {}),
        skipNotifications: true,
        skipSocketEmit: true,
        skipFederationDelivery: true,
      });

      // Thread mode: the ROOT post (i === 0) anchors the thread on its OWN _id so
      // the whole self-thread — root included — shares one threadId. This is what
      // lets ThreadSlicingService recognise the root (threadId set, no
      // parentPostId) and pull its same-author continuations into a single
      // connected slice; without it the root never matches and the thread renders
      // as loose posts. The id is only available after creation, so anchor it with
      // a follow-up update. (This native self-thread marker is NOT part of the MTN
      // post record — the root's signed record is correctly a top-level post.)
      if (mode === 'thread' && i === 0 && posts.length > 1) {
        post.threadId = String(post._id);
        await post.save();
      }

      if (pendingArticleDoc) {
        try {
          pendingArticleDoc.postId = String(post._id);
          await pendingArticleDoc.save();
        } catch (articleError) {
          logger.error('Failed to save article content (thread)', articleError);
        }
      }

      // Mentions per post in thread
      try {
        if (mentions && mentions.length > 0) {
          await createMentionNotifications(
            mentions,
            post._id.toString(),
            userId,
            'post'
          );
        }
      } catch (e) {
        logger.error('Failed to create mention notifications (thread)', e);
      }

      // Update poll's postId
      if (pollId) {
        await Poll.findByIdAndUpdate(pollId, { postId: String(post._id) });
      }

      // Store the first post ID as the main post for thread linking
      if (i === 0) {
        mainPostId = String(post._id);
      }

      // Track the latest post so the next iteration chains onto it
      previousPostId = String(post._id);

      createdPostObjects.push(post.toObject());
    }

    await Promise.all(createdPostObjects.map((p) => warmLinkPreviewForText(p.content?.text)));

    const createdPosts = await postHydrationService.hydratePosts(createdPostObjects, {
      viewerId: userId,
      oxyClient: createScopedOxyClient(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });

    logger.info(`Created ${createdPosts.length} posts in ${mode} mode`);

    // Emit real-time feed update for new thread posts
    try {
      const io = global.io;
      if (io && createdPosts.length > 0) {
        // Emit the first post (main post) to feeds
        const mainPost = createdPosts[0];
        io.emit('feed:updated', {
          type: 'for_you',
          post: mainPost,
          timestamp: new Date().toISOString()
        });
        io.emit('feed:updated', {
          type: 'following',
          post: mainPost,
          authorId: userId,
          timestamp: new Date().toISOString()
        });
      }
    } catch (socketError) {
      logger.warn('Failed to emit socket event for new thread', socketError);
    }

    res.status(201).json({ success: true, posts: createdPosts });
  } catch (error) {
    logger.error('Error creating thread', error);
    res.status(500).json({ message: 'Error creating thread' });
  }
};

// Get all posts
export const getPosts = async (req: AuthRequest, res: Response) => {
  try {
    const page = queryInt(req.query.page) || 1;
    const limit = Math.min(queryInt(req.query.limit) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const currentUserId = req.user?.id;

    const posts = await Post.find({ visibility: 'public', status: 'published' })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const hydratedPosts = await postHydrationService.hydratePosts(posts, {
      viewerId: currentUserId,
      oxyClient: createScopedOxyClient(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });

    res.json({
      posts: hydratedPosts,
      hasMore: posts.length === limit,
      page,
      limit
    });
  } catch (error) {
    logger.error('Error fetching posts', error);
    res.status(500).json({ message: 'Error fetching posts' });
  }
};

// Get post by ID
export const getPostById = async (req: AuthRequest, res: Response) => {
  try {
    const currentUserId = req.user?.id;
    const post = await Post.findById(req.params.id)
      .lean();

    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    const hydrated = await postHydrationService.hydratePosts([post], {
      viewerId: currentUserId,
      oxyClient: createScopedOxyClient(req),
      maxDepth: 2,
      includeLinkMetadata: true,
    });

    const hydratedPost = hydrated[0];
    if (!hydratedPost) {
      return res.status(404).json({ message: 'Post not available' });
    }

    res.json(hydratedPost);
  } catch (error) {
    logger.error('Error fetching post', error);
    res.status(500).json({ message: 'Error fetching post' });
  }
};

// Update post
export const updatePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const post = await Post.findOne({ _id: req.params.id, oxyUserId: userId });
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Enforce 30-minute edit window
    const EDIT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
    const createdAt = new Date(post.createdAt).getTime();
    if (Date.now() - createdAt > EDIT_WINDOW_MS) {
      return res.status(403).json({ message: 'Edit window has expired. Posts can only be edited within 30 minutes of creation.' });
    }

    // Support both flat body fields and nested content object from frontend
    const contentObj = req.body.content;
    const text = contentObj?.text ?? req.body.text;
    const media = contentObj?.media ?? req.body.media;
    const { hashtags, mentions, contentLocation, postLocation, sources } = req.body;

    // Save old text to edit history before modifying
    if (text !== undefined && post.content.text !== text) {
      if (!post.editHistory) {
        post.editHistory = [];
      }
      if (post.content.text) {
        post.editHistory.push(post.content.text);
      }
      post.isEdited = true;
    }

    if (text !== undefined) {
      post.content.text = text;
      // Re-extract hashtags when text changes
      post.hashtags = mergeHashtags(text || '', hashtags || post.hashtags);
      // Re-classify the post for its new text. The deterministic Stage-A
      // classifier is pure/synchronous, so it refreshes the canonical
      // `postClassification.topics` slug list (plus language/region/scores/
      // sensitive) inline; stale Stage-B `topicRefs` from the old text are
      // cleared and `status` is reset to `pending` so the AI batch re-refines
      // this post on its next cycle (a no-op when the AI batch is disabled —
      // the refreshed Stage-A slugs remain the canonical list).
      const signals = baselineContentClassifier.classify({
        text: post.content.text,
        hashtags: post.hashtags,
        language: post.language,
        sensitive: post.federation?.sensitive ?? post.metadata?.isSensitive,
        isFederated: post.federation != null,
      });
      // Replace the whole subdoc: a fresh Stage-A baseline with status reset to
      // `pending`. Omitted paths (`topicRefs`, `attempts`, the Stage-B AI fields)
      // fall back to their schema defaults on cast — clearing stale AI topicRefs
      // and resetting the retry counter — so the AI batch reprocesses cleanly.
      // The subdoc carries ONLY the multi-language `languages` array; the primary
      // (`languages[0]`) is written to the top-level AP `post.language`.
      post.postClassification = {
        status: POST_CLASSIFICATION_PENDING,
        topics: signals.topics,
        languages: signals.languages,
        region: signals.region,
        hashtagsNorm: signals.hashtagsNorm,
        sensitive: signals.sensitive,
        scores: signals.scores,
        version: signals.version,
        classifiedAt: new Date(signals.classifiedAt),
      };
      const primaryLanguage = signals.languages[0];
      if (primaryLanguage != null) {
        post.language = primaryLanguage;
      }
      post.markModified('postClassification');
    }
    if (media !== undefined) {
      const normalizedMedia = normalizeMediaItems(media);
      post.content.media = normalizedMedia;
      post.markModified('content.media');
    }

    // Handle content location updates (user's shared location)
    if (contentLocation !== undefined) {
      if (contentLocation === null) {
        // Remove content location
        post.content.location = undefined;
      } else if (contentLocation.latitude !== undefined && contentLocation.longitude !== undefined) {
        // Update content location
        post.content.location = {
          type: 'Point',
          coordinates: [contentLocation.longitude, contentLocation.latitude], // GeoJSON format: [lng, lat]
          address: contentLocation.address || undefined
        };
      }
    }

    // Handle post location updates (creation location metadata)
    if (postLocation !== undefined) {
      if (postLocation === null) {
        // Remove post location
        post.location = undefined;
      } else if (postLocation.latitude !== undefined && postLocation.longitude !== undefined) {
        // Update post location
        post.location = {
          type: 'Point',
          coordinates: [postLocation.longitude, postLocation.latitude], // GeoJSON format: [lng, lat]
          address: postLocation.address || undefined
        };
      }
    }

    if (sources !== undefined) {
      const { sources: sanitized, error: sourcesErr } = sanitizeSources(sources);
      if (sourcesErr) {
        return res.status(400).json({ message: sourcesErr });
      }
      if (sanitized.length) {
        post.content.sources = sanitized;
      } else {
        post.content.sources = undefined;
      }
    }

    if (req.body.article !== undefined) {
      const sanitizedArticle = sanitizeArticle(req.body.article);
      const existingArticleId = post.content?.article?.articleId;
      if (sanitizedArticle) {
        let articleDoc: IArticle | null = existingArticleId ? await ArticleModel.findOne({ _id: existingArticleId }).exec() : null;
        const previousArticle = post.content?.article || {};

        if (articleDoc) {
          if (sanitizedArticle.title !== undefined) {
            articleDoc.title = sanitizedArticle.title || undefined;
          }
          if (sanitizedArticle.body !== undefined) {
            articleDoc.body = sanitizedArticle.body || undefined;
          }
          articleDoc.postId = String(post._id);
        } else {
          articleDoc = new ArticleModel({
            createdBy: userId,
            postId: String(post._id),
            title: sanitizedArticle.title || undefined,
            body: sanitizedArticle.body || undefined,
          });
        }
        await articleDoc.save();
        post.content.article = {
          articleId: articleDoc._id.toString(),
          title: sanitizedArticle.title !== undefined ? sanitizedArticle.title : previousArticle.title,
          excerpt: sanitizedArticle.body !== undefined
            ? (sanitizedArticle.body ? sanitizedArticle.body.slice(0, 280) : undefined)
            : previousArticle.excerpt,
        };
      } else {
        if (existingArticleId) {
          await ArticleModel.deleteOne({ _id: existingArticleId }).exec();
        }
        post.content.article = undefined;
      }
    }
    const attachmentUpdateInput = req.body.content?.attachments ?? req.body.attachments ?? req.body.attachmentOrder;
    const updatedAttachments = buildOrderedAttachments({
      rawAttachments: attachmentUpdateInput ?? post.content.attachments,
      media: Array.isArray(post.content.media) ? post.content.media : [],
      includePoll: Boolean(post.content?.pollId),
      includeArticle: Boolean(post.content.article),
      includeEvent: Boolean(post.content?.event),
      includeRoom: Boolean(post.content?.room),
      includeLocation: Boolean(post.content.location),
      includeSources: Boolean(post.content.sources && post.content.sources.length),
      includePodcast: Boolean(post.content?.podcast)
    });

    if (updatedAttachments) {
      post.content.attachments = updatedAttachments;
    } else {
      post.content.attachments = undefined;
    }
    post.markModified('content.attachments');

    if (hashtags !== undefined) post.hashtags = mergeHashtags('', hashtags || []);
    if (mentions !== undefined) post.mentions = mentions || [];

    const collaboratorIds = await postCollaborationService.resolveCollaboratorRefs(
      userId,
      Array.isArray(req.body.collaboratorIds) ? req.body.collaboratorIds : undefined,
      Array.isArray(req.body.collaboratorHandles) ? req.body.collaboratorHandles : undefined,
    );
    if (collaboratorIds && collaboratorIds.length > 0) {
      await postCollaborationService.attachCollaborators(post, userId, collaboratorIds);
    }

    await post.save();

    const isPublished = (post.status ?? 'published') === 'published';
    if (isPublished && collaboratorIds && collaboratorIds.length > 0) {
      const autoAcceptIds = await resolveMcpAutoAcceptIds(req, collaboratorIds);
      if (autoAcceptIds && autoAcceptIds.length > 0) {
        await postCollaborationService.autoAcceptInvites(post, new Set(autoAcceptIds));
      }
      await postCollaborationService.notifyPendingInvites(post, userId);
    }

    // MTN dual-write: an edit re-emits the `app.mention.feed.post` record under
    // the SAME rkey (the post id). The chain is append-only and materialization
    // is last-writer-wins by chain order, so the new record supersedes the old
    // version. Only LOCAL posts emit (an edited federated post never had a record;
    // the 30-minute edit window above only applies to owner-scoped native posts).
    if (post.federation == null && post.oxyUserId) {
      await emitPostCreated(post);
    }

    // Hydrate the updated post for consistent frontend response shape.
    // PostHydrationService is the single source of truth for post DTOs; we do NOT
    // hand-build a `user` object here (that would leak the raw oxyUserId as the
    // display name and break the profile-identity contract). If hydration fails
    // for this just-saved, owner-scoped post, treat it as a server-side error.
    const hydrated = await postHydrationService.hydratePosts([post.toObject()], { viewerId: userId, oxyClient: createScopedOxyClient(req) });
    if (hydrated.length === 0) {
      logger.error('Failed to hydrate edited post', { postId: String(post._id), userId });
      return res.status(500).json({ message: 'Error updating post' });
    }
    res.json(hydrated[0]);
  } catch (error) {
    if (error instanceof CollabValidationError) {
      return res.status(400).json({ message: error.message });
    }
    if (error instanceof CollabStateError) {
      return res.status(400).json({ message: error.message });
    }
    logger.error('Error updating post', error);
    res.status(500).json({ message: 'Error updating post' });
  }
};

// Update post settings (pin, hide counts, reply permissions, review replies)
export const updatePostSettings = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const post = await Post.findOne({ _id: req.params.id, oxyUserId: userId });
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    const { isPinned, hideEngagementCounts, replyPermission, reviewReplies, quotesDisabled } = req.body;

    if (isPinned !== undefined) {
      if (typeof isPinned !== 'boolean') {
        return res.status(400).json({ message: 'isPinned must be a boolean' });
      }
      post.metadata.isPinned = isPinned;
    }

    if (hideEngagementCounts !== undefined) {
      if (typeof hideEngagementCounts !== 'boolean') {
        return res.status(400).json({ message: 'hideEngagementCounts must be a boolean' });
      }
      post.metadata.hideEngagementCounts = hideEngagementCounts;
    }

    if (replyPermission !== undefined) {
      const validPermissions = ['anyone', 'followers', 'following', 'mentioned', 'nobody'];
      if (!Array.isArray(replyPermission) || replyPermission.length === 0) {
        return res.status(400).json({ message: 'replyPermission must be a non-empty array' });
      }
      const allValid = replyPermission.every((p: string) => validPermissions.includes(p));
      if (!allValid) {
        return res.status(400).json({ message: `replyPermission values must be one of: ${validPermissions.join(', ')}` });
      }
      post.replyPermission = replyPermission;
    }

    if (reviewReplies !== undefined) {
      if (typeof reviewReplies !== 'boolean') {
        return res.status(400).json({ message: 'reviewReplies must be a boolean' });
      }
      post.reviewReplies = reviewReplies;
    }

    if (quotesDisabled !== undefined) {
      if (typeof quotesDisabled !== 'boolean') {
        return res.status(400).json({ message: 'quotesDisabled must be a boolean' });
      }
      post.quotesDisabled = quotesDisabled;
    }

    post.markModified('metadata');
    await post.save();

    res.json({
      message: 'Post settings updated',
      isPinned: post.metadata.isPinned,
      hideEngagementCounts: post.metadata.hideEngagementCounts,
      replyPermission: post.replyPermission,
      reviewReplies: post.reviewReplies,
      quotesDisabled: post.quotesDisabled,
    });
  } catch (error) {
    logger.error('Error updating post settings', error);
    res.status(500).json({ message: 'Error updating post settings' });
  }
};

// Delete post
export const deletePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const post = await Post.findOneAndDelete({ _id: req.params.id, oxyUserId: userId });
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    const postId = post._id.toString();

    // MTN dual-write: deleting a LOCAL post tombstones its
    // `app.mention.feed.post` record. (Federated posts never emitted a record.)
    if (post.federation == null && post.oxyUserId) {
      await emitTombstone({
        authorOxyUserId: post.oxyUserId,
        tombstoneRkey: postId,
        subjectUri: postRecordUri(post.oxyUserId, postId),
      });
    }

    // Cascading cleanup — best-effort, don't fail the request
    try {
      await Promise.allSettled([
        // Delete associated article
        post.content?.article?.articleId
          ? ArticleModel.deleteOne({ _id: post.content.article.articleId }).exec()
          : Promise.resolve(),
        // Delete associated poll
        post.content?.pollId
          ? Poll.deleteOne({ _id: post.content.pollId }).exec()
          : Promise.resolve(),
        // Delete likes for this post
        Like.deleteMany({ postId }).exec(),
        // Delete bookmarks for this post
        Bookmark.deleteMany({ postId }).exec(),
        // Delete post subscriptions
        PostSubscription.deleteMany({ postId }).exec(),
        // Delete notifications referencing this post
        mongoose.model('Notification').deleteMany({ entityId: postId, entityType: 'post' }).exec(),
        // Delete replies (child posts)
        Post.deleteMany({ parentPostId: postId }).exec(),
      ]);
    } catch (cleanupError) {
      logger.error('Error during cascading post cleanup', cleanupError);
    }

    res.json({ message: 'Post deleted successfully' });
  } catch (error) {
    logger.error('Error deleting post', error);
    res.status(500).json({ message: 'Error deleting post' });
  }
};

// Clamp vote counts to zero and persist corrections if needed
const clampVoteCounts = async (postId: string, post: { stats?: { likesCount?: number; downvotesCount?: number } } | null): Promise<{ likesCount: number; downvotesCount: number }> => {
  const likesCount = Math.max(0, post?.stats?.likesCount ?? 0);
  const downvotesCount = Math.max(0, post?.stats?.downvotesCount ?? 0);
  const corrections: Record<string, number> = {};
  if (likesCount !== (post?.stats?.likesCount ?? 0)) corrections['stats.likesCount'] = 0;
  if (downvotesCount !== (post?.stats?.downvotesCount ?? 0)) corrections['stats.downvotesCount'] = 0;
  if (Object.keys(corrections).length > 0) {
    await Post.findByIdAndUpdate(postId, { $set: corrections });
  }
  return { likesCount, downvotesCount };
};

// Like post
export const likePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const postId = req.params.id as string;
    const value: 1 | -1 = req.body?.value === -1 ? -1 : 1;
    const surface = readInteractionSurface(req.body);

    logger.debug(`Vote request received: userId=${userId}, postId=${postId}, value=${value}`);

    // Check if user already has a vote on this post
    const existingLike = await Like.findOne({ userId, postId });

    if (existingLike) {
      const existingValue = existingLike.value ?? 1;

      // Same vote already exists — no-op
      if (existingValue === value) {
        logger.debug(`Post ${postId} already voted ${value} by user ${userId}`);
        const currentPost = await Post.findById(postId).select('stats.likesCount stats.downvotesCount').lean();

        return res.json({
          message: 'Vote unchanged',
          likesCount: currentPost?.stats?.likesCount ?? 0,
          downvotesCount: currentPost?.stats?.downvotesCount ?? 0,
          liked: value === 1,
          downvoted: value === -1
        });
      }

      // Switching vote direction: atomic update to avoid race condition
      const updated = await Like.findOneAndUpdate(
        { userId, postId },
        { value, ...(surface ? { source: surface } : {}) },
        { new: true }
      );
      if (!updated) {
        // Document was deleted between findOne and findOneAndUpdate — create fresh
        await Like.create({ userId, postId, value, source: surface });
      }

      const statsUpdate = value === 1
        ? { $inc: { 'stats.likesCount': 1, 'stats.downvotesCount': -1 } }
        : { $inc: { 'stats.likesCount': -1, 'stats.downvotesCount': 1 } };

      const updatedPost = await Post.findByIdAndUpdate(postId, statsUpdate, { new: true }).lean();

      const { likesCount, downvotesCount } = await clampVoteCounts(postId, updatedPost);

      // Best-effort preference learning — detached so it never adds latency to
      // the vote response.
      void userPreferenceService
        .recordInteraction(userId, postId, 'like', { surface })
        .catch((error) => logger.warn('Failed to record interaction for vote switch', error));

      return res.json({
        message: 'Vote switched successfully',
        likesCount,
        downvotesCount,
        liked: value === 1,
        downvoted: value === -1
      });
    }

    // No existing vote — create new
    logger.debug(`User ${userId} voting ${value} on post ${postId}`);
    const createdLike = await Like.create({ userId, postId, value, source: surface });

    const statField = value === 1 ? 'stats.likesCount' : 'stats.downvotesCount';
    const likedPost = await Post.findByIdAndUpdate(
      postId,
      { $inc: { [statField]: 1 } },
      { new: true }
    ).lean();

    // MTN dual-write: an upvote (value === 1) emits an `app.mention.feed.like`
    // record. Downvotes are not "likes" and are not part of the MTN like lexicon.
    if (value === 1) {
      await emitLikeCreated({
        likerOxyUserId: userId,
        likeRkey: String(createdLike._id),
        likedPostId: postId,
        likedPostOwnerOxyUserId: likedPost?.oxyUserId?.toString?.(),
      });

      // Affinity graph: the liker expresses affinity toward the post's author.
      // Fire-and-forget — buffering must never block or fail the like.
      const authorId = likedPost?.oxyUserId?.toString?.();
      if (authorId) {
        void affinityEventService
          .record({ fromUserId: userId, toUserId: authorId, type: 'like', eventId: `like:${String(createdLike._id)}` })
          .catch(() => undefined);
      }
    }

    // Best-effort preference learning — detached so it never adds latency to the
    // like response.
    void userPreferenceService
      .recordInteraction(userId, postId, 'like', { surface })
      .catch((error) => logger.warn('Failed to record interaction for preferences', error));

    // Create notification for upvotes only (not downvotes)
    if (value === 1) {
      try {
        await createPostAuthorNotifications(
          likedPost?.authorship as import('@mention/shared-types').PostAuthorshipEntry[] | undefined,
          {
            actorId: userId,
            type: 'like',
            entityId: postId,
            entityType: 'post',
          },
        );
      } catch (e) {
        logger.error('Failed to create like notification', e);
      }
    }

    res.json({
      message: value === 1 ? 'Post liked successfully' : 'Post downvoted successfully',
      likesCount: likedPost?.stats?.likesCount ?? 0,
      downvotesCount: likedPost?.stats?.downvotesCount ?? 0,
      liked: value === 1,
      downvoted: value === -1
    });
  } catch (error) {
    logger.error('Error voting on post', error);
    res.status(500).json({ message: 'Error voting on post' });
  }
};

// Remove vote (unlike or remove downvote)
export const unlikePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const postId = req.params.id as string;

    // Find and remove the vote record to know which count to decrement
    const existingLike = await Like.findOneAndDelete({ userId, postId });
    if (!existingLike) {
      const currentPost = await Post.findById(postId).select('stats.likesCount stats.downvotesCount').lean();
      return res.json({
        message: 'No vote to remove',
        likesCount: currentPost?.stats?.likesCount ?? 0,
        downvotesCount: currentPost?.stats?.downvotesCount ?? 0,
        liked: false,
        downvoted: false
      });
    }

    // Decrement the appropriate counter based on the vote's value
    const voteValue = existingLike.value ?? 1;
    const statField = voteValue === 1 ? 'stats.likesCount' : 'stats.downvotesCount';

    const updatedPost = await Post.findByIdAndUpdate(
      postId,
      { $inc: { [statField]: -1 } },
      { new: true }
    ).lean();

    // MTN dual-write: removing an upvote tombstones its `app.mention.feed.like`
    // record. (A removed downvote has no like record to supersede.)
    if (voteValue === 1) {
      await emitTombstone({
        authorOxyUserId: userId,
        tombstoneRkey: String(existingLike._id),
        subjectUri: likeRecordUri(userId, String(existingLike._id)),
      });
    }

    const { likesCount, downvotesCount } = await clampVoteCounts(postId, updatedPost);

    res.json({
      message: 'Vote removed successfully',
      likesCount,
      downvotesCount,
      liked: false,
      downvoted: false
    });
  } catch (error) {
    logger.error('Error removing vote', error);
    res.status(500).json({ message: 'Error removing vote' });
  }
};

// Save post
export const savePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const postId = req.params.id as string;
    const surface = readInteractionSurface(req.body);

    logger.debug(`Save request received: userId=${userId}, postId=${postId}`);

    // Check if already saved
    const existingSave = await Bookmark.findOne({ userId, postId });
    if (existingSave) {
      logger.debug(`Post ${postId} already saved by user ${userId}`);

      // Still record the interaction even if already saved (user expressed
      // interest). Best-effort, detached — never adds latency to the response.
      void userPreferenceService
        .recordInteraction(userId, postId, 'save', { surface })
        .catch((error) => logger.warn('Failed to record interaction for already-saved post', error));

      return res.json({ message: 'Post already saved' });
    }

    logger.debug(`User ${userId} saving post ${postId} (not already saved)`);

    // Create save record
    const createdBookmark = await Bookmark.create({ userId, postId });

    // Also update post metadata.savedBy for consistency
    const savedPost = await Post.findByIdAndUpdate(
      postId,
      {
        $addToSet: { 'metadata.savedBy': userId }
      },
      { new: true }
    ).select('oxyUserId').lean();

    // MTN dual-write: a save emits a PRIVATE `app.mention.feed.bookmark` record
    // (excluded from any public log export).
    await emitBookmarkCreated({
      ownerOxyUserId: userId,
      bookmarkRkey: String(createdBookmark._id),
      bookmarkedPostId: postId,
      bookmarkedPostOwnerOxyUserId: savedPost?.oxyUserId?.toString?.(),
    });

    // Best-effort preference learning — detached so it never adds latency to the
    // save response.
    void userPreferenceService
      .recordInteraction(userId, postId, 'save', { surface })
      .catch((error) => logger.warn('Failed to record interaction for preferences', error));

    res.json({ message: 'Post saved successfully' });
  } catch (error) {
    logger.error('Error saving post', error);
    res.status(500).json({ message: 'Error saving post' });
  }
};

// Unsave post
export const unsavePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const postId = req.params.id as string;

    // Remove save record
    const removedBookmark = await Bookmark.findOneAndDelete({ userId, postId });
    if (!removedBookmark) {
      return res.json({ message: 'Post not saved' });
    }

    // Also update post metadata.savedBy for consistency
    await Post.findByIdAndUpdate(
      postId,
      {
        $pull: { 'metadata.savedBy': userId }
      }
    );

    // MTN dual-write: an unsave tombstones the bookmark's
    // `app.mention.feed.bookmark` record (private — same private chain).
    await emitTombstone({
      authorOxyUserId: userId,
      tombstoneRkey: String(removedBookmark._id),
      subjectUri: bookmarkRecordUri(userId, String(removedBookmark._id)),
    });

    res.json({ message: 'Post unsaved successfully' });
  } catch (error) {
    logger.error('Error unsaving post', error);
    res.status(500).json({ message: 'Error unsaving post' });
  }
};

// Get saved posts for current user
export const getSavedPosts = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const page = queryInt(req.query.page) || 1;
    const limit = Math.min(queryInt(req.query.limit) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const searchQuery = queryString(req.query.search);

    const folderFilter = queryString(req.query.folder);

    // Get saved post IDs for the user, optionally filtered by folder
    const bookmarkQuery: Record<string, unknown> = { userId };
    if (folderFilter) {
      bookmarkQuery.folder = folderFilter;
    }
    const savedPosts = await Bookmark.find(bookmarkQuery)
      .sort({ createdAt: -1 })
      .lean();

    const postIds = savedPosts.map(saved => saved.postId);

    // Build query for posts
    // Don't filter by visibility - users should be able to see their saved posts regardless of visibility
    const postQuery: Record<string, unknown> = {
      _id: { $in: postIds }
    };

    // Add search filter if provided
    if (searchQuery && searchQuery.trim()) {
      const trimmedQuery = searchQuery.trim();
      logger.debug(`Applying search filter: "${trimmedQuery}"`);
      // Use MongoDB $regex for partial text matching (case-insensitive)
      // Escape special regex characters but allow partial matching
      const escapedQuery = trimmedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      postQuery['content.text'] = {
        $regex: escapedQuery,
        $options: 'i' // case-insensitive
      };
      logger.debug('Final query', JSON.stringify(postQuery, null, 2));
    }

    // Get the actual posts
    const posts = await Post.find(postQuery)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const hydratedPosts = await postHydrationService.hydratePosts(posts, {
      viewerId: userId,
      oxyClient: createScopedOxyClient(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });

    res.json({
      posts: hydratedPosts,
      hasMore: posts.length === limit,
      page,
      limit
    });
  } catch (error) {
    logger.error('Error fetching saved posts', error);
    res.status(500).json({ message: 'Error fetching saved posts' });
  }
};

// Get bookmark folders for current user
export const getBookmarkFolders = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const folders = await Bookmark.distinct('folder', { userId, folder: { $ne: null } });
    res.json({ folders });
  } catch (error) {
    logger.error('Error fetching bookmark folders', error);
    res.status(500).json({ message: 'Error fetching bookmark folders' });
  }
};

// Move a bookmark to a folder
export const moveBookmarkToFolder = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const bookmarkId = req.params.id;
    const { folder } = req.body;

    const bookmark = await Bookmark.findOneAndUpdate(
      { _id: bookmarkId, userId },
      { $set: { folder: folder || null } },
      { new: true }
    );

    if (!bookmark) {
      return res.status(404).json({ message: 'Bookmark not found' });
    }

    res.json({ bookmark });
  } catch (error) {
    logger.error('Error moving bookmark to folder', error);
    res.status(500).json({ message: 'Error moving bookmark to folder' });
  }
};

// Get posts by hashtag
export function buildPostsByHashtagFilter(
  hashtag: string,
  cursor?: string,
): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    hashtags: { $in: [hashtag.toLowerCase()] },
    status: 'published',
    visibility: PostVisibility.PUBLIC,
  };

  if (cursor) {
    filter._id = { $lt: cursor };
  }

  return filter;
}

export const getPostsByHashtag = async (req: AuthRequest, res: Response) => {
  try {
    const hashtag = String(req.params.hashtag);
    const cursor = queryString(req.query.cursor);
    const limit = Math.min(queryInt(req.query.limit) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const filter = buildPostsByHashtagFilter(hashtag, cursor);

    const posts = await Post.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = posts.length > limit;
    const postsToReturn = hasMore ? posts.slice(0, limit) : posts;
    const nextCursor = hasMore && postsToReturn.length > 0
      ? postsToReturn[postsToReturn.length - 1]._id.toString()
      : undefined;

    const hydratedPosts = await postHydrationService.hydratePosts(postsToReturn, {
      viewerId: req.user?.id,
      oxyClient: createScopedOxyClient(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });

    res.json({
      items: hydratedPosts,
      hasMore,
      nextCursor,
    });
  } catch (error) {
    logger.error('Error fetching posts by hashtag', error);
    res.status(500).json({ message: 'Error fetching posts by hashtag' });
  }
};

/**
 * Build the topic-page query filter. Matches a published post whose canonical
 * registry-linked `postClassification.topicRefs.name` OR slug-only
 * `postClassification.topics` equals the normalized (lowercased) topic — the two
 * forms of the one canonical topic list (Stage-B AI refs and the Stage-A
 * rule-based slug baseline). Topic discovery is a public surface, so the
 * filter is constrained to public posts. Topics are stored lowercase, so the
 * lookup is lowercased for index efficiency. Exported for unit testing the canonical `$or`
 * contract without booting the controller's server import chain.
 */
export function buildPostsByTopicFilter(
  topicName: string,
  cursor?: string,
): Record<string, unknown> {
  const normalizedTopic = topicName.toLowerCase();
  const filter: Record<string, unknown> = {
    $or: [
      { 'postClassification.topicRefs.name': normalizedTopic },
      { 'postClassification.topics': normalizedTopic },
    ],
    status: 'published',
    visibility: PostVisibility.PUBLIC,
  };
  if (cursor) {
    filter._id = { $lt: cursor };
  }
  return filter;
}

// Get posts by classified topic or entity name
export const getPostsByTopic = async (req: AuthRequest, res: Response) => {
  try {
    const topicName = String(req.params.topic);
    const cursor = queryString(req.query.cursor);
    const limit = Math.min(queryInt(req.query.limit) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const filter = buildPostsByTopicFilter(topicName, cursor);

    const posts = await Post.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = posts.length > limit;
    const postsToReturn = hasMore ? posts.slice(0, limit) : posts;
    const nextCursor = hasMore && postsToReturn.length > 0
      ? postsToReturn[postsToReturn.length - 1]._id.toString()
      : undefined;

    const hydratedPosts = await postHydrationService.hydratePosts(postsToReturn, {
      viewerId: req.user?.id,
      oxyClient: createScopedOxyClient(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });

    res.json({
      posts: hydratedPosts,
      topic: topicName,
      hasMore,
      nextCursor,
    });
  } catch (error) {
    logger.error('Error fetching posts by topic', error);
    res.status(500).json({ message: 'Error fetching posts by topic' });
  }
};

// Get drafts
export const getDrafts = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const drafts = await Post.find({
      oxyUserId: userId,
      status: 'draft'
    })
      .sort({ created_at: -1 })
      .populate('userID', 'username name avatar verified')
      .lean();

    res.json(drafts);
  } catch (error) {
    logger.error('Error fetching drafts', error);
    res.status(500).json({ message: 'Error fetching drafts' });
  }
};

// Get scheduled posts
export const getScheduledPosts = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const scheduledPosts = await Post.find({
      oxyUserId: userId,
      status: 'scheduled'
    })
      .sort({ scheduledFor: 1 })
      .populate('userID', 'username name avatar verified')
      .lean();

    res.json(scheduledPosts);
  } catch (error) {
    logger.error('Error fetching scheduled posts', error);
    res.status(500).json({ message: 'Error fetching scheduled posts' });
  }
}; 

// Get nearby posts based on location
export const getNearbyPosts = async (req: AuthRequest, res: Response) => {
  try {
    const lat = queryString(req.query.lat);
    const lng = queryString(req.query.lng);
    const locationType = queryString(req.query.locationType) ?? 'content';

    if (!lat || !lng) {
      return res.status(400).json({ message: 'Latitude and longitude are required' });
    }

    const rawRadius = queryString(req.query.radius);
    const latitude = Number.parseFloat(lat);
    const longitude = Number.parseFloat(lng);
    const radiusMeters = rawRadius === undefined
      ? DEFAULT_NEARBY_RADIUS_METERS
      : Number.parseInt(rawRadius, 10);
    const locationField = locationType === 'post' ? 'location' : 'content.location';

    if (Number.isNaN(latitude) || Number.isNaN(longitude) || Number.isNaN(radiusMeters)) {
      return res.status(400).json({ message: 'Invalid latitude, longitude, or radius' });
    }

    if (locationType !== 'content' && locationType !== 'post') {
      return res.status(400).json({ message: 'locationType must be either "content" or "post"' });
    }

    // MongoDB geospatial query to find posts within radius
    const posts = await Post.find({
      visibility: 'public',
      status: 'published',
      [locationField]: {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [longitude, latitude] // GeoJSON format: [lng, lat]
          },
          $maxDistance: radiusMeters
        }
      }
    })
      .sort({ createdAt: -1 })
      .limit(MAX_NEARBY_POSTS)
      .lean();

    const hydratedPosts = await postHydrationService.hydratePosts(posts, {
      viewerId: req.user?.id,
      oxyClient: createScopedOxyClient(req),
      maxDepth: 1,
      includeLinkMetadata: false,
    });

    res.json({
      posts: hydratedPosts,
      center: { latitude, longitude },
      radius: radiusMeters,
      locationType,
      count: hydratedPosts.length
    });
  } catch (error) {
    logger.error('Error fetching nearby posts', error);
    res.status(500).json({ message: 'Error fetching nearby posts' });
  }
};

// Get posts within a bounding box area
export const getPostsInArea = async (req: AuthRequest, res: Response) => {
  try {
    const north = queryString(req.query.north);
    const south = queryString(req.query.south);
    const east = queryString(req.query.east);
    const west = queryString(req.query.west);
    const locationType = queryString(req.query.locationType) ?? 'content';

    if (!north || !south || !east || !west) {
      return res.status(400).json({
        message: 'Bounding box coordinates (north, south, east, west) are required'
      });
    }

    const northLat = Number.parseFloat(north);
    const southLat = Number.parseFloat(south);
    const eastLng = Number.parseFloat(east);
    const westLng = Number.parseFloat(west);
    const locationField = locationType === 'post' ? 'location' : 'content.location';

    if (Number.isNaN(northLat) || Number.isNaN(southLat) || Number.isNaN(eastLng) || Number.isNaN(westLng)) {
      return res.status(400).json({ message: 'Invalid bounding box coordinates' });
    }

    if (locationType !== 'content' && locationType !== 'post') {
      return res.status(400).json({ message: 'locationType must be either "content" or "post"' });
    }

    // MongoDB geospatial query to find posts within bounding box
    const posts = await Post.find({
      visibility: 'public',
      status: 'published',
      [locationField]: {
        $geoWithin: {
          $box: [
            [westLng, southLat], // bottom-left corner [lng, lat]
            [eastLng, northLat]  // top-right corner [lng, lat]
          ]
        }
      }
    })
      .sort({ createdAt: -1 })
      .limit(MAX_AREA_POSTS)
      .lean();

    const hydratedPosts = await postHydrationService.hydratePosts(posts, {
      viewerId: req.user?.id,
      oxyClient: createScopedOxyClient(req),
      maxDepth: 1,
      includeLinkMetadata: false,
    });

    res.json({
      posts: hydratedPosts,
      boundingBox: { north: northLat, south: southLat, east: eastLng, west: westLng },
      locationType,
      count: hydratedPosts.length
    });
  } catch (error) {
    logger.error('Error fetching posts in area', error);
    res.status(500).json({ message: 'Error fetching posts in area' });
  }
};

// Get nearby posts based on both user and post locations
// Get users who liked a post
export const getPostLikes = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const cursor = queryString(req.query.cursor);
    const limit = clampLikesLimit(queryInt(req.query.limit));

    if (!id) {
      return res.status(400).json({ message: 'Post ID is required' });
    }

    const query: Record<string, unknown> = { postId: id };
    if (cursor) {
      query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
    }

    const likes = await Like.find(query)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = likes.length > limit;
    const likesToReturn = hasMore ? likes.slice(0, limit) : likes;
    const nextCursor = hasMore ? likes[limit - 1]._id.toString() : undefined;

    // Get unique user IDs, then resolve actor summaries through the same shared
    // resolver PostHydrationService uses (canonical `name.displayName`, batched
    // bulk fetch, Redis-cached) instead of N hand-built per-id Oxy reads.
    const userIds = [...new Set(likesToReturn.map(like => like.userId))];
    const summaries = await resolveUserSummaries(userIds);
    const users = userIds.map((userId) => mapActorSummary(userId, summaries.get(userId)?.user));

    res.json({
      users,
      hasMore,
      nextCursor,
      totalCount: likesToReturn.length
    });
  } catch (error) {
    logger.error('Error fetching post likes', error);
    res.status(500).json({ message: 'Error fetching post likes' });
  }
};

// Get users who boosted a post
export const getPostBoosts = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const cursor = queryString(req.query.cursor);
    const limit = clampLikesLimit(queryInt(req.query.limit));

    if (!id) {
      return res.status(400).json({ message: 'Post ID is required' });
    }

    const query: Record<string, unknown> = { boostOf: id, visibility: PostVisibility.PUBLIC };
    if (cursor) {
      query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
    }

    const boosts = await Post.find(query)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .select('oxyUserId createdAt')
      .lean();

    const hasMore = boosts.length > limit;
    const boostsToReturn = hasMore ? boosts.slice(0, limit) : boosts;
    const nextCursor = hasMore ? boosts[limit - 1]._id.toString() : undefined;

    // Get unique user IDs, then resolve actor summaries through the same shared
    // resolver PostHydrationService uses (canonical `name.displayName`, batched
    // bulk fetch, Redis-cached) instead of N hand-built per-id Oxy reads.
    const userIds = [...new Set(boostsToReturn.map(boost => boost.oxyUserId).filter((id): id is string => typeof id === 'string'))];
    const summaries = await resolveUserSummaries(userIds);
    const users = userIds.map((userId) => mapActorSummary(userId, summaries.get(userId)?.user));

    res.json({
      users,
      hasMore,
      nextCursor,
      totalCount: boostsToReturn.length
    });
  } catch (error) {
    logger.error('Error fetching post boosts', error);
    res.status(500).json({ message: 'Error fetching post boosts' });
  }
};

export const getNearbyPostsBothLocations = async (req: AuthRequest, res: Response) => {
  try {
    const lat = queryString(req.query.lat);
    const lng = queryString(req.query.lng);
    const rawRadius = queryString(req.query.radius);

    if (!lat || !lng) {
      return res.status(400).json({ message: 'Latitude and longitude are required' });
    }

    const latitude = Number.parseFloat(lat);
    const longitude = Number.parseFloat(lng);
    const radiusMeters = rawRadius === undefined
      ? DEFAULT_NEARBY_RADIUS_METERS
      : Number.parseInt(rawRadius, 10);

    if (Number.isNaN(latitude) || Number.isNaN(longitude) || Number.isNaN(radiusMeters)) {
      return res.status(400).json({ message: 'Invalid latitude, longitude, or radius' });
    }

    // MongoDB geospatial query to find posts within radius for either location type
    const posts = await Post.find({
      visibility: 'public',
      status: 'published',
      $or: [
        {
          'content.location': {
            $near: {
              $geometry: {
                type: 'Point',
                coordinates: [longitude, latitude] // GeoJSON format: [lng, lat]
              },
              $maxDistance: radiusMeters
            }
          }
        },
        {
          'location': {
            $near: {
              $geometry: {
                type: 'Point',
                coordinates: [longitude, latitude] // GeoJSON format: [lng, lat]
              },
              $maxDistance: radiusMeters
            }
          }
        }
      ]
    })
      .sort({ createdAt: -1 })
      .limit(75) // Slightly higher limit since we're querying both location types
      .lean();

    const currentUserId = req.user?.id;
    const hydratedPosts = await postHydrationService.hydratePosts(posts, {
      viewerId: currentUserId,
      oxyClient: createScopedOxyClient(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });

    res.json({
      posts: hydratedPosts,
      center: { latitude, longitude },
      radius: radiusMeters,
      locationType: 'both',
      count: hydratedPosts.length
    });
  } catch (error) {
    logger.error('Error fetching nearby posts (both locations)', error);
    res.status(500).json({ message: 'Error fetching nearby posts (both locations)' });
  }
};

// Get location statistics for analytics
export const getLocationStats = async (req: AuthRequest, res: Response) => {
  try {
    // Count posts with content locations (user shared)
    const contentLocationCount = await Post.countDocuments({
      visibility: 'public',
      status: 'published',
      'content.location': { $exists: true, $ne: null }
    });

    // Count posts with post locations (creation metadata)
    const postLocationCount = await Post.countDocuments({
      visibility: 'public',
      status: 'published',
      'location': { $exists: true, $ne: null }
    });

    // Count posts with both location types
    const bothLocationsCount = await Post.countDocuments({
      visibility: 'public',
      status: 'published',
      'content.location': { $exists: true, $ne: null },
      'location': { $exists: true, $ne: null }
    });

    // Get total post count for percentage calculation
    const totalPosts = await Post.countDocuments({ visibility: 'public', status: 'published' });

    res.json({
      total: totalPosts,
      withContentLocation: contentLocationCount,
      withPostLocation: postLocationCount,
      withBothLocations: bothLocationsCount,
      withAnyLocation: await Post.countDocuments({
        visibility: 'public',
        status: 'published',
        $or: [
          { 'content.location': { $exists: true, $ne: null } },
          { 'location': { $exists: true, $ne: null } }
        ]
      }),
      percentages: {
        contentLocation: totalPosts > 0 ? ((contentLocationCount / totalPosts) * 100).toFixed(2) : '0.00',
        postLocation: totalPosts > 0 ? ((postLocationCount / totalPosts) * 100).toFixed(2) : '0.00',
        bothLocations: totalPosts > 0 ? ((bothLocationsCount / totalPosts) * 100).toFixed(2) : '0.00'
      }
    });
  } catch (error) {
    logger.error('Error fetching location stats', error);
    res.status(500).json({ message: 'Error fetching location stats' });
  }
};

// ── Translate post ──

const SUPPORTED_LANGUAGES: Record<string, string> = {
  'en': 'English',
  'en-US': 'English',
  'es': 'Spanish',
  'es-ES': 'Spanish',
  'it': 'Italian',
  'it-IT': 'Italian',
  'fr': 'French',
  'fr-FR': 'French',
  'pt': 'Portuguese',
  'pt-BR': 'Portuguese',
  'de': 'German',
  'de-DE': 'German',
  'ca': 'Catalan',
  'ca-ES': 'Catalan',
};

export const translatePost = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { targetLanguage, force } = req.body;

    if (!targetLanguage || typeof targetLanguage !== 'string') {
      res.status(400).json({ message: 'targetLanguage is required' });
      return;
    }

    const languageName = SUPPORTED_LANGUAGES[targetLanguage];
    if (!languageName) {
      res.status(400).json({ message: `Unsupported language: ${targetLanguage}` });
      return;
    }

    const post = await Post.findById(id)
      .select('_id oxyUserId authorship content.text translations visibility status federation createdAt')
      .lean();
    if (!post) {
      res.status(404).json({ message: 'Post not found' });
      return;
    }

    const visiblePosts = await postHydrationService.hydratePosts([post], {
      viewerId: req.user?.id,
      oxyClient: createScopedOxyClient(req),
      maxDepth: 0,
      includeLinkMetadata: false,
      includeFullArticleBody: false,
      includeFullMetadata: false,
    });
    if (visiblePosts.length === 0) {
      res.status(404).json({ message: 'Post not found' });
      return;
    }

    const text = post.content?.text;
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      res.status(404).json({ message: 'Post has no text content to translate' });
      return;
    }

    // Check cache (skip when force retranslating)
    if (!force) {
      const cached = post.translations?.find((t) => t.language === targetLanguage);
      if (cached) {
        res.json({ translatedText: cached.text, cached: true });
        return;
      }
    }

    const truncatedText = text.slice(0, MAX_TEXT_LENGTH);
    const translatedText = await aliaChat(
      [
        {
          role: 'system',
          content: 'You are a strict translation engine. You receive text wrapped in <text> tags. Output ONLY the translation — no explanations, no commentary, no extra text. Preserve all formatting, mentions, hashtags, and line breaks exactly.',
        },
        {
          role: 'user',
          content: `Translate the following to ${languageName}:\n<text>\n${truncatedText}\n</text>`,
        },
      ],
      { model: 'alia-lite', temperature: 0.1, maxTokens: Math.max(truncatedText.length * 3, 256) },
    );

    const trimmed = translatedText.trim();
    if (!trimmed) {
      res.status(500).json({ message: 'Translation returned empty result' });
      return;
    }

    // Save translation to cache — replace existing entry for this language if force retranslating
    if (force) {
      Post.updateOne(
        { _id: id },
        {
          $pull: { translations: { language: targetLanguage } },
        },
      ).then(() =>
        Post.updateOne(
          { _id: id },
          { $push: { translations: { language: targetLanguage, text: trimmed, translatedAt: new Date() } } },
        ),
      ).catch((err) => logger.error('Error caching translation', err));
    } else {
      Post.updateOne(
        { _id: id },
        { $push: { translations: { language: targetLanguage, text: trimmed, translatedAt: new Date() } } },
      ).catch((err) => logger.error('Error caching translation', err));
    }

    res.json({ translatedText: trimmed, cached: false });
  } catch (error) {
    // Parse Alia API error status from the thrown error message
    const errorMessage = error instanceof Error ? error.message : '';
    const statusMatch = errorMessage.match(/Alia API error (\d+)/);
    const aliaStatus = statusMatch ? parseInt(statusMatch[1], 10) : 0;

    if (aliaStatus === 429) {
      logger.warn('Translation rate limited', error);
      res.status(429).json({ message: 'Too many requests. Please try again later.' });
    } else if (aliaStatus === 503 || aliaStatus === 502) {
      logger.warn('Translation service unavailable', error);
      res.status(503).json({ message: 'Translation service temporarily unavailable.' });
    } else if (aliaStatus === 402) {
      logger.warn('Translation credits issue', error);
      res.status(502).json({ message: 'Translation service unavailable.' });
    } else {
      logger.error('Error translating post', error);
      res.status(500).json({ message: 'Translation failed' });
    }
  }
};
