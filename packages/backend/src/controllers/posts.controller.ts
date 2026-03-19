import { Request, Response } from 'express';
import { Post } from '../models/Post';
import Poll from '../models/Poll';
import Like from '../models/Like';
import Bookmark from '../models/Bookmark';
import { AuthRequest } from '../types/auth';
import mongoose from 'mongoose';
import { oxy as oxyClient } from '../../server';
import { createNotification, createMentionNotifications, createBatchNotifications } from '../utils/notificationUtils';
import PostSubscription from '../models/PostSubscription';
import { PostVisibility, PostAttachmentDescriptor, PostAttachmentType } from '@mention/shared-types';
import { userPreferenceService } from '../services/UserPreferenceService';
import { feedCacheService } from '../services/FeedCacheService';
import ArticleModel from '../models/Article';
import { logger } from '../utils/logger';
import { postHydrationService } from '../services/PostHydrationService';
import { config } from '../config';
import { mergeHashtags, escapeRegex } from '../utils/textProcessing';
import { createScopedOxyClient } from '../utils/oxyHelpers';
import { aliaChat } from '../utils/alia';

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
const DEFAULT_REPOSTS_LIMIT = 50;
const MAX_TEXT_LENGTH = config.posts.maxTextLength;

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

const sanitizeArticle = (input: any): { title?: string; body?: string } | undefined => {
  if (!input || typeof input !== 'object') return undefined;
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, MAX_ARTICLE_TITLE_LENGTH) : undefined;
  const body = typeof input.body === 'string' ? input.body.trim() : undefined;
  if (!title && !body) return undefined;
  return { ...(title ? { title } : {}), ...(body ? { body } : {}) };
};

const sanitizeEventData = (eventData: any): { eventId?: string; name?: string; date?: string; location?: string; description?: string } | null => {
  if (!eventData || typeof eventData !== 'object') return null;

  const sanitized = {
    eventId: typeof eventData.eventId === 'string' ? eventData.eventId.trim() : undefined,
    name: typeof eventData.name === 'string' ? eventData.name.trim().slice(0, MAX_EVENT_NAME_LENGTH) : undefined,
    date: typeof eventData.date === 'string'
      ? eventData.date.trim()
      : (eventData.date instanceof Date ? eventData.date.toISOString() : undefined),
    location: typeof eventData.location === 'string' ? eventData.location.trim().slice(0, MAX_EVENT_LOCATION_LENGTH) : undefined,
    description: typeof eventData.description === 'string' ? eventData.description.trim().slice(0, MAX_EVENT_DESCRIPTION_LENGTH) : undefined,
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

const sanitizeRoomData = (roomData: any): { roomId: string; title: string; status?: string; topic?: string; host?: string } | null => {
  if (!roomData || typeof roomData !== 'object') return null;
  const id = roomData.roomId ?? roomData.spaceId;
  if (typeof id !== 'string' || typeof roomData.title !== 'string') return null;

  return {
    roomId: id.trim(),
    title: roomData.title.trim().slice(0, 200),
    ...(typeof roomData.status === 'string' && ['scheduled', 'live', 'ended'].includes(roomData.status) ? { status: roomData.status } : {}),
    ...(typeof roomData.topic === 'string' ? { topic: roomData.topic.trim().slice(0, 100) } : {}),
    ...(typeof roomData.host === 'string' ? { host: roomData.host.trim() } : {}),
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
}

const normalizeMediaItems = (arr: any): NormalizedMediaItem[] => {
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
        ...(mimeValue ? { mime: String(mimeValue) } : {})
      });
    }
  });

  return normalized;
};

const ATTACHMENT_TYPES: PostAttachmentType[] = ['media', 'poll', 'article', 'event', 'room', 'space', 'location', 'sources'];

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
  rawAttachments?: any;
  media: NormalizedMediaItem[];
  includePoll?: boolean;
  includeArticle?: boolean;
  includeEvent?: boolean;
  includeRoom?: boolean;
  includeLocation?: boolean;
  includeSources?: boolean;
}

const buildOrderedAttachments = ({
  rawAttachments,
  media,
  includePoll = false,
  includeArticle = false,
  includeEvent = false,
  includeRoom = false,
  includeLocation = false,
  includeSources = false
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

  const processEntry = (entry: any) => {
    const descriptor = normalizeAttachmentInput(entry);
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
      case 'space': // backward compat for old posts
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
    // Support objects with { order: [...] }
    const maybeOrder = (rawAttachments.order || rawAttachments.attachments || rawAttachments.attachmentOrder) as any;
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

    const { content, hashtags, mentions, quoted_post_id, repost_of, in_reply_to_status_id, parentPostId, threadId, contentLocation, postLocation, replyPermission, reviewReplies, quotesDisabled, status: incomingStatus, scheduledFor } = req.body;

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
          type: 'Point',
          coordinates: [longitude, latitude], // GeoJSON format: [lng, lat]
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
          type: 'Point',
          coordinates: [longitude, latitude], // GeoJSON format: [lng, lat]
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
    const postContent: any = {
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
    let pendingArticleDoc: any = null;
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
    if (sanitizedEvent) {
      postContent.event = sanitizedEvent;
    }

    // Handle room data (backward compat: also reads from space field)
    const roomData = content?.room || content?.space || req.body.room || req.body.space;
    const sanitizedRoom = sanitizeRoomData(roomData);
    if (sanitizedRoom) {
      postContent.room = sanitizedRoom;
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
      includeSources: Boolean(postContent.sources && postContent.sources.length)
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

    // Build metadata from request
    const incomingMetadata = req.body.metadata || {};
    const postMetadata: any = {};
    if (incomingMetadata.isSensitive === true) {
      postMetadata.isSensitive = true;
    }

    const post = new Post({
      oxyUserId: userId,
      content: postContent,
      location: processedPostLocation,
      hashtags: uniqueTags,
      mentions: mentions || [],
      quoteOf: quoted_post_id || null,
      repostOf: repost_of || null,
      parentPostId: parentPostId || in_reply_to_status_id || null,
      threadId: threadId || null,
      visibility: PostVisibility.PUBLIC, // Explicitly set visibility
      replyPermission: replyPermission || ['anyone'],
      reviewReplies: reviewReplies || false,
      quotesDisabled: quotesDisabled || false,
      status: postStatus,
      scheduledFor: scheduledForDate || undefined,
      metadata: postMetadata,
      stats: {
        likesCount: 0,
        repostsCount: 0,
        commentsCount: 0,
        viewsCount: 0,
        sharesCount: 0
      }
    });

    await post.save();

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
        // Continue execution - post was created successfully
      }
    }
    
    if (!isScheduled) {
      // Fire mention notifications if any
      try {
        if (mentions && mentions.length > 0) {
          const isReply = Boolean(parentPostId || in_reply_to_status_id);
          await createMentionNotifications(
            mentions,
            String(post._id),
            userId,
            isReply ? 'reply' : 'post'
          );
        }
      } catch (e) {
        logger.error('Failed to create mention notifications', e);
      }

      // Batch-fetch posts needed for reply, quote, and repost notifications
      try {
        const replyParentId = parentPostId || in_reply_to_status_id || null;
        const idsToFetch = [replyParentId, quoted_post_id, repost_of].filter(Boolean) as string[];

        if (idsToFetch.length > 0) {
          const posts = await Post.find({ _id: { $in: idsToFetch } }).select('oxyUserId').lean();
          const postsMap = new Map(posts.map(p => [String(p._id), p]));

          // Reply notification
          if (replyParentId) {
            const parent = postsMap.get(String(replyParentId));
            const recipientId = parent?.oxyUserId?.toString?.() || (parent as any)?.oxyUserId || null;
            if (recipientId && recipientId !== userId) {
              await createNotification({
                recipientId,
                actorId: userId,
                type: 'reply',
                entityId: String(post._id),
                entityType: 'reply'
              });
            }
          }

          // Quote notification
          if (quoted_post_id) {
            const original = postsMap.get(String(quoted_post_id));
            const recipientId = original?.oxyUserId?.toString?.() || (original as any)?.oxyUserId || null;
            if (recipientId && recipientId !== userId && original) {
              await createNotification({
                recipientId,
                actorId: userId,
                type: 'quote',
                entityId: String(original._id),
                entityType: 'post'
              });
            }
          }

          // Repost notification
          if (repost_of) {
            const original = postsMap.get(String(repost_of));
            const recipientId = original?.oxyUserId?.toString?.() || (original as any)?.oxyUserId || null;
            if (recipientId && recipientId !== userId && original) {
              await createNotification({
                recipientId,
                actorId: userId,
                type: 'repost',
                entityId: String(original._id),
                entityType: 'post'
              });
            }
          }
        }
      } catch (e) {
        logger.error('Failed to create reply/quote/repost notifications', e);
      }

      // Notify subscribers of a new post (only for top-level posts, not replies)
      try {
        const isTopLevelPost = !(parentPostId || in_reply_to_status_id);
        if (isTopLevelPost) {
          const subs = await PostSubscription.find({ authorId: userId }).lean();
          if (subs && subs.length) {
            const notifications = subs
              .filter(s => s.subscriberId !== userId)
              .map(s => ({
                recipientId: s.subscriberId,
                actorId: userId,
                type: 'post' as const,
                entityId: String(post._id),
                entityType: 'post' as const,
              }));
            if (notifications.length) {
              await createBatchNotifications(notifications, true);
            }
          }
        }
      } catch (e) {
        logger.error('Failed to notify subscribers about new post', e);
      }
    }

    // Fetch user data from Oxy
    let userData: any = null;
    try {
      userData = await oxyClient.getUserById(userId);
    } catch (error) {
      logger.error('Failed to fetch user data from Oxy', error);
    }
    
    const transformedPost = post.toObject() as any;
    transformedPost.id = String(post._id); // Add string ID for frontend
    
    transformedPost.user = {
        id: userId,
        name: userData?.name?.full || 'Unknown User',
        handle: userData?.username || 'unknown',
        avatar: userData?.avatar || '',
        verified: userData?.verified || false
    };
    transformedPost.status = post.status;
    transformedPost.scheduledFor = post.scheduledFor ? post.scheduledFor.toISOString() : undefined;
    delete transformedPost.oxyUserId;

    try {
      if (!isScheduled && mentions && mentions.length > 0) {
        const isReply = Boolean(parentPostId || in_reply_to_status_id);
        await createMentionNotifications(
          mentions,
          String(post._id),
          userId,
          isReply ? 'reply' : 'post'
        );
      }
    } catch (e) {
      logger.error('Failed to create mention notifications', e);
    }
    
    // Emit real-time feed update for new post (only for published posts)
    if (!isScheduled) {
      try {
        const io = (global as any).io;
        if (io) {
          io.emit('feed:updated', {
            type: 'for_you',
            post: transformedPost,
            timestamp: new Date().toISOString()
          });
          // Also emit to following feed if user has followers
          io.emit('feed:updated', {
            type: 'following',
            post: transformedPost,
            authorId: userId,
            timestamp: new Date().toISOString()
          });
        }
      } catch (socketError) {
        logger.warn('Failed to emit socket event for new post', socketError);
      }
    }

    res.status(201).json({ success: true, post: transformedPost });
  } catch (error) {
    logger.error('Error creating post', error);
    res.status(500).json({ message: 'Error creating post' });
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

    logger.debug('Creating thread with body', JSON.stringify(req.body, null, 2));

    const { mode, posts } = req.body;

    if (!Array.isArray(posts) || posts.length === 0) {
      return res.status(400).json({ message: 'Posts array is required and cannot be empty' });
    }

    const createdPosts = [];
    let mainPostId: string | null = null;

    // Pre-fetch user data once (avoids N+1 in loop)
    let threadUserData: any = null;
    try {
      threadUserData = await oxyClient.getUserById(userId);
    } catch (error) {
      logger.error('Failed to fetch user data from Oxy for thread', error);
    }

    for (let i = 0; i < posts.length; i++) {
      const postData = posts[i];
      const { content, hashtags, mentions, visibility, replyPermission, reviewReplies, quotesDisabled } = postData;

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
            type: 'Point',
            coordinates: [longitude, latitude],
            address: address || undefined
          };
        }
      }

      // Build post content
      const postContent: any = {
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

      let pendingArticleDoc: any = null;
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
      if (threadSanitizedEvent) {
        postContent.event = threadSanitizedEvent;
      }

      // Handle room data (backward compat: also reads from space field)
      const threadSanitizedRoom = sanitizeRoomData(content?.room || content?.space);
      if (threadSanitizedRoom) {
        postContent.room = threadSanitizedRoom;
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
        includeSources: Boolean(postContent.sources && postContent.sources.length)
      });

      if (computedAttachments) {
        postContent.attachments = computedAttachments;
      } else {
        delete postContent.attachments;
      }

      const post: any = new Post({
        oxyUserId: userId,
        content: postContent,
        hashtags: uniqueTags,
        mentions: mentions || [],
        visibility: (visibility as PostVisibility) || PostVisibility.PUBLIC,
        replyPermission: replyPermission || ['anyone'],
        reviewReplies: reviewReplies || false,
        quotesDisabled: quotesDisabled || false,
        stats: {
          likesCount: 0,
          repostsCount: 0,
          commentsCount: 0,
          viewsCount: 0,
          sharesCount: 0
        },
        // For thread mode: first post is main, others are linked to it
        // For beast mode: all posts are independent
        ...(mode === 'thread' && i > 0 && mainPostId ? {
          parentPostId: mainPostId,
          threadId: mainPostId
        } : {})
      });

      await post.save();

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

      const userData = threadUserData;

      // Transform response
      const transformedPost = post.toObject() as any;
      transformedPost.id = String(post._id);
      
      transformedPost.user = {
        id: userId,
        name: userData?.name?.full || 'Unknown User',
        handle: userData?.username || 'unknown',
        avatar: userData?.avatar || '',
        verified: userData?.verified || false
      };
      delete transformedPost.oxyUserId;

      createdPosts.push(transformedPost);
    }

    logger.info(`Created ${createdPosts.length} posts in ${mode} mode`);

    // Emit real-time feed update for new thread posts
    try {
      const io = (global as any).io;
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
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
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
      // Reset topic extraction so the service re-processes this post
      post.extracted = undefined;
      post.markModified('extracted');
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
      const existingArticleId = (post.content as any)?.article?.articleId;
      if (sanitizedArticle) {
        let articleDoc = existingArticleId ? await (ArticleModel as any).findOne({ _id: existingArticleId } as any).exec() : null;
        const previousArticle = (post.content as any)?.article || {};

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
          await (ArticleModel as any).deleteOne({ _id: existingArticleId } as any).exec();
        }
        post.content.article = undefined;
      }
    }
    const attachmentUpdateInput = req.body.content?.attachments ?? req.body.attachments ?? req.body.attachmentOrder;
    const updatedAttachments = buildOrderedAttachments({
      rawAttachments: attachmentUpdateInput ?? post.content.attachments,
      media: Array.isArray(post.content.media) ? post.content.media : [],
      includePoll: Boolean((post.content as any)?.pollId),
      includeArticle: Boolean(post.content.article),
      includeEvent: Boolean((post.content as any)?.event),
      includeRoom: Boolean((post.content as any)?.room || (post.content as any)?.space),
      includeLocation: Boolean(post.content.location),
      includeSources: Boolean(post.content.sources && post.content.sources.length)
    });

    if (updatedAttachments) {
      post.content.attachments = updatedAttachments;
    } else {
      post.content.attachments = undefined;
    }
    post.markModified('content.attachments');

    if (hashtags !== undefined) post.hashtags = hashtags || [];
    if (mentions !== undefined) post.mentions = mentions || [];

    await post.save();

    // Hydrate the updated post for consistent frontend response shape
    try {
      const hydrated = await postHydrationService.hydratePosts([post.toObject()], { viewerId: userId, oxyClient: createScopedOxyClient(req) });
      if (hydrated.length > 0) {
        return res.json(hydrated[0]);
      }
    } catch (hydrateError) {
      logger.warn('Failed to hydrate edited post, falling back to raw transform', hydrateError);
    }

    // Fallback: transform the response to match frontend expectations
    const transformedPost = post.toObject() as any;

    // For now, use placeholder user data since we don't have a User model
    transformedPost.user = {
        id: transformedPost.oxyUserId,
        name: 'User', // This should come from Oxy service in the future
        handle: transformedPost.oxyUserId, // Use oxyUserId as handle for now
        avatar: '', // Default avatar
        verified: false // Default to false
    };
    delete transformedPost.oxyUserId;

    res.json(transformedPost);
  } catch (error) {
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
      (post as any).quotesDisabled = quotesDisabled;
    }

    post.markModified('metadata');
    await post.save();

    res.json({
      message: 'Post settings updated',
      isPinned: post.metadata.isPinned,
      hideEngagementCounts: post.metadata.hideEngagementCounts,
      replyPermission: post.replyPermission,
      reviewReplies: post.reviewReplies,
      quotesDisabled: (post as any).quotesDisabled,
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

    // Cascading cleanup — best-effort, don't fail the request
    try {
      await Promise.allSettled([
        // Delete associated article
        (post as any)?.content?.article?.articleId
          ? (ArticleModel as any).deleteOne({ _id: (post as any).content.article.articleId }).exec()
          : Promise.resolve(),
        // Delete associated poll
        (post as any)?.metadata?.pollId
          ? Poll.deleteOne({ _id: (post as any).metadata.pollId }).exec()
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
const clampVoteCounts = async (postId: string, post: any): Promise<{ likesCount: number; downvotesCount: number }> => {
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
        { value },
        { new: true }
      );
      if (!updated) {
        // Document was deleted between findOne and findOneAndUpdate — create fresh
        await Like.create({ userId, postId, value });
      }

      const statsUpdate = value === 1
        ? { $inc: { 'stats.likesCount': 1, 'stats.downvotesCount': -1 } }
        : { $inc: { 'stats.likesCount': -1, 'stats.downvotesCount': 1 } };

      const updatedPost = await Post.findByIdAndUpdate(postId, statsUpdate, { new: true }).lean();

      const { likesCount, downvotesCount } = await clampVoteCounts(postId, updatedPost);

      try {
        await userPreferenceService.recordInteraction(userId, postId, 'like');
        await feedCacheService.invalidateUserCache(userId);
      } catch (error) {
        logger.error('Failed to record interaction for vote switch', error);
      }

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
    await Like.create({ userId, postId, value });

    const statField = value === 1 ? 'stats.likesCount' : 'stats.downvotesCount';
    const likedPost = await Post.findByIdAndUpdate(
      postId,
      { $inc: { [statField]: 1 } },
      { new: true }
    ).lean();

    // Record interaction for user preference learning
    try {
      await userPreferenceService.recordInteraction(userId, postId, 'like');
      await feedCacheService.invalidateUserCache(userId);
    } catch (error) {
      logger.error('Failed to record interaction for preferences', error);
    }

    // Create notification for upvotes only (not downvotes)
    if (value === 1) {
      try {
        const recipientId = likedPost?.oxyUserId?.toString?.() || (likedPost as any)?.oxyUserId || null;
        if (recipientId && recipientId !== userId) {
          await createNotification({
            recipientId,
            actorId: userId,
            type: 'like',
            entityId: postId,
            entityType: 'post'
          });
        }
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

    // Invalidate cached feed for this user
    try {
      await feedCacheService.invalidateUserCache(userId);
    } catch (error) {
      logger.warn('Failed to invalidate cache', error);
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

    logger.debug(`Save request received: userId=${userId}, postId=${postId}`);

    // Check if already saved
    const existingSave = await Bookmark.findOne({ userId, postId });
    if (existingSave) {
      logger.debug(`Post ${postId} already saved by user ${userId}`);
      
      // Still record the interaction even if already saved (user expressed interest)
      try {
        await userPreferenceService.recordInteraction(userId, postId, 'save');
        logger.debug('Recorded interaction for already-saved post');
      } catch (error) {
        logger.warn('Failed to record interaction for already-saved post', error);
      }
      
      return res.json({ message: 'Post already saved' });
    }

    logger.debug(`User ${userId} saving post ${postId} (not already saved)`);

    // Create save record
    await Bookmark.create({ userId, postId });

    // Also update post metadata.savedBy for consistency
    await Post.findByIdAndUpdate(
      postId,
      {
        $addToSet: { 'metadata.savedBy': userId }
      }
    );

    // Record interaction for user preference learning
    logger.debug(`Recording interaction for user ${userId}, post ${postId}`);
    try {
      await userPreferenceService.recordInteraction(userId, postId, 'save');
      logger.debug('Successfully recorded interaction');
      // Invalidate cached feed for this user
      await feedCacheService.invalidateUserCache(userId);
    } catch (error) {
      logger.error('Failed to record interaction for preferences', error);
      // Don't fail the request if preference tracking fails, but log the error
    }

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
    const result = await Bookmark.deleteOne({ userId, postId });
    if (result.deletedCount === 0) {
      return res.json({ message: 'Post not saved' });
    }

    // Also update post metadata.savedBy for consistency
    await Post.findByIdAndUpdate(
      postId,
      {
        $pull: { 'metadata.savedBy': userId }
      }
    );

    // Invalidate cached feed for this user
    try {
      await feedCacheService.invalidateUserCache(userId);
    } catch (error) {
      logger.warn('Failed to invalidate cache', error);
    }

    res.json({ message: 'Post unsaved successfully' });
  } catch (error) {
    logger.error('Error unsaving post', error);
    res.status(500).json({ message: 'Error unsaving post' });
  }
};

// Repost
export const repostPost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

  const repostId = req.params.id as string;
    const originalPost = await Post.findById(repostId);
    if (!originalPost) {
      return res.status(404).json({ message: 'Original post not found' });
    }

    const repost = new Post({
      text: req.body.comment || '',
      userID: new mongoose.Types.ObjectId(userId),
      repost_of: new mongoose.Types.ObjectId(repostId)
    });

    await repost.save();
    await repost.populate('userID', 'username name avatar verified');

    // Record interaction for user preference learning
    try {
      await userPreferenceService.recordInteraction(userId, repostId, 'repost');
      logger.debug('Successfully recorded repost interaction');
      // Invalidate cached feed for this user
      await feedCacheService.invalidateUserCache(userId);
    } catch (error) {
      logger.warn('Failed to record repost interaction', error);
    }

    // Notify original author about repost
    try {
      const recipientId = (originalPost as any)?.oxyUserId?.toString?.() || (originalPost as any)?.oxyUserId || null;
      if (recipientId && recipientId !== userId) {
        await createNotification({
          recipientId,
          actorId: userId,
          type: 'repost',
          entityId: String(originalPost._id),
          entityType: 'post'
        });
      }
    } catch (e) {
      logger.error('Failed to create repost notification', e);
    }

    res.status(201).json(repost);
  } catch (error) {
    logger.error('Error creating repost', error);
    res.status(500).json({ message: 'Error creating repost' });
  }
};

// Quote post
export const quotePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

  const quoteId = req.params.id as string;
    const originalPost = await Post.findById(quoteId);
    if (!originalPost) {
      return res.status(404).json({ message: 'Original post not found' });
    }

    const quotePost = new Post({
      text: req.body.text,
      userID: new mongoose.Types.ObjectId(userId),
      quoted_post_id: new mongoose.Types.ObjectId(quoteId)
    });

    await quotePost.save();
    await quotePost.populate('userID', 'username name avatar verified');

    // Notify original author about quote
    try {
      const recipientId = (originalPost as any)?.oxyUserId?.toString?.() || (originalPost as any)?.oxyUserId || null;
      if (recipientId && recipientId !== userId) {
        await createNotification({
          recipientId,
          actorId: userId,
          type: 'quote',
          entityId: String(originalPost._id),
          entityType: 'post'
        });
      }
    } catch (e) {
      logger.error('Failed to create quote notification', e);
    }

    res.status(201).json(quotePost);
  } catch (error) {
    logger.error('Error creating quote post', error);
    res.status(500).json({ message: 'Error creating quote post' });
  }
};

// Get saved posts for current user
export const getSavedPosts = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const searchQuery = req.query.search as string;

    const folderFilter = req.query.folder as string | undefined;

    // Get saved post IDs for the user, optionally filtered by folder
    const bookmarkQuery: any = { userId };
    if (folderFilter) {
      bookmarkQuery.folder = folderFilter;
    }
    const savedPosts = await Bookmark.find(bookmarkQuery)
      .sort({ createdAt: -1 })
      .lean();

    const postIds = savedPosts.map(saved => saved.postId);

    // Build query for posts
    // Don't filter by visibility - users should be able to see their saved posts regardless of visibility
    const postQuery: any = {
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
export const getPostsByHashtag = async (req: AuthRequest, res: Response) => {
  try {
    const hashtag = String(req.params.hashtag);
    const cursor = req.query.cursor as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const filter: Record<string, unknown> = {
      hashtags: { $in: [hashtag.toLowerCase()] },
      status: 'published',
    };

    if (cursor) {
      filter._id = { $lt: cursor };
    }

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

// Get posts by extracted topic or entity name
export const getPostsByTopic = async (req: AuthRequest, res: Response) => {
  try {
    const topicName = String(req.params.topic);
    const cursor = req.query.cursor as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    // Lowercase match for index efficiency (topics are stored lowercase)
    const normalizedTopic = topicName.toLowerCase();

    const filter: Record<string, unknown> = {
      'extracted.topics.name': normalizedTopic,
      status: 'published',
    };

    if (cursor) {
      filter._id = { $lt: cursor };
    }

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
      userID: userId,
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
      userID: userId,
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
    const { lat, lng, radius = DEFAULT_NEARBY_RADIUS_METERS, locationType = 'content' } = req.query;
    
    if (!lat || !lng) {
      return res.status(400).json({ message: 'Latitude and longitude are required' });
    }

    const latitude = parseFloat(lat as string);
    const longitude = parseFloat(lng as string);
    const radiusMeters = parseInt(radius as string);
    const locationField = locationType === 'post' ? 'location' : 'content.location';

    if (isNaN(latitude) || isNaN(longitude) || isNaN(radiusMeters)) {
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
    const { north, south, east, west, locationType = 'content' } = req.query;
    
    if (!north || !south || !east || !west) {
      return res.status(400).json({ 
        message: 'Bounding box coordinates (north, south, east, west) are required' 
      });
    }

    const northLat = parseFloat(north as string);
    const southLat = parseFloat(south as string);
    const eastLng = parseFloat(east as string);
    const westLng = parseFloat(west as string);
    const locationField = locationType === 'post' ? 'location' : 'content.location';

    if (isNaN(northLat) || isNaN(southLat) || isNaN(eastLng) || isNaN(westLng)) {
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
    const { limit = DEFAULT_LIKES_LIMIT, cursor } = req.query as any;
    
    if (!id) {
      return res.status(400).json({ message: 'Post ID is required' });
    }

    const query: any = { postId: id };
    if (cursor) {
      query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
    }

    const likes = await Like.find(query)
      .sort({ _id: -1 })
      .limit(Number(limit) + 1)
      .lean();

    const hasMore = likes.length > Number(limit);
    const likesToReturn = hasMore ? likes.slice(0, Number(limit)) : likes;
    const nextCursor = hasMore ? likes[Number(limit) - 1]._id.toString() : undefined;

    // Get unique user IDs
    const userIds = [...new Set(likesToReturn.map(like => like.userId))];

    // Fetch user data from Oxy
    const users = await Promise.all(
      userIds.map(async (userId) => {
        try {
          const userData = await oxyClient.getUserById(userId);
          return {
            id: userData.id,
            name: userData.name?.full || userData.username,
            handle: userData.username,
            avatar: typeof userData.avatar === 'string' ? userData.avatar : (userData.avatar as any)?.url || '',
            verified: userData.verified || false
          };
        } catch (error) {
          logger.error(`Error fetching user ${userId}`, error);
          return {
            id: userId,
            name: 'User',
            handle: 'user',
            avatar: '',
            verified: false
          };
        }
      })
    );

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

// Get users who reposted a post
export const getPostReposts = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { limit = DEFAULT_LIKES_LIMIT, cursor } = req.query as any;
    
    if (!id) {
      return res.status(400).json({ message: 'Post ID is required' });
    }

    const query: any = { repostOf: id, visibility: PostVisibility.PUBLIC };
    if (cursor) {
      query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
    }

    const reposts = await Post.find(query)
      .sort({ _id: -1 })
      .limit(Number(limit) + 1)
      .select('oxyUserId createdAt')
      .lean();

    const hasMore = reposts.length > Number(limit);
    const repostsToReturn = hasMore ? reposts.slice(0, Number(limit)) : reposts;
    const nextCursor = hasMore ? reposts[Number(limit) - 1]._id.toString() : undefined;

    // Get unique user IDs
    const userIds = [...new Set(repostsToReturn.map(repost => repost.oxyUserId))];

    // Fetch user data from Oxy
    const users = await Promise.all(
      userIds.map(async (userId) => {
        try {
          const userData = await oxyClient.getUserById(userId);
          return {
            id: userData.id,
            name: userData.name?.full || userData.username,
            handle: userData.username,
            avatar: typeof userData.avatar === 'string' ? userData.avatar : (userData.avatar as any)?.url || '',
            verified: userData.verified || false
          };
        } catch (error) {
          logger.error(`Error fetching user ${userId}`, error);
          return {
            id: userId,
            name: 'User',
            handle: 'user',
            avatar: '',
            verified: false
          };
        }
      })
    );

    res.json({
      users,
      hasMore,
      nextCursor,
      totalCount: repostsToReturn.length
    });
  } catch (error) {
    logger.error('Error fetching post reposts', error);
    res.status(500).json({ message: 'Error fetching post reposts' });
  }
};

export const getNearbyPostsBothLocations = async (req: AuthRequest, res: Response) => {
  try {
    const { lat, lng, radius = 10000 } = req.query; // radius in meters, default 10km
    
    if (!lat || !lng) {
      return res.status(400).json({ message: 'Latitude and longitude are required' });
    }

    const latitude = parseFloat(lat as string);
    const longitude = parseFloat(lng as string);
    const radiusMeters = parseInt(radius as string);

    if (isNaN(latitude) || isNaN(longitude) || isNaN(radiusMeters)) {
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

    // Get current user for liked/saved status
    const currentUserId = req.user?.id;
    let savedPostIds: string[] = [];
    let likedPostIds: string[] = [];
    
    if (currentUserId) {
      const savedPosts = await Bookmark.find({ userId: currentUserId }).lean();
      savedPostIds = savedPosts.map(saved => saved.postId.toString());

      const likedPosts = await Like.find({ userId: currentUserId }).lean();
      likedPostIds = likedPosts.map(liked => liked.postId.toString());
    }

    // Transform posts to match frontend expectations
    const transformedPosts = posts.map((post: any) => {
      const userData = post.oxyUserId;
      return {
        ...post,
        user: {
          id: typeof userData === 'object' ? userData._id : userData,
          name: typeof userData === 'object' ? userData.name?.full : 'Unknown User',
          handle: typeof userData === 'object' ? userData.username : 'unknown',
          avatar: typeof userData === 'object' ? userData.avatar : '',
          verified: typeof userData === 'object' ? userData.verified : false
        },
        isLiked: likedPostIds.includes(post._id.toString()),
        isSaved: savedPostIds.includes(post._id.toString())
      };
    });

    // Remove oxyUserId from response
    transformedPosts.forEach(post => delete post.oxyUserId);

    res.json({
      posts: transformedPosts,
      center: { latitude, longitude },
      radius: radiusMeters,
      locationType: 'both',
      count: transformedPosts.length
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

    const post = await Post.findById(id).select('content.text translations').lean();
    if (!post) {
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
