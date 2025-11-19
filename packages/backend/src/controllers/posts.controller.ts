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
import { feedController } from './feed.controller';
import { userPreferenceService } from '../services/UserPreferenceService';
import { feedCacheService } from '../services/FeedCacheService';
import ArticleModel from '../models/Article';
import { logger } from '../utils/logger';

const sanitizeSources = (arr: any): Array<{ url: string; title?: string }> => {
  if (!Array.isArray(arr)) return [];

  const MAX_SOURCES = 5;

  const normalized = arr
    .map((item: any) => {
      if (!item) return null;
      const rawUrl = typeof item === 'string' ? item : item.url;
      if (!rawUrl || typeof rawUrl !== 'string') return null;

      const urlTrimmed = rawUrl.trim();
      if (!urlTrimmed) return null;

      try {
        const parsed = new URL(urlTrimmed);
        const normalizedUrl = parsed.toString();
        const title = typeof item?.title === 'string' ? item.title.trim().slice(0, 200) : undefined;
        return title ? { url: normalizedUrl, title } : { url: normalizedUrl };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Array<{ url: string; title?: string }>;

  return normalized.slice(0, MAX_SOURCES);
};

const sanitizeArticle = (input: any): { title?: string; body?: string } | undefined => {
  if (!input || typeof input !== 'object') return undefined;
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 280) : undefined;
  const body = typeof input.body === 'string' ? input.body.trim() : undefined;
  if (!title && !body) return undefined;
  return { ...(title ? { title } : {}), ...(body ? { body } : {}) };
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

const ATTACHMENT_TYPES: PostAttachmentType[] = ['media', 'poll', 'article', 'location', 'sources'];

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
  includeLocation?: boolean;
  includeSources?: boolean;
}

const buildOrderedAttachments = ({
  rawAttachments,
  media,
  includePoll = false,
  includeArticle = false,
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

    const { content, hashtags, mentions, quoted_post_id, repost_of, in_reply_to_status_id, parentPostId, threadId, contentLocation, postLocation, replyPermission, reviewReplies, status: incomingStatus, scheduledFor } = req.body;

    // Support both new content structure and legacy text/media structure
    const text = content?.text || req.body.text;
    const media = content?.media || content?.images || req.body.media; // Support both new media field and legacy images
    const video = content?.video;
    const poll = content?.poll;
    const contentLocationData = content?.location || contentLocation;


    // Extract hashtags from text if not provided
    const extractedTags = Array.from((text || '').matchAll(/#([A-Za-z0-9_]+)/g) as Iterable<RegExpMatchArray>).map((m) => m[1].toLowerCase());
    const uniqueTags = Array.from(new Set([...(hashtags || []), ...extractedTags]));

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
      
      try {
        const pollDoc = new Poll({
          question: poll.question,
          options: poll.options.map((option: string) => ({ text: option, votes: [] })),
          postId: 'temp_' + Date.now(), // Temporary ID, will be updated after post creation
          createdBy: userId,
          endsAt: new Date(poll.endTime || Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days default
          isMultipleChoice: poll.isMultipleChoice || false,
          isAnonymous: poll.isAnonymous || false
        });
        
        const savedPoll = await pollDoc.save();
        pollId = String(savedPoll._id);
        postContent.pollId = pollId;
        
      } catch (pollError) {
        logger.error('Failed to create poll', pollError);
        return res.status(400).json({ message: 'Failed to create poll', error: pollError });
      }
    }

    // Add location if provided
    if (processedContentLocation) {
      postContent.location = processedContentLocation;
    }

    const sources = sanitizeSources(content?.sources || req.body.sources);
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
        excerpt: sanitizedArticle.body ? sanitizedArticle.body.slice(0, 280) : undefined,
      };
    }

    const attachmentsInput = content?.attachments || content?.attachmentOrder || req.body.attachments || req.body.attachmentOrder;
    const computedAttachments = buildOrderedAttachments({
      rawAttachments: attachmentsInput || postContent.attachments,
      media: Array.isArray(postContent.media) ? postContent.media : [],
      includePoll: Boolean(postContent.pollId),
      includeArticle: Boolean(postContent.article),
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
      replyPermission: replyPermission || 'anyone',
      reviewReplies: reviewReplies || false,
      status: postStatus,
      scheduledFor: scheduledForDate || undefined,
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

      // Reply notification if replying to an existing post
      try {
        const replyParentId = parentPostId || in_reply_to_status_id || null;
        if (replyParentId) {
          const parent = await Post.findById(replyParentId).lean();
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
      } catch (e) {
        logger.error('Failed to create reply notification', e);
      }

      // Quote and Repost notifications if created via this endpoint
      try {
        if (quoted_post_id) {
          const original = await Post.findById(quoted_post_id).lean();
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
        if (repost_of) {
          const original = await Post.findById(repost_of).lean();
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
      } catch (e) {
        logger.error('Failed to create quote/repost notification', e);
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
    
    res.status(201).json({ success: true, post: transformedPost });
  } catch (error) {
    logger.error('Error creating post', error);
    res.status(500).json({ message: 'Error creating post', error });
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

    for (let i = 0; i < posts.length; i++) {
      const postData = posts[i];
      const { content, hashtags, mentions, visibility, replyPermission, reviewReplies } = postData;

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

      const sources = sanitizeSources(content?.sources);
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
            excerpt: sanitizedArticle.body ? sanitizedArticle.body.slice(0, 280) : undefined,
          };
        }
      }

      // Handle poll creation
      let pollId = null;
      if (content?.poll) {
        const poll = content.poll;
        const newPoll = new Poll({
          question: poll.question || 'Poll',
          options: poll.options || [],
          endTime: poll.endTime || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          votes: poll.votes || {},
          userVotes: poll.userVotes || {},
          createdBy: userId
        });
        await newPoll.save();
        pollId = String(newPoll._id);
        postContent.pollId = pollId;
      }

      // Extract hashtags from text
      const text = content?.text || '';
      const extractedTags = Array.from(text.matchAll(/#([A-Za-z0-9_]+)/g) as Iterable<RegExpMatchArray>).map((m) => m[1].toLowerCase());
      const uniqueTags = Array.from(new Set([...(hashtags || []), ...extractedTags]));

      // Create post
      const attachmentsInput = content?.attachments || content?.attachmentOrder || postData.attachments || postData.attachmentOrder;
      const computedAttachments = buildOrderedAttachments({
        rawAttachments: attachmentsInput || postContent.attachments,
        media: Array.isArray(postContent.media) ? postContent.media : [],
        includePoll: Boolean(postContent.pollId),
        includeArticle: Boolean(postContent.article),
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
        replyPermission: replyPermission || 'anyone',
        reviewReplies: reviewReplies || false,
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
        console.error('Failed to create mention notifications (thread):', e);
      }

      // Update poll's postId
      if (pollId) {
        await Poll.findByIdAndUpdate(pollId, { postId: String(post._id) });
      }

      // Store the first post ID as the main post for thread linking
      if (i === 0) {
        mainPostId = String(post._id);
      }

      // Fetch user data from Oxy
      let userData: any = null;
      try {
        userData = await oxyClient.getUserById(userId);
      } catch (error) {
        logger.error('Failed to fetch user data from Oxy for thread post', error);
      }

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
    res.status(201).json({ success: true, posts: createdPosts });
  } catch (error) {
    logger.error('Error creating thread', error);
    res.status(500).json({ message: 'Error creating thread', error });
  }
};

// Get all posts
export const getPosts = async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const currentUserId = req.user?.id;

    const posts = await Post.find({ visibility: 'public', status: 'published' })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Get saved status for current user if authenticated
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
      const isSaved = savedPostIds.includes(post._id.toString());
      const isLiked = likedPostIds.includes(post._id.toString());

      const metadata = {
        ...(post.metadata || {}),
        isSaved,
        isLiked
      } as any;

      if (isLiked && currentUserId) {
        const likedSet = new Set(
          Array.isArray(metadata.likedBy)
            ? metadata.likedBy.map((id: any) => id?.toString?.() || String(id))
            : []
        );
        likedSet.add(currentUserId);
        metadata.likedBy = Array.from(likedSet);
      }

      return {
        ...post,
        user: {
          id: typeof userData === 'object' ? userData._id : userData,
          name: typeof userData === 'object' ? userData.name?.full : 'Unknown User',
          handle: typeof userData === 'object' ? userData.username : 'unknown',
          avatar: typeof userData === 'object' ? userData.avatar : '',
          verified: typeof userData === 'object' ? userData.verified : false
        },
        isSaved,
        isLiked,
        metadata,
        oxyUserId: undefined
      };
    });

    res.json({
      posts: transformedPosts,
      hasMore: posts.length === limit,
      page,
      limit
    });
  } catch (error) {
    logger.error('Error fetching posts', error);
    res.status(500).json({ message: 'Error fetching posts', error });
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

    // Check if current user has saved/liked this post
    let isSaved = false;
    let isLiked = false;
    if (currentUserId) {
      const savedPost = await Bookmark.findOne({ userId: currentUserId, postId: post._id.toString() });
      isSaved = !!savedPost;

      // Use Like collection instead of metadata.likedBy (more efficient)
      const likedPost = await Like.findOne({ userId: currentUserId, postId: post._id.toString() }).lean();
      isLiked = !!likedPost;
    }

    // Check if this post is a thread (has replies from the same user)
    let isThread = false;
    try {
      const repliesFromSameUser = await Post.findOne({
        parentPostId: post._id.toString(),
        oxyUserId: post.oxyUserId
      }).lean();
      isThread = !!repliesFromSameUser;
    } catch (e) {
      logger.error('Error checking if post is thread', e);
    }

    // Transform post to match frontend expectations
    const oxyUserId = post.oxyUserId as any;

    // Build user object; fetch from Oxy when we only have an ID string
    let user = {
      id: typeof oxyUserId === 'object' ? oxyUserId._id : (oxyUserId || 'unknown'),
      name: typeof oxyUserId === 'object' ? oxyUserId.name.full : 'User',
      handle: typeof oxyUserId === 'object' ? oxyUserId.username : 'user',
      avatar: typeof oxyUserId === 'object' ? oxyUserId.avatar : '',
      verified: typeof oxyUserId === 'object' ? !!oxyUserId.verified : false,
    } as any;

    if (oxyUserId && typeof oxyUserId === 'string') {
      try {
        const fetched = await oxyClient.getUserById(oxyUserId);
        user = {
          id: fetched.id,
          name: fetched.name?.full || fetched.username || 'User',
          handle: fetched.username || 'user',
          avatar: typeof fetched.avatar === 'string' ? fetched.avatar : (fetched.avatar as any)?.url || '',
          verified: !!fetched.verified,
        };
      } catch (e) {
        // keep fallback user
        logger.error(`Failed fetching user from Oxy for post ${req.params.id}`, e);
      }
    }

    const transformedPost = {
      ...post,
      user,
      isSaved,
      isLiked,
      isThread,
      metadata: {
        ...(post.metadata || {}),
        isSaved,
        isLiked,
      },
      oxyUserId: undefined,
    } as any;

    res.json(transformedPost);
  } catch (error) {
    logger.error('Error fetching post', error);
    res.status(500).json({ message: 'Error fetching post', error });
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

    const { text, media, hashtags, mentions, contentLocation, postLocation, sources } = req.body;
    
    if (text !== undefined) {
      post.content.text = text;
      // Re-extract hashtags when text changes
      const extractedTags = Array.from((text || '').matchAll(/#([A-Za-z0-9_]+)/g) as Iterable<RegExpMatchArray>).map((m) => m[1].toLowerCase());
      const uniqueTags = Array.from(new Set([...(hashtags || post.hashtags || []), ...extractedTags]));
      post.hashtags = uniqueTags;
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
      const sanitized = sanitizeSources(sources);
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

    // Transform the response to match frontend expectations
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
    res.status(500).json({ message: 'Error updating post', error });
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

    try {
      const articleId = (post as any)?.content?.article?.articleId;
      if (articleId) {
        await (ArticleModel as any).deleteOne({ _id: articleId } as any).exec();
      }
    } catch (articleError) {
      logger.error('Failed to delete article content with post', articleError);
    }

    res.json({ message: 'Post deleted successfully' });
  } catch (error) {
    logger.error('Error deleting post', error);
    res.status(500).json({ message: 'Error deleting post', error });
  }
};

// Like post
export const likePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const postId = req.params.id;

    logger.debug(`Like request received: userId=${userId}, postId=${postId}`);

    // Check if already liked
    const existingLike = await Like.findOne({ userId, postId });
    if (existingLike) {
      logger.debug(`Post ${postId} already liked by user ${userId}`);
      const currentPost = await Post.findById(postId).select('stats.likesCount metadata.likedBy').lean();
      
      // Still record the interaction even if already liked (user expressed interest)
      try {
        await userPreferenceService.recordInteraction(userId, postId, 'like');
        logger.debug('Recorded interaction for already-liked post');
      } catch (error) {
        logger.warn('Failed to record interaction for already-liked post', error);
      }
      
      return res.json({ 
        message: 'Post already liked',
        likesCount: currentPost?.stats?.likesCount ?? 0,
        liked: true
      });
    }

    logger.debug(`User ${userId} liking post ${postId} (not already liked)`);

    // Create like record (legacy tracking)
    await Like.create({ userId, postId });

    // Update post stats only (use Like collection as source of truth, not metadata.likedBy)
    const likedPost = await Post.findByIdAndUpdate(
      postId,
      {
        $inc: { 'stats.likesCount': 1 }
      },
      { new: true }
    ).lean();

    // Record interaction for user preference learning
    logger.debug(`Recording interaction for user ${userId}, post ${postId}`);
    try {
      await userPreferenceService.recordInteraction(userId, postId, 'like');
      logger.debug('Successfully recorded interaction');
      // Invalidate cached feed for this user
      await feedCacheService.invalidateUserCache(userId);
    } catch (error) {
      logger.error('Failed to record interaction for preferences', error);
      // Don't fail the request if preference tracking fails, but log the error
    }

    // Create like notification to the post author
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

    const likesCount = likedPost?.stats?.likesCount ?? 0;

    res.json({ 
      message: 'Post liked successfully',
      likesCount,
      liked: true
    });
  } catch (error) {
    logger.error('Error liking post', error);
    res.status(500).json({ message: 'Error liking post', error });
  }
};

// Unlike post
export const unlikePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const postId = req.params.id;

    // Remove like record
    const result = await Like.deleteOne({ userId, postId });
    if (result.deletedCount === 0) {
      const currentPost = await Post.findById(postId).select('stats.likesCount metadata.likedBy').lean();
      return res.json({ 
        message: 'Post not liked',
        likesCount: currentPost?.stats?.likesCount ?? 0,
        liked: false
      });
    }

    // Update post stats only (use Like collection as source of truth, not metadata.likedBy)
    const updatedPost = await Post.findByIdAndUpdate(
      postId,
      {
        $inc: { 'stats.likesCount': -1 }
      },
      { new: true }
    ).lean();

    // Invalidate cached feed for this user
    try {
      await feedCacheService.invalidateUserCache(userId);
    } catch (error) {
      logger.warn('Failed to invalidate cache', error);
    }

    let likesCount = updatedPost?.stats?.likesCount ?? 0;
    if (likesCount < 0) {
      likesCount = 0;
      await Post.findByIdAndUpdate(postId, { $set: { 'stats.likesCount': 0 } });
    }

    res.json({ 
      message: 'Post unliked successfully',
      likesCount,
      liked: false
    });
  } catch (error) {
    logger.error('Error unliking post', error);
    res.status(500).json({ message: 'Error unliking post', error });
  }
};

// Save post
export const savePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const postId = req.params.id;

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
    res.status(500).json({ message: 'Error saving post', error });
  }
};

// Unsave post
export const unsavePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const postId = req.params.id;

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
    res.status(500).json({ message: 'Error unsaving post', error });
  }
};

// Repost
export const repostPost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

  const originalPost = await Post.findById(req.params.id);
    if (!originalPost) {
      return res.status(404).json({ message: 'Original post not found' });
    }

    const repost = new Post({
      text: req.body.comment || '',
      userID: new mongoose.Types.ObjectId(userId),
      repost_of: new mongoose.Types.ObjectId(req.params.id)
    });

    await repost.save();
    await repost.populate('userID', 'username name avatar verified');

    // Record interaction for user preference learning
    try {
      await userPreferenceService.recordInteraction(userId, req.params.id, 'repost');
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
    res.status(500).json({ message: 'Error creating repost', error });
  }
};

// Quote post
export const quotePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

  const originalPost = await Post.findById(req.params.id);
    if (!originalPost) {
      return res.status(404).json({ message: 'Original post not found' });
    }

    const quotePost = new Post({
      text: req.body.text,
      userID: new mongoose.Types.ObjectId(userId),
      quoted_post_id: new mongoose.Types.ObjectId(req.params.id)
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
    res.status(500).json({ message: 'Error creating quote post', error });
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
    const limit = parseInt(req.query.limit as string) || 20;
    const searchQuery = req.query.search as string;

    // Get saved post IDs for the user
    const savedPosts = await Bookmark.find({ userId })
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

    // Use feed controller's transformPostsWithProfiles to ensure mentions are transformed
    // This handles user profiles, engagement stats, like status, and mention transformation
    // This matches the transformation used in the feed endpoint
    const transformedPosts = await (feedController as any).transformPostsWithProfiles(posts, userId);
    
    // Ensure all posts are marked as saved
    transformedPosts.forEach((post: any) => {
      post.isSaved = true;
      if (post.metadata) {
        post.metadata.isSaved = true;
      } else {
        post.metadata = { isSaved: true };
      }
    });

    res.json({
      posts: transformedPosts,
      hasMore: posts.length === limit,
      page,
      limit
    });
  } catch (error) {
    logger.error('Error fetching saved posts', error);
    res.status(500).json({ message: 'Error fetching saved posts', error });
  }
};

// Get posts by hashtag
export const getPostsByHashtag = async (req: Request, res: Response) => {
  try {
    const hashtag = req.params.hashtag;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    const posts = await Post.find({
      hashtags: { $in: [hashtag] },
      status: 'published'
    })
      .sort({ created_at: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('userID', 'username name avatar verified')
      .lean();

    res.json({
      posts,
      hashtag,
      hasMore: posts.length === limit,
      page,
      limit
    });
  } catch (error) {
    logger.error('Error fetching posts by hashtag', error);
    res.status(500).json({ message: 'Error fetching posts by hashtag', error });
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
    res.status(500).json({ message: 'Error fetching drafts', error });
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
    res.status(500).json({ message: 'Error fetching scheduled posts', error });
  }
}; 

// Get nearby posts based on location
export const getNearbyPosts = async (req: AuthRequest, res: Response) => {
  try {
    const { lat, lng, radius = 10000, locationType = 'content' } = req.query; // radius in meters, default 10km
    
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
      .limit(50) // Limit to prevent too many results
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
      locationType,
      count: transformedPosts.length
    });
  } catch (error) {
    logger.error('Error fetching nearby posts', error);
    res.status(500).json({ message: 'Error fetching nearby posts', error });
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
      .limit(100) // Limit to prevent too many results
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
      boundingBox: { north: northLat, south: southLat, east: eastLng, west: westLng },
      locationType,
      count: transformedPosts.length
    });
  } catch (error) {
    logger.error('Error fetching posts in area', error);
    res.status(500).json({ message: 'Error fetching posts in area', error });
  }
};

// Get nearby posts based on both user and post locations
// Get users who liked a post
export const getPostLikes = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { limit = 50, cursor } = req.query as any;
    
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
    res.status(500).json({ message: 'Error fetching post likes', error });
  }
};

// Get users who reposted a post
export const getPostReposts = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { limit = 50, cursor } = req.query as any;
    
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
    res.status(500).json({ message: 'Error fetching post reposts', error });
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
    res.status(500).json({ message: 'Error fetching nearby posts (both locations)', error });
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
    res.status(500).json({ message: 'Error fetching location stats', error });
  }
};
