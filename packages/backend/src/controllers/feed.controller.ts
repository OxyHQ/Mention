import { Request, Response, NextFunction } from 'express';
import { Post } from '../models/Post';
import Like from '../models/Like';
import { 
  FeedRequest, 
  CreateReplyRequest, 
  CreateRepostRequest, 
  LikeRequest, 
  UnlikeRequest,
  FeedResponse,
  FeedType,
  Post as DomainPost,
  PostType,
  PostVisibility
} from '@mention/shared-types';
import mongoose from 'mongoose';
import { oxyClient } from '@oxyhq/services/core';
import { io } from '../../server';

interface AuthRequest extends Request {
  user?: {
    id: string;
    [key: string]: any;
  };
}

class FeedController {
  /**
   * Transform posts to include full profile data and engagement stats
   */
  private async transformPostsWithProfiles(posts: any[], currentUserId?: string): Promise<any[]> {
    try {
      // Get unique user IDs to fetch user data in batch
      const userIds = [...new Set(posts.map(post => {
        const postObj = post.toObject ? post.toObject() : post;
        return postObj.oxyUserId;
      }))];

      // Fetch user data from Oxy in parallel
      const userDataMap = new Map();
      await Promise.all(userIds.map(async (userId) => {
        try {
          if (userId) {
            const userData = await oxyClient.getUserById(userId);
            userDataMap.set(userId, {
              id: userData.id,
              name: userData.name?.full || userData.username,
              handle: userData.username,
              avatar: typeof userData.avatar === 'string' ? userData.avatar : (userData.avatar as any)?.url || '',
              verified: userData.verified || false
            });
          }
        } catch (error) {
          console.error(`Error fetching user data for ${userId}:`, error);
          // Fallback user data
          userDataMap.set(userId, {
            id: userId,
            name: 'User',
            handle: 'user',
            avatar: '',
            verified: false
          });
        }
      }));

      // Get user interaction data for current user if authenticated
      const userInteractions = new Map();
      if (currentUserId) {
        try {
          console.log('🔍 Fetching user interactions for userId:', currentUserId);
          
          // Get all post IDs
          const postIds = posts.map(post => {
            const postObj = post.toObject ? post.toObject() : post;
            return postObj._id.toString();
          });

          console.log('📝 Post IDs to check:', postIds);

          // Get all posts with their metadata to check for interactions
          const postsWithMetadata = await Post.find({
            _id: { $in: postIds }
          }).select('_id metadata.likedBy metadata.savedBy');

          console.log('📊 Posts with metadata:', postsWithMetadata.length);
          console.log('📋 Post IDs requested:', postIds);
          console.log('📋 Post IDs found:', postsWithMetadata.map(p => p._id.toString()));

          // Check likes and saves by examining the metadata arrays
          postsWithMetadata.forEach(post => {
            const postId = post._id.toString();
            const metadata = post.metadata || {};
            const likedBy = metadata.likedBy || [];
            const savedBy = metadata.savedBy || [];

            console.log(`📄 Post ${postId}: likedBy=${likedBy.length}, savedBy=${savedBy.length}`);
            console.log(`🔍 Checking if user ${currentUserId} is in likedBy:`, likedBy);
            console.log(`🔍 Checking if user ${currentUserId} is in savedBy:`, savedBy);

            // Check likes with multiple formats for robust comparison
            const userLiked = likedBy.includes(currentUserId) || 
                            likedBy.includes(currentUserId?.toString()) ||
                            likedBy.some(id => id?.toString() === currentUserId?.toString());
            
            if (userLiked) {
              console.log(`✅ User ${currentUserId} found in likedBy array`);
              userInteractions.set(postId, {
                ...userInteractions.get(postId),
                isLiked: true
              });
            }

            // Check saves with multiple formats for robust comparison  
            const userSaved = savedBy.includes(currentUserId) ||
                            savedBy.includes(currentUserId?.toString()) ||
                            savedBy.some(id => id?.toString() === currentUserId?.toString());

            if (userSaved) {
              console.log(`✅ User ${currentUserId} found in savedBy array`);
              userInteractions.set(postId, {
                ...userInteractions.get(postId),
                isSaved: true
              });
            }
          });

          // Check reposts for current user
          const repostedPosts = await Post.find({
            oxyUserId: currentUserId,
            repostOf: { $in: postIds }
          }).select('repostOf');

          console.log('🔄 Reposted posts found:', repostedPosts.length, repostedPosts.map(p => p.repostOf));

          repostedPosts.forEach(post => {
            userInteractions.set(post.repostOf, {
              ...userInteractions.get(post.repostOf),
              isReposted: true
            });
          });

          console.log('🗺️ Final user interactions map:', Object.fromEntries(userInteractions));
        } catch (error) {
          console.error('❌ Error fetching user interactions:', error);
        }
      } else {
        console.log('⚠️ No currentUserId provided, skipping user interaction checks');
      }

      // Transform posts with real user data and engagement stats
      const transformedPosts = posts.map(post => {
        const postObj = post.toObject ? post.toObject() : post;
        const userId = postObj.oxyUserId;
        const postId = postObj._id.toString();
        const userData = userDataMap.get(userId) || {
          id: userId,
          name: 'User',
          handle: 'user',
          avatar: '',
          verified: false
        };

        // Calculate engagement stats from actual database values
        // Ensure stats object exists with default values if not present
        const stats = postObj.stats || {
          likesCount: 0,
          repostsCount: 0, 
          commentsCount: 0,
          viewsCount: 0,
          sharesCount: 0
        };
        
        const engagement = {
          replies: stats.commentsCount || 0,
          reposts: stats.repostsCount || 0,
          likes: stats.likesCount || 0
        };

        console.log(`📊 Post ${postId} stats:`, {
          rawStats: postObj.stats,
          processedStats: stats,
          engagement,
          hasStats: !!postObj.stats
        });

        // Get user-specific interaction flags
        const interactions = userInteractions.get(postId) || {};
        const isLiked = interactions.isLiked || false;
        const isReposted = interactions.isReposted || false;
        const isSaved = interactions.isSaved || false;

        console.log(`🔄 Post ${postId} user interactions:`, {
          currentUserId,
          interactions,
          isLiked,
          isReposted,
          isSaved,
          hasInteractionData: userInteractions.has(postId)
        });

        const transformedPost = {
          id: postId,
          user: userData,
          content: postObj.content?.text || '',
          date: postObj.createdAt,
          engagement,
          media: postObj.content?.images || [],
          isLiked,
          isReposted,
          isSaved,
          type: postObj.type,
          visibility: postObj.visibility,
          hashtags: postObj.hashtags || [],
          mentions: postObj.mentions || [],
          parentPostId: postObj.parentPostId,
          threadId: postObj.threadId,
          repostOf: postObj.repostOf,
          quoteOf: postObj.quoteOf,
          isEdited: postObj.isEdited,
          language: postObj.language,
          stats: stats, // Use the processed stats object
          metadata: {
            ...postObj.metadata,
            isLiked,
            isReposted,
            isSaved
          }
        };

        console.log(`📄 Transformed post ${postId}:`, {
          isLiked,
          isReposted,
          isSaved,
          engagement,
          interactions
        });

        return transformedPost;
      });

      return transformedPosts;
    } catch (error) {
      console.error('Error transforming posts:', error);
      throw new Error('Failed to transform posts');
    }
  }

  /**
   * Build query based on feed type and filters
   */
  private buildFeedQuery(type: FeedType, filters?: any, currentUserId?: string): any {
    const query: any = {
      visibility: PostVisibility.PUBLIC // Only show public posts by default
    };

    // Filter by post type
    switch (type) {
      case 'posts':
        // Regular posts (not replies or reposts)
        query.type = { $in: [PostType.TEXT, PostType.IMAGE, PostType.VIDEO, PostType.POLL] };
        query.parentPostId = null; // matches null or non-existent
        query.repostOf = null;
        break;
      case 'media':
        // Media posts (images/videos) that are not replies or reposts
        query.type = { $in: [PostType.IMAGE, PostType.VIDEO] };
        query.parentPostId = null;
        query.repostOf = null;
        break;
      case 'replies':
        // Replies have a parentPostId set (not null)
        query.parentPostId = { $ne: null };
        break;
      case 'reposts':
        // Reposts have repostOf set (not null)
        query.repostOf = { $ne: null };
        break;
      case 'mixed':
      default:
        // Show all types
        break;
    }

    // Apply filters
    if (filters) {
      if (filters.includeReplies === false) {
        query.parentPostId = { $exists: false };
      }
      if (filters.includeReposts === false) {
        query.repostOf = { $exists: false };
      }
      if (filters.includeMedia === false) {
        query.type = { $nin: [PostType.IMAGE, PostType.VIDEO] };
      }
      if (filters.includeSensitive === false) {
        query['metadata.isSensitive'] = { $ne: true };
      }
      if (filters.language) {
        query.language = filters.language;
      }
      if (filters.dateFrom) {
        query.createdAt = { $gte: new Date(filters.dateFrom) };
      }
      if (filters.dateTo) {
        query.createdAt = { ...query.createdAt, $lte: new Date(filters.dateTo) };
      }
    }

    return query;
  }

  /**
   * Get main feed with pagination and real-time updates
   */
  async getFeed(req: AuthRequest, res: Response) {
    try {
      const { type = 'mixed', cursor, limit = 20, filters } = req.query as any;
      const currentUserId = req.user?.id;

      console.log('🚀 FeedController.getFeed called with:', {
        type,
        cursor,
        limit,
        filters,
        currentUserId,
        user: req.user
      });

      // Build query
      const query = this.buildFeedQuery(type, filters, currentUserId);

      // Add cursor-based pagination
      if (cursor) {
        query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
      }

      // Execute query with proper sorting and limits
      const posts = await Post.find(query)
        .sort({ createdAt: -1 })
        .limit(limit + 1) // Get one extra to check if there are more
        .lean();

      console.log('📋 Raw posts from database:', posts.length);
      if (posts.length > 0) {
        const firstPost = posts[0];
        console.log('🔍 First post structure:', {
          id: firstPost._id,
          hasStats: !!firstPost.stats,
          stats: firstPost.stats,
          hasMetadata: !!firstPost.metadata,
          metadata: firstPost.metadata
        });
      }

      // Check if there are more posts
      const hasMore = posts.length > limit;
      const postsToReturn = hasMore ? posts.slice(0, limit) : posts;
      const nextCursor = hasMore ? posts[limit - 1]._id.toString() : undefined;

      // Transform posts with user data
      const transformedPosts = await this.transformPostsWithProfiles(postsToReturn, currentUserId);

      // Emit real-time update to connected clients
      if (postsToReturn.length > 0) {
        io.emit('feed:updated', {
          type,
          posts: transformedPosts,
          timestamp: new Date().toISOString()
        });
      }

      const response: FeedResponse = {
        items: transformedPosts.map(post => ({
          id: post.id,
          type: 'post',
          data: post,
          createdAt: post.date,
          updatedAt: post.date
        })),
        hasMore,
        nextCursor,
        totalCount: transformedPosts.length
      };

      res.json(response);
    } catch (error) {
      console.error('Error fetching feed:', error);
      res.status(500).json({ 
        error: 'Failed to fetch feed',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get personalized For You feed (engagement-ranked)
   */
  async getForYouFeed(req: AuthRequest, res: Response) {
    try {
      const { cursor, limit = 20 } = req.query as any;
      const currentUserId = req.user?.id;

      // Following for personalization
      let followingIds: string[] = [];
      try {
        if (currentUserId) {
          const followingRes = await oxyClient.getUserFollowing(currentUserId);
          const followingUsers = (followingRes as any)?.following || [];
          followingIds = followingUsers.map((u: any) => u.id).filter(Boolean);
        }
      } catch (e) {
        console.error('ForYou: getUserFollowing failed; continuing without follow boost', e);
      }

      const match: any = {
        visibility: PostVisibility.PUBLIC,
        $and: [
          { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
          { $or: [{ repostOf: null }, { repostOf: { $exists: false } }] }
        ]
      };

      if (cursor) {
        match._id = { $lt: new mongoose.Types.ObjectId(cursor) };
      }

      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const posts = await Post.aggregate([
        { $match: match },
        {
          $addFields: {
            engagementScore: {
              $add: [
                { $ifNull: ['$stats.likesCount', 0] },
                { $multiply: [{ $ifNull: ['$stats.repostsCount', 0] }, 2] },
                { $multiply: [{ $ifNull: ['$stats.commentsCount', 0] }, 1.5] }
              ]
            },
            followBoost: { $cond: [{ $in: ['$oxyUserId', followingIds] }, 1.5, 1] },
            interactionBoost: {
              $cond: [
                { $or: [
                  { $in: [currentUserId || '', '$metadata.likedBy'] },
                  { $in: [currentUserId || '', '$metadata.savedBy'] }
                ]}, 1.2, 1]
            },
            recencyBoost: {
              $cond: [
                { $gte: ['$createdAt', threeDaysAgo] }, 1.3,
                { $cond: [ { $gte: ['$createdAt', sevenDaysAgo] }, 1.15, 1 ] }
              ]
            }
          }
        },
        {
          $addFields: {
            finalScore: {
              $multiply: ['$engagementScore', '$followBoost', '$interactionBoost', '$recencyBoost']
            }
          }
        },
        { $sort: { finalScore: -1, createdAt: -1 } },
        { $limit: Number(limit) + 1 }
      ]);

      const hasMore = posts.length > Number(limit);
      const postsToReturn = hasMore ? posts.slice(0, Number(limit)) : posts;
      const nextCursor = hasMore ? posts[Number(limit) - 1]._id.toString() : undefined;

      const transformedPosts = await this.transformPostsWithProfiles(postsToReturn, currentUserId);

      const response: FeedResponse = {
        items: transformedPosts.map(post => ({
          id: post.id,
          type: 'post',
          data: post,
          createdAt: post.date,
          updatedAt: post.date
        })),
        hasMore,
        nextCursor,
        totalCount: transformedPosts.length
      };

      res.json(response);
    } catch (error) {
      console.error('Error fetching For You feed:', error);
      res.status(500).json({ 
        error: 'Failed to fetch For You feed',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get Following feed (posts from accounts the user follows)
   */
  async getFollowingFeed(req: AuthRequest, res: Response) {
    try {
      const { cursor, limit = 20 } = req.query as any;
      const currentUserId = req.user?.id;
      if (!currentUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      // Get following list from Oxy
      const followingRes = await oxyClient.getUserFollowing(currentUserId);
      const rawList = Array.isArray((followingRes as any)?.following)
        ? (followingRes as any).following
        : (Array.isArray(followingRes) ? (followingRes as any) : []);
      const extracted = (rawList as any[]).map((u: any) => (
        typeof u === 'string' 
          ? u 
          : (u?.id || u?._id || u?.userId || u?.user?.id || u?.profile?.id || u?.targetId)
      ));
      const followingIds = [
        ...new Set([
          ...extracted.filter(Boolean),
          currentUserId // include user's own posts
        ])
      ];

      if (followingIds.length === 0) {
        return res.json({ items: [], hasMore: false, totalCount: 0 });
      }

      const query: any = {
        oxyUserId: { $in: followingIds },
        visibility: PostVisibility.PUBLIC,
        parentPostId: null,
        repostOf: null
      };

      if (cursor) {
        query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
      }

      const posts = await Post.find(query)
        .sort({ createdAt: -1 })
        .limit(Number(limit) + 1)
        .lean();

      const hasMore = posts.length > Number(limit);
      const postsToReturn = hasMore ? posts.slice(0, Number(limit)) : posts;
      const nextCursor = hasMore ? posts[Number(limit) - 1]._id.toString() : undefined;

      const transformedPosts = await this.transformPostsWithProfiles(postsToReturn, currentUserId);

      const response: FeedResponse = {
        items: transformedPosts.map(post => ({
          id: post.id,
          type: 'post',
          data: post,
          createdAt: post.date,
          updatedAt: post.date
        })),
        hasMore,
        nextCursor,
        totalCount: transformedPosts.length
      };

      res.json(response);
    } catch (error) {
      console.error('Error fetching Following feed:', error);
      res.status(500).json({ 
        error: 'Failed to fetch Following feed',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get explore feed (trending posts)
   */
  async getExploreFeed(req: AuthRequest, res: Response) {
    try {
      const { cursor, limit = 20 } = req.query as any;
      const currentUserId = req.user?.id;

      // Build query for trending posts (high engagement)
      const query: any = {
        visibility: PostVisibility.PUBLIC,
        parentPostId: { $exists: false },
        repostOf: { $exists: false }
      };

      if (cursor) {
        query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
      }

      // Sort by engagement score (likes + reposts + comments)
      const posts = await Post.aggregate([
        { $match: query },
        {
          $addFields: {
            engagementScore: {
              $add: [
                { $ifNull: ['$stats.likesCount', 0] },
                { $multiply: [{ $ifNull: ['$stats.repostsCount', 0] }, 2] },
                { $multiply: [{ $ifNull: ['$stats.commentsCount', 0] }, 1.5] }
              ]
            }
          }
        },
        { $sort: { engagementScore: -1, createdAt: -1 } },
        { $limit: limit + 1 }
      ]);

      const hasMore = posts.length > limit;
      const postsToReturn = hasMore ? posts.slice(0, limit) : posts;
      const nextCursor = hasMore ? posts[limit - 1]._id.toString() : undefined;

      const transformedPosts = await this.transformPostsWithProfiles(postsToReturn, currentUserId);

      const response: FeedResponse = {
        items: transformedPosts.map(post => ({
          id: post.id,
          type: 'post',
          data: post,
          createdAt: post.date,
          updatedAt: post.date
        })),
        hasMore,
        nextCursor,
        totalCount: transformedPosts.length
      };

      res.json(response);
    } catch (error) {
      console.error('Error fetching explore feed:', error);
      res.status(500).json({ 
        error: 'Failed to fetch explore feed',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get media feed (posts with images/videos)
   */
  async getMediaFeed(req: AuthRequest, res: Response) {
    try {
      const { cursor, limit = 20 } = req.query as any;
      const currentUserId = req.user?.id;

      const query: any = {
        visibility: PostVisibility.PUBLIC,
        type: { $in: [PostType.IMAGE, PostType.VIDEO] },
        parentPostId: { $exists: false },
        repostOf: { $exists: false }
      };

      if (cursor) {
        query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
      }

      const posts = await Post.find(query)
        .sort({ createdAt: -1 })
        .limit(limit + 1)
        .lean();

      const hasMore = posts.length > limit;
      const postsToReturn = hasMore ? posts.slice(0, limit) : posts;
      const nextCursor = hasMore ? posts[limit - 1]._id.toString() : undefined;

      const transformedPosts = await this.transformPostsWithProfiles(postsToReturn, currentUserId);

      const response: FeedResponse = {
        items: transformedPosts.map(post => ({
          id: post.id,
          type: 'post',
          data: post,
          createdAt: post.date,
          updatedAt: post.date
        })),
        hasMore,
        nextCursor,
        totalCount: transformedPosts.length
      };

      res.json(response);
    } catch (error) {
      console.error('Error fetching media feed:', error);
      res.status(500).json({ 
        error: 'Failed to fetch media feed',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get user profile feed
   */
  async getUserProfileFeed(req: AuthRequest, res: Response) {
    try {
      const { userId } = req.params;
      const { cursor, limit = 20, type = 'posts' } = req.query as any;
      const currentUserId = req.user?.id;

      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      // Handle Likes feed separately (posts the user liked)
      if (type === 'likes') {
        // Paginate likes by Like document _id (chronological like order)
        const likeQuery: any = { userId };
        if (cursor) {
          likeQuery._id = { $lt: new mongoose.Types.ObjectId(cursor) };
        }

        const likes = await Like.find(likeQuery)
          .sort({ _id: -1 })
          .limit(Number(limit) + 1)
          .lean();

        const hasMore = likes.length > Number(limit);
        const likesToReturn = hasMore ? likes.slice(0, Number(limit)) : likes;
        const nextCursor = hasMore ? likes[Number(limit) - 1]._id.toString() : undefined;

        const likedPostIds = likesToReturn.map(l => l.postId);
        if (likedPostIds.length === 0) {
          return res.json({ items: [], hasMore: false, nextCursor: undefined, totalCount: 0 });
        }

        const posts = await Post.find({
          _id: { $in: likedPostIds },
          visibility: PostVisibility.PUBLIC
        }).lean();

        // Preserve the like order
        const postsOrdered = likedPostIds
          .map(id => posts.find(p => p._id.toString() === id.toString()))
          .filter(Boolean) as any[];

        const transformedPosts = await this.transformPostsWithProfiles(postsOrdered, currentUserId);

        const response: FeedResponse = {
          items: transformedPosts.map(post => ({
            id: post.id,
            type: 'post',
            data: post,
            createdAt: post.date,
            updatedAt: post.date
          })),
          hasMore,
          nextCursor,
          totalCount: transformedPosts.length
        };

        return res.json(response);
      }

      const query: any = {
        oxyUserId: userId,
        visibility: PostVisibility.PUBLIC
      };

      // Filter by content type
      if (type === 'posts') {
        // Regular posts (not replies or reposts)
        query.parentPostId = null;
        query.repostOf = null;
      } else if (type === 'replies') {
        // Replies
        query.parentPostId = { $ne: null };
      } else if (type === 'media') {
        // Media-only top-level posts
        query.type = { $in: [PostType.IMAGE, PostType.VIDEO] };
        query.parentPostId = null;
        query.repostOf = null;
      } else if (type === 'reposts') {
        // Reposts only
        query.repostOf = { $ne: null };
      }

      if (cursor) {
        query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
      }

      const posts = await Post.find(query)
        .sort({ createdAt: -1 })
        .limit(limit + 1)
        .lean();

      const hasMore = posts.length > limit;
      const postsToReturn = hasMore ? posts.slice(0, limit) : posts;
      const nextCursor = hasMore ? posts[limit - 1]._id.toString() : undefined;

      const transformedPosts = await this.transformPostsWithProfiles(postsToReturn, currentUserId);

      const response: FeedResponse = {
        items: transformedPosts.map(post => ({
          id: post.id,
          type: 'post',
          data: post,
          createdAt: post.date,
          updatedAt: post.date
        })),
        hasMore,
        nextCursor,
        totalCount: transformedPosts.length
      };

      res.json(response);
    } catch (error) {
      console.error('Error fetching user profile feed:', error);
      res.status(500).json({ 
        error: 'Failed to fetch user profile feed',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Create a reply to a post
   */
  async createReply(req: AuthRequest, res: Response) {
    try {
      const { postId, content, mentions, hashtags } = req.body as CreateReplyRequest;
      const currentUserId = req.user?.id;

      if (!currentUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!content || !postId) {
        return res.status(400).json({ error: 'Content and post ID are required' });
      }

      // Create reply post
      // Extract hashtags from content
      const extractedTags = Array.from((content || '').matchAll(/#([A-Za-z0-9_]+)/g)).map(m => m[1].toLowerCase());
      const mergedTags = Array.from(new Set([...(hashtags || []), ...extractedTags]));

      const reply = new Post({
        oxyUserId: currentUserId,
        type: PostType.TEXT,
        content: { text: content },
        visibility: PostVisibility.PUBLIC,
        parentPostId: postId,
        hashtags: mergedTags,
        mentions: mentions || [],
        stats: {
          likesCount: 0,
          repostsCount: 0,
          commentsCount: 0,
          viewsCount: 0,
          sharesCount: 0
        }
      });

      await reply.save();

      // Update parent post comment count
      await Post.findByIdAndUpdate(postId, {
        $inc: { 'stats.commentsCount': 1 }
      });

      // Emit real-time update
      io.emit('post:replied', {
        postId,
        reply: reply.toObject(),
        timestamp: new Date().toISOString()
      });

      res.status(201).json({ 
        success: true, 
        reply: reply.toObject() 
      });
    } catch (error) {
      console.error('Error creating reply:', error);
      res.status(500).json({ 
        error: 'Failed to create reply',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Create a repost
   */
  async createRepost(req: AuthRequest, res: Response) {
    try {
      const { originalPostId, content, mentions, hashtags } = req.body as CreateRepostRequest;
      const currentUserId = req.user?.id;

      if (!currentUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!originalPostId) {
        return res.status(400).json({ error: 'Original post ID is required' });
      }

      // Check if user already reposted this
      const existingRepost = await Post.findOne({
        oxyUserId: currentUserId,
        repostOf: originalPostId
      });

      if (existingRepost) {
        return res.status(400).json({ error: 'You have already reposted this content' });
      }

      // Create repost
      // Extract hashtags from content
      const extractedTags = Array.from(((content as any) || '').matchAll(/#([A-Za-z0-9_]+)/g)).map(m => m[1].toLowerCase());
      const mergedTags = Array.from(new Set([...(hashtags || []), ...extractedTags]));

      const repost = new Post({
        oxyUserId: currentUserId,
        type: PostType.REPOST,
        content: { text: (content as any) || '' },
        visibility: PostVisibility.PUBLIC,
        repostOf: originalPostId,
        hashtags: mergedTags,
        mentions: mentions || [],
        stats: {
          likesCount: 0,
          repostsCount: 0,
          commentsCount: 0,
          viewsCount: 0,
          sharesCount: 0
        }
      });

      await repost.save();

      // Update original post repost count
      await Post.findByIdAndUpdate(originalPostId, {
        $inc: { 'stats.repostsCount': 1 }
      });

      // Emit real-time update
      io.emit('post:reposted', {
        originalPostId,
        repost: repost.toObject(),
        timestamp: new Date().toISOString()
      });

      res.status(201).json({ 
        success: true, 
        repost: repost.toObject() 
      });
    } catch (error) {
      console.error('Error creating repost:', error);
      res.status(500).json({ 
        error: 'Failed to create repost',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Like a post/reply/repost
   */
  async likeItem(req: AuthRequest, res: Response) {
    try {
      const { postId, type } = req.body as LikeRequest;
      const currentUserId = req.user?.id;

      if (!currentUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!postId) {
        return res.status(400).json({ error: 'Post ID is required' });
      }

      // Check if user already liked this post
      const existingPost = await Post.findById(postId);
      if (!existingPost) {
        return res.status(404).json({ error: 'Post not found' });
      }

      const alreadyLiked = existingPost.metadata?.likedBy?.includes(currentUserId);
      
      if (alreadyLiked) {
        return res.json({ 
          success: true, 
          liked: true,
          likesCount: existingPost.stats.likesCount,
          message: 'Already liked'
        });
      }

      // Update post like count and add user to likedBy array
      const updateResult = await Post.findByIdAndUpdate(
        postId,
        {
          $inc: { 'stats.likesCount': 1 },
          $addToSet: { 'metadata.likedBy': currentUserId }
        },
        { new: true }
      );

      // Emit real-time update
      io.emit('post:liked', {
        postId,
        userId: currentUserId,
        likesCount: updateResult.stats.likesCount,
        timestamp: new Date().toISOString()
      });

      res.json({ 
        success: true, 
        liked: true,
        likesCount: updateResult.stats.likesCount
      });
    } catch (error) {
      console.error('Error liking post:', error);
      res.status(500).json({ 
        error: 'Failed to like post',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Unlike a post/reply/repost
   */
  async unlikeItem(req: AuthRequest, res: Response) {
    try {
      const { postId, type } = req.body as UnlikeRequest;
      const currentUserId = req.user?.id;

      if (!currentUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!postId) {
        return res.status(400).json({ error: 'Post ID is required' });
      }

      // Check if user has liked this post
      const existingPost = await Post.findById(postId);
      if (!existingPost) {
        return res.status(404).json({ error: 'Post not found' });
      }

      const hasLiked = existingPost.metadata?.likedBy?.includes(currentUserId);
      
      if (!hasLiked) {
        return res.json({ 
          success: true, 
          liked: false,
          likesCount: existingPost.stats.likesCount,
          message: 'Not liked'
        });
      }

      // Update post like count and remove user from likedBy array
      const updateResult = await Post.findByIdAndUpdate(
        postId,
        {
          $inc: { 'stats.likesCount': -1 },
          $pull: { 'metadata.likedBy': currentUserId }
        },
        { new: true }
      );

      // Emit real-time update
      io.emit('post:unliked', {
        postId,
        userId: currentUserId,
        likesCount: updateResult.stats.likesCount,
        timestamp: new Date().toISOString()
      });

      res.json({ 
        success: true, 
        liked: false,
        likesCount: updateResult.stats.likesCount
      });
    } catch (error) {
      console.error('Error unliking post:', error);
      res.status(500).json({ 
        error: 'Failed to unlike post',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Unrepost a post
   */
  async unrepostItem(req: AuthRequest, res: Response) {
    try {
      const { postId } = req.params;
      const currentUserId = req.user?.id;

      console.log('🔄 Unrepost request:', { postId, currentUserId });

      if (!currentUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!postId) {
        return res.status(400).json({ error: 'Post ID is required' });
      }

      // Interpret :postId as the ORIGINAL post ID for unrepost operations.
      // Find and delete the repost document created by the current user that points to this original.
      const repost = await Post.findOneAndDelete({
        oxyUserId: currentUserId,
        repostOf: postId
      });

      if (!repost) {
        return res.status(404).json({ error: 'Repost not found' });
      }

      // Update original post repost count
      await Post.findByIdAndUpdate(repost.repostOf, {
        $inc: { 'stats.repostsCount': -1 }
      });

      // Emit real-time update
      io.emit('post:unreposted', {
        originalPostId: repost.repostOf,
        repostId: repost._id,
        userId: currentUserId,
        timestamp: new Date().toISOString()
      });

      res.json({
        success: true,
        message: 'Repost removed successfully'
      });
    } catch (error) {
      console.error('Error unreposting:', error);
      res.status(500).json({
        error: 'Failed to unrepost',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Save a post
   */
  async saveItem(req: AuthRequest, res: Response) {
    try {
      const { postId } = req.params;
      const currentUserId = req.user?.id;

      console.log('💾 Save endpoint called:', { postId, currentUserId, user: req.user });

      if (!currentUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!postId) {
        return res.status(400).json({ error: 'Post ID is required' });
      }

      // Check if user already saved this post
      const existingPost = await Post.findById(postId);
      if (!existingPost) {
        return res.status(404).json({ error: 'Post not found' });
      }

      const alreadySaved = existingPost.metadata?.savedBy?.includes(currentUserId);
      
      if (alreadySaved) {
        return res.json({ 
          success: true, 
          saved: true,
          message: 'Already saved'
        });
      }

      // Add user to savedBy array
      const updateResult = await Post.findByIdAndUpdate(
        postId,
        {
          $addToSet: { 'metadata.savedBy': currentUserId }
        },
        { new: true }
      );

      // Emit real-time update
      io.emit('post:saved', {
        postId,
        userId: currentUserId,
        timestamp: new Date().toISOString()
      });

      res.json({ 
        success: true, 
        saved: true
      });
    } catch (error) {
      console.error('Error saving post:', error);
      res.status(500).json({ 
        error: 'Failed to save post',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Unsave a post
   */
  async unsaveItem(req: AuthRequest, res: Response) {
    try {
      const { postId } = req.params;
      const currentUserId = req.user?.id;

      console.log('🗑️ Unsave endpoint called:', { postId, currentUserId, user: req.user });

      if (!currentUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!postId) {
        return res.status(400).json({ error: 'Post ID is required' });
      }

      // Check if user has saved this post
      const existingPost = await Post.findById(postId);
      if (!existingPost) {
        return res.status(404).json({ error: 'Post not found' });
      }

      const hasSaved = existingPost.metadata?.savedBy?.includes(currentUserId);
      
      if (!hasSaved) {
        return res.json({ 
          success: true, 
          saved: false,
          message: 'Not saved'
        });
      }

      // Remove user from savedBy array
      const updateResult = await Post.findByIdAndUpdate(
        postId,
        {
          $pull: { 'metadata.savedBy': currentUserId }
        },
        { new: true }
      );

      // Emit real-time update
      io.emit('post:unsaved', {
        postId,
        userId: currentUserId,
        timestamp: new Date().toISOString()
      });

      res.json({ 
        success: true, 
        saved: false
      });
    } catch (error) {
      console.error('Error unsaving post:', error);
      res.status(500).json({ 
        error: 'Failed to unsave post',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Debug endpoint to see raw post data
   */
  async debugPosts(req: AuthRequest, res: Response) {
    try {
      const posts = await Post.find({}).limit(3).lean();
      console.log('🔍 Debug - Raw posts from database:', JSON.stringify(posts, null, 2));
      
      res.json({
        message: 'Debug posts',
        count: posts.length,
        posts: posts.map(post => ({
          id: post._id,
          oxyUserId: post.oxyUserId,
          content: post.content,
          stats: post.stats,
          metadata: post.metadata,
          createdAt: post.createdAt
        }))
      });
    } catch (error) {
      console.error('Debug error:', error);
      res.status(500).json({ error: 'Debug failed' });
    }
  }

  // Legacy methods for backward compatibility
  async getPostsFeed(req: AuthRequest, res: Response) {
    req.query.type = 'posts';
    return this.getFeed(req, res);
  }

  async getRepostsFeed(req: AuthRequest, res: Response) {
    req.query.type = 'reposts';
    return this.getFeed(req, res);
  }

  async getQuotesFeed(req: AuthRequest, res: Response) {
    req.query.type = 'quotes';
    return this.getFeed(req, res);
  }

  async getRepliesFeed(req: AuthRequest, res: Response) {
    req.query.type = 'replies';
    return this.getFeed(req, res);
  }

  /**
   * Get a single feed item by ID with full transformation and user interactions
   */
  async getFeedItemById(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params as any;
      const currentUserId = req.user?.id;

      if (!id) {
        return res.status(400).json({ error: 'Post ID is required' });
      }

      const post = await Post.findById(id).lean();
      if (!post) {
        return res.status(404).json({ error: 'Post not found' });
      }

      const [transformed] = await this.transformPostsWithProfiles([post], currentUserId);

      return res.json(transformed);
    } catch (error) {
      console.error('Error fetching feed item:', error);
      res.status(500).json({ error: 'Failed to fetch feed item' });
    }
  }
}

export const feedController = new FeedController();
export default feedController;
