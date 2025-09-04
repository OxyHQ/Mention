import { Request, Response, NextFunction } from 'express';
import { Post } from '../models/Post';
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
              name: userData.name?.full || userData.username || 'User',
              handle: userData.username || 'user',
              avatar: userData.avatar?.url || '',
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

      // Transform posts with real user data and engagement stats
      const transformedPosts = posts.map(post => {
        const postObj = post.toObject ? post.toObject() : post;
        const userId = postObj.oxyUserId;
        const userData = userDataMap.get(userId) || {
          id: userId,
          name: 'User',
          handle: 'user',
          avatar: '',
          verified: false
        };

        // Calculate engagement stats
        const engagement = {
          replies: postObj.stats?.commentsCount || 0,
          reposts: postObj.stats?.repostsCount || 0,
          likes: postObj.stats?.likesCount || 0
        };

        // Check if current user has interacted with this post
        const isLiked = currentUserId ? postObj.metadata?.isLiked || false : false;
        const isReposted = currentUserId ? postObj.metadata?.isReposted || false : false;

        return {
          id: postObj._id.toString(),
          user: userData,
          content: postObj.content?.text || '',
          date: postObj.createdAt,
          engagement,
          media: postObj.content?.images || [],
          isLiked,
          isReposted,
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
          stats: postObj.stats,
          metadata: postObj.metadata
        };
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
        query.type = { $in: [PostType.TEXT, PostType.IMAGE, PostType.VIDEO, PostType.POLL] };
        query.parentPostId = { $exists: false };
        query.repostOf = { $exists: false };
        break;
      case 'media':
        query.type = { $in: [PostType.IMAGE, PostType.VIDEO] };
        query.parentPostId = { $exists: false };
        query.repostOf = { $exists: false };
        break;
      case 'replies':
        query.parentPostId = { $exists: true };
        break;
      case 'reposts':
        query.repostOf = { $exists: true };
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
        query.type = { $ne: PostType.IMAGE, $ne: PostType.VIDEO };
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

      const query: any = {
        oxyUserId: userId,
        visibility: PostVisibility.PUBLIC
      };

      // Filter by content type
      if (type === 'posts') {
        query.parentPostId = { $exists: false };
        query.repostOf = { $exists: false };
      } else if (type === 'replies') {
        query.parentPostId = { $exists: true };
      } else if (type === 'media') {
        query.type = { $in: [PostType.IMAGE, PostType.VIDEO] };
        query.parentPostId = { $exists: false };
        query.repostOf = { $exists: false };
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
      const reply = new Post({
        oxyUserId: currentUserId,
        type: PostType.TEXT,
        content: { text: content },
        visibility: PostVisibility.PUBLIC,
        parentPostId: postId,
        hashtags: hashtags || [],
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
      const { originalPostId, comment, mentions, hashtags } = req.body as CreateRepostRequest;
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
      const repost = new Post({
        oxyUserId: currentUserId,
        type: PostType.REPOST,
        content: { text: comment || '' },
        visibility: PostVisibility.PUBLIC,
        repostOf: originalPostId,
        hashtags: hashtags || [],
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

      // Update post like count and metadata
      const updateResult = await Post.findByIdAndUpdate(
        postId,
        {
          $inc: { 'stats.likesCount': 1 },
          $set: { 'metadata.isLiked': true }
        },
        { new: true }
      );

      if (!updateResult) {
        return res.status(404).json({ error: 'Post not found' });
      }

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

      // Update post like count and metadata
      const updateResult = await Post.findByIdAndUpdate(
        postId,
        {
          $inc: { 'stats.likesCount': -1 },
          $set: { 'metadata.isLiked': false }
        },
        { new: true }
      );

      if (!updateResult) {
        return res.status(404).json({ error: 'Post not found' });
      }

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
}

export const feedController = new FeedController();
export default feedController;