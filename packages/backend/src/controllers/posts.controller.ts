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
import { PostVisibility } from '@mention/shared-types';
import { feedController } from './feed.controller';
import { userPreferenceService } from '../services/UserPreferenceService';
import { feedCacheService } from '../services/FeedCacheService';

// Create a new post
export const createPost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { content, hashtags, mentions, quoted_post_id, repost_of, in_reply_to_status_id, parentPostId, threadId, contentLocation, postLocation } = req.body;

    // Support both new content structure and legacy text/media structure
    const text = content?.text || req.body.text;
    const media = content?.media || content?.images || req.body.media; // Support both new media field and legacy images
    const video = content?.video;
    const poll = content?.poll;
    const contentLocationData = content?.location || contentLocation;


    // Extract hashtags from text if not provided
    const extractedTags = Array.from((text || '').matchAll(/#([A-Za-z0-9_]+)/g)).map(m => m[1].toLowerCase());
    const uniqueTags = Array.from(new Set([...(hashtags || []), ...extractedTags]));

    const normalizeMedia = (arr: any[]): any[] => {
      if (!Array.isArray(arr)) return [];
      return arr.map((m: any) => {
        if (typeof m === 'string') return { id: m, type: 'image' };
        if (m && typeof m === 'object') return { id: m.id || m.fileId || m._id, type: m.type || 'image', mime: m.mime || m.contentType };
        return null;
      }).filter(Boolean);
    };

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
        console.log('📍 Received legacy format post location');
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

    // Build complete content object
    const postContent: any = {
      text: text || '',
      media: normalizeMedia(media || [])
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
        pollId = savedPoll._id.toString();
        postContent.pollId = pollId;
        
      } catch (pollError) {
        console.error('Failed to create poll:', pollError);
        return res.status(400).json({ message: 'Failed to create poll', error: pollError });
      }
    }

    // Add location if provided
    if (processedContentLocation) {
      postContent.location = processedContentLocation;
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
      stats: {
        likesCount: 0,
        repostsCount: 0,
        commentsCount: 0,
        viewsCount: 0,
        sharesCount: 0
      }
    });

  await post.save();
    
    // Update poll's postId with the actual post ID
    if (pollId) {
      try {
        await Poll.findByIdAndUpdate(pollId, { postId: post._id.toString() });
      } catch (pollUpdateError) {
        console.error('Failed to update poll postId:', pollUpdateError);
        // Continue execution - post was created successfully
      }
    }
    
    // No populate needed since oxyUserId is just a string reference

    // Transform the response to match frontend expectations
    const transformedPost = post.toObject() as any;
    transformedPost.id = post._id.toString(); // Add string ID for frontend
    const userData = transformedPost.oxyUserId;
    
    transformedPost.user = {
        id: typeof userData === 'object' ? userData._id : userData,
        name: typeof userData === 'object' ? userData.name.full : 'Unknown User',
        handle: typeof userData === 'object' ? userData.username : 'unknown',
        avatar: typeof userData === 'object' ? userData.avatar : '',
        verified: typeof userData === 'object' ? userData.verified : false
    };
    delete transformedPost.oxyUserId;

    // Fire mention notifications if any
    try {
      if (mentions && mentions.length > 0) {
        const isReply = Boolean(parentPostId || in_reply_to_status_id);
        await createMentionNotifications(
          mentions,
          post._id.toString(),
          userId,
          isReply ? 'reply' : 'post'
        );
      }
    } catch (e) {
      console.error('Failed to create mention notifications:', e);
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
            entityId: post._id.toString(),
            entityType: 'reply'
          });
        }
      }
    } catch (e) {
      console.error('Failed to create reply notification:', e);
    }

  // Quote and Repost notifications if created via this endpoint
    try {
      if (quoted_post_id) {
        const original = await Post.findById(quoted_post_id).lean();
        const recipientId = original?.oxyUserId?.toString?.() || (original as any)?.oxyUserId || null;
        if (recipientId && recipientId !== userId) {
          await createNotification({
            recipientId,
            actorId: userId,
            type: 'quote',
            entityId: original._id.toString(),
            entityType: 'post'
          });
        }
      }
      if (repost_of) {
        const original = await Post.findById(repost_of).lean();
        const recipientId = original?.oxyUserId?.toString?.() || (original as any)?.oxyUserId || null;
        if (recipientId && recipientId !== userId) {
          await createNotification({
            recipientId,
            actorId: userId,
            type: 'repost',
            entityId: original._id.toString(),
            entityType: 'post'
          });
        }
      }
    } catch (e) {
      console.error('Failed to create quote/repost notification:', e);
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
              entityId: post._id.toString(),
              entityType: 'post' as const,
            }));
          if (notifications.length) {
            await createBatchNotifications(notifications, true);
          }
        }
      }
    } catch (e) {
      console.error('Failed to notify subscribers about new post:', e);
    }

    res.status(201).json({ success: true, post: transformedPost });
  } catch (error) {
    console.error('Error creating post:', error);
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

    console.log('🧵 Creating thread with body:', JSON.stringify(req.body, null, 2));

    const { mode, posts } = req.body;

    if (!Array.isArray(posts) || posts.length === 0) {
      return res.status(400).json({ message: 'Posts array is required and cannot be empty' });
    }

    const createdPosts = [];
    let mainPostId: string | null = null;

    for (let i = 0; i < posts.length; i++) {
      const postData = posts[i];
      const { content, hashtags, mentions, visibility } = postData;

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
        media: content?.media || []
      };

      if (processedContentLocation) {
        postContent.location = processedContentLocation;
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
        pollId = newPoll._id.toString();
        postContent.pollId = pollId;
      }

      // Extract hashtags from text
      const text = content?.text || '';
      const extractedTags = Array.from(text.matchAll(/#([A-Za-z0-9_]+)/g)).map(m => m[1].toLowerCase());
      const uniqueTags = Array.from(new Set([...(hashtags || []), ...extractedTags]));

      // Create post
      const post = new Post({
        oxyUserId: userId,
        content: postContent,
        hashtags: uniqueTags,
        mentions: mentions || [],
        visibility: (visibility as PostVisibility) || PostVisibility.PUBLIC,
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
        await Poll.findByIdAndUpdate(pollId, { postId: post._id.toString() });
      }

      // Store the first post ID as the main post for thread linking
      if (i === 0) {
        mainPostId = post._id.toString();
      }

      // Transform response
      const transformedPost = post.toObject() as any;
      transformedPost.id = post._id.toString();
      transformedPost.user = {
        id: userId,
        name: 'User', // This would normally come from Oxy user data
        handle: 'user',
        avatar: '',
        verified: false
      };
      delete transformedPost.oxyUserId;

      createdPosts.push(transformedPost);
    }

    console.log(`✅ Created ${createdPosts.length} posts in ${mode} mode`);
    res.status(201).json(createdPosts);
  } catch (error) {
    console.error('Error creating thread:', error);
    res.status(500).json({ message: 'Error creating thread', error });
  }
};

// Get all posts
export const getPosts = async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const currentUserId = req.user?.id;

    const posts = await Post.find({ visibility: 'public' })
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
    console.error('Error fetching posts:', error);
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

      const likedBy = Array.isArray((post as any)?.metadata?.likedBy)
        ? (post as any).metadata.likedBy
        : [];
      isLiked = likedBy.some((id: any) => id?.toString?.() === currentUserId);
      let backfilledLike = false;
      if (!isLiked) {
        const likedPost = await Like.findOne({ userId: currentUserId, postId: post._id.toString() }).lean();
        if (likedPost) {
          isLiked = true;
          backfilledLike = true;
        }
      }

      if (backfilledLike) {
        try {
          await Post.updateOne(
            { _id: post._id },
            { $addToSet: { 'metadata.likedBy': currentUserId } }
          );
        } catch (syncError) {
          console.warn('Failed to backfill metadata.likedBy during getPostById:', syncError);
        }
      }
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
      console.error('Error checking if post is thread:', e);
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
        console.error('Failed fetching user from Oxy for post', req.params.id, e);
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
    console.error('Error fetching post:', error);
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

    const { text, media, hashtags, mentions, contentLocation, postLocation } = req.body;
    
    if (text !== undefined) {
      post.content.text = text;
      // Re-extract hashtags when text changes
      const extractedTags = Array.from((text || '').matchAll(/#([A-Za-z0-9_]+)/g)).map(m => m[1].toLowerCase());
      const uniqueTags = Array.from(new Set([...(hashtags || post.hashtags || []), ...extractedTags]));
      post.hashtags = uniqueTags;
    }
    if (media !== undefined) {
      const normalizeMedia = (arr: any[]): any[] => {
        if (!Array.isArray(arr)) return [];
        return arr.map((m: any) => {
          if (typeof m === 'string') return { id: m, type: 'image' };
          if (m && typeof m === 'object') return { id: m.id || m.fileId || m._id, type: m.type || 'image', mime: m.mime || m.contentType };
          return null;
        }).filter(Boolean);
      };
      post.content.media = normalizeMedia(media);
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
    console.error('Error updating post:', error);
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

    res.json({ message: 'Post deleted successfully' });
  } catch (error) {
    console.error('Error deleting post:', error);
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

    console.log(`[Posts Controller] Like request received: userId=${userId}, postId=${postId}`);

    // Check if already liked
    const existingLike = await Like.findOne({ userId, postId });
    if (existingLike) {
      console.log(`[Posts Controller] Post ${postId} already liked by user ${userId}`);
      const currentPost = await Post.findById(postId).select('stats.likesCount metadata.likedBy').lean();
      
      // Still record the interaction even if already liked (user expressed interest)
      try {
        await userPreferenceService.recordInteraction(userId, postId, 'like');
        console.log(`[Posts Controller] Recorded interaction for already-liked post`);
      } catch (error) {
        console.warn(`[Posts Controller] Failed to record interaction for already-liked post:`, error);
      }
      
      return res.json({ 
        message: 'Post already liked',
        likesCount: currentPost?.stats?.likesCount ?? 0,
        liked: true
      });
    }

    console.log(`[Posts Controller] User ${userId} liking post ${postId} (not already liked)`);

    // Create like record (legacy tracking)
    await Like.create({ userId, postId });

    // Update post stats and ensure metadata.likedBy is kept in sync
    const likedPost = await Post.findByIdAndUpdate(
      postId,
      {
        $inc: { 'stats.likesCount': 1 },
        $addToSet: { 'metadata.likedBy': userId }
      },
      { new: true }
    ).lean();

    // Record interaction for user preference learning
    console.log(`[Posts Controller] Recording interaction for user ${userId}, post ${postId}`);
    try {
      await userPreferenceService.recordInteraction(userId, postId, 'like');
      console.log(`[Posts Controller] Successfully recorded interaction`);
      // Invalidate cached feed for this user
      await feedCacheService.invalidateUserCache(userId);
    } catch (error) {
      console.error(`[Posts Controller] Failed to record interaction for preferences:`, error);
      console.error(`[Posts Controller] Error stack:`, error instanceof Error ? error.stack : 'No stack trace');
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
      console.error('Failed to create like notification:', e);
    }

    const likesCount = likedPost?.stats?.likesCount ?? 0;

    res.json({ 
      message: 'Post liked successfully',
      likesCount,
      liked: true
    });
  } catch (error) {
    console.error('Error liking post:', error);
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

    // Update post stats and keep metadata.likedBy synchronized
    const updatedPost = await Post.findByIdAndUpdate(
      postId,
      {
        $inc: { 'stats.likesCount': -1 },
        $pull: { 'metadata.likedBy': userId }
      },
      { new: true }
    ).lean();

    // Invalidate cached feed for this user
    try {
      await feedCacheService.invalidateUserCache(userId);
    } catch (error) {
      console.warn(`[Posts Controller] Failed to invalidate cache:`, error);
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
    console.error('Error unliking post:', error);
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

    console.log(`[Posts Controller] Save request received: userId=${userId}, postId=${postId}`);

    // Check if already saved
    const existingSave = await Bookmark.findOne({ userId, postId });
    if (existingSave) {
      console.log(`[Posts Controller] Post ${postId} already saved by user ${userId}`);
      
      // Still record the interaction even if already saved (user expressed interest)
      try {
        await userPreferenceService.recordInteraction(userId, postId, 'save');
        console.log(`[Posts Controller] Recorded interaction for already-saved post`);
      } catch (error) {
        console.warn(`[Posts Controller] Failed to record interaction for already-saved post:`, error);
      }
      
      return res.json({ message: 'Post already saved' });
    }

    console.log(`[Posts Controller] User ${userId} saving post ${postId} (not already saved)`);

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
    console.log(`[Posts Controller] Recording interaction for user ${userId}, post ${postId}`);
    try {
      await userPreferenceService.recordInteraction(userId, postId, 'save');
      console.log(`[Posts Controller] Successfully recorded interaction`);
      // Invalidate cached feed for this user
      await feedCacheService.invalidateUserCache(userId);
    } catch (error) {
      console.error(`[Posts Controller] Failed to record interaction for preferences:`, error);
      console.error(`[Posts Controller] Error stack:`, error instanceof Error ? error.stack : 'No stack trace');
      // Don't fail the request if preference tracking fails, but log the error
    }

    res.json({ message: 'Post saved successfully' });
  } catch (error) {
    console.error('Error saving post:', error);
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
      console.warn(`[Posts Controller] Failed to invalidate cache:`, error);
    }

    res.json({ message: 'Post unsaved successfully' });
  } catch (error) {
    console.error('Error unsaving post:', error);
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
      console.log(`[Posts Controller] Successfully recorded repost interaction`);
      // Invalidate cached feed for this user
      await feedCacheService.invalidateUserCache(userId);
    } catch (error) {
      console.warn(`[Posts Controller] Failed to record repost interaction:`, error);
    }

    // Notify original author about repost
    try {
      const recipientId = (originalPost as any)?.oxyUserId?.toString?.() || (originalPost as any)?.oxyUserId || null;
      if (recipientId && recipientId !== userId) {
        await createNotification({
          recipientId,
          actorId: userId,
          type: 'repost',
          entityId: originalPost._id.toString(),
          entityType: 'post'
        });
      }
    } catch (e) {
      console.error('Failed to create repost notification:', e);
    }

    res.status(201).json(repost);
  } catch (error) {
    console.error('Error creating repost:', error);
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
          entityId: originalPost._id.toString(),
          entityType: 'post'
        });
      }
    } catch (e) {
      console.error('Failed to create quote notification:', e);
    }

    res.status(201).json(quotePost);
  } catch (error) {
    console.error('Error creating quote post:', error);
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
      console.log(`[Saved Posts] Applying search filter: "${trimmedQuery}"`);
      // Use MongoDB $regex for partial text matching (case-insensitive)
      // Escape special regex characters but allow partial matching
      const escapedQuery = trimmedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      postQuery['content.text'] = {
        $regex: escapedQuery,
        $options: 'i' // case-insensitive
      };
      console.log(`[Saved Posts] Final query:`, JSON.stringify(postQuery, null, 2));
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
    console.error('Error fetching saved posts:', error);
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
    console.error('Error fetching posts by hashtag:', error);
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
    console.error('Error fetching drafts:', error);
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
    console.error('Error fetching scheduled posts:', error);
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
    console.error('Error fetching nearby posts:', error);
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
    console.error('Error fetching posts in area:', error);
    res.status(500).json({ message: 'Error fetching posts in area', error });
  }
};

// Get nearby posts based on both user and post locations
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
    console.error('Error fetching nearby posts (both locations):', error);
    res.status(500).json({ message: 'Error fetching nearby posts (both locations)', error });
  }
};

// Get location statistics for analytics
export const getLocationStats = async (req: AuthRequest, res: Response) => {
  try {
    // Count posts with content locations (user shared)
    const contentLocationCount = await Post.countDocuments({
      visibility: 'public',
      'content.location': { $exists: true, $ne: null }
    });

    // Count posts with post locations (creation metadata)
    const postLocationCount = await Post.countDocuments({
      visibility: 'public',
      'location': { $exists: true, $ne: null }
    });

    // Count posts with both location types
    const bothLocationsCount = await Post.countDocuments({
      visibility: 'public',
      'content.location': { $exists: true, $ne: null },
      'location': { $exists: true, $ne: null }
    });

    // Get total post count for percentage calculation
    const totalPosts = await Post.countDocuments({ visibility: 'public' });

    res.json({
      total: totalPosts,
      withContentLocation: contentLocationCount,
      withPostLocation: postLocationCount,
      withBothLocations: bothLocationsCount,
      withAnyLocation: await Post.countDocuments({
        visibility: 'public',
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
    console.error('Error fetching location stats:', error);
    res.status(500).json({ message: 'Error fetching location stats', error });
  }
};
