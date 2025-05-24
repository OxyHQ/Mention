import { Request, Response, NextFunction } from "express";
import Post, { IPost } from "../models/Post";
import { logger } from '../utils/logger';
import mongoose, { Types } from 'mongoose';
import { AuthRequest } from '../types/auth';
import createError from 'http-errors';
import Bookmark from "../models/Bookmark";


export class FeedController {
  /**
   * Fetch profile data for a list of user IDs (stub: returns empty map)
   * @param userIds List of user IDs to fetch profile data for
   * @returns Object mapping user IDs to their profile data (empty)
   */
  private async fetchProfileData(userIds: string[]) {
    // No external service, so return empty map
    return new Map();
  }

  /**
   * Transform posts to include full profile data
   * @param posts Array of posts to transform
   * @param includeProfiles Whether to include full profile data
   * @returns Transformed posts with author profiles
   */
  private async transformPostsWithProfiles(posts: IPost[], includeProfiles: boolean) {
    // Basic transformation without profiles
    const transformedPosts = posts.map(post => {
      const postObj = post.toObject() as any;
      return {
        ...postObj,
        id: postObj._id.toString(),
        author: {
          id: postObj.userID.toString(),
          username: "user", // Default values
          name: "User",
          avatar: ""
        }
      };
    });
    
    // If profiles are not requested, return the basic transformation
    return transformedPosts;
  }

  /**
   * Get the home feed for the authenticated user
   * Shows posts from users they follow
   */
  async getHomeFeed(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return next(createError(401, 'Authentication required'));
      }
      
      const limit = parseInt(req.query.limit as string) || 20;
      const cursor = req.query.cursor as string;
      const includeProfiles = req.query.includeProfiles === 'true';
      
      // Build query
      const query: any = {
        userID: userId, // Field name is userID not user
        isDraft: { $ne: true },
        scheduledFor: { $exists: false }
      };
      
      // Add cursor-based pagination if cursor is provided
      if (cursor) {
        query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
      }
      
      // Get posts from followed users and the user's own posts
      const posts = await Post.find(query)
        .sort({ created_at: -1 })
        .limit(limit + 1); // Get one extra to determine if there are more
      
      const hasMore = posts.length > limit;
      const resultPosts = hasMore ? posts.slice(0, limit) : posts;
      const nextCursor = hasMore && resultPosts.length > 0 ? resultPosts[resultPosts.length - 1]._id : null;
      
      // Transform posts with or without profiles
      const transformedPosts = await this.transformPostsWithProfiles(resultPosts, includeProfiles);
      
      return res.status(200).json({
        data: {
          posts: transformedPosts,
          nextCursor: nextCursor ? nextCursor.toString() : null,
          hasMore
        }
      });
    } catch (error) {
      logger.error('Error in getHomeFeed:', error);
      return next(createError(500, 'Error retrieving home feed'));
    }
  }

  /**
   * Get the explore feed (trending/popular posts)
   * Available to all users, even unauthenticated ones
   */
  async getExploreFeed(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const cursor = req.query.cursor as string;
      const includeProfiles = req.query.includeProfiles === 'true';
      
      // Build query
      const query: any = {
        isDraft: { $ne: true },
        scheduledFor: { $exists: false }
      };
      
      // Add cursor-based pagination if cursor is provided
      if (cursor) {
        query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
      }
      
      // Get popular posts based on engagement metrics
      const posts = await Post.find(query)
        .sort({ created_at: -1 }) // Sort by creation date for now
        .limit(limit + 1); // Get one extra to determine if there are more
      
      const hasMore = posts.length > limit;
      const resultPosts = hasMore ? posts.slice(0, limit) : posts;
      const nextCursor = hasMore && resultPosts.length > 0 ? resultPosts[resultPosts.length - 1]._id : null;
      
      // Transform posts with or without profiles
      const transformedPosts = await this.transformPostsWithProfiles(resultPosts, includeProfiles);
      
      return res.status(200).json({
        data: {
          posts: transformedPosts,
          nextCursor: nextCursor ? nextCursor.toString() : null,
          hasMore
        }
      });
    } catch (error) {
      logger.error('Error in getExploreFeed:', error);
      return next(createError(500, 'Error retrieving explore feed'));
    }
  }

  /**
   * Get posts for a specific hashtag
   */
  async getHashtagFeed(req: Request, res: Response, next: NextFunction) {
    try {
      const { hashtag } = req.params;
      const limit = parseInt(req.query.limit as string) || 20;
      const cursor = req.query.cursor as string;
      const includeProfiles = req.query.includeProfiles === 'true';
      
      if (!hashtag) {
        return next(createError(400, 'Hashtag parameter is required'));
      }
      
      // Build query
      const query: any = {
        hashtags: { $regex: new RegExp(hashtag, 'i') },
        isDraft: { $ne: true },
        scheduledFor: { $exists: false }
      };
      
      // Add cursor-based pagination if cursor is provided
      if (cursor) {
        query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
      }
      
      // Find posts with the specified hashtag
      const posts = await Post.find(query)
        .sort({ created_at: -1 })
        .limit(limit + 1); // Get one extra to determine if there are more
      
      const hasMore = posts.length > limit;
      const resultPosts = hasMore ? posts.slice(0, limit) : posts;
      const nextCursor = hasMore && resultPosts.length > 0 ? resultPosts[resultPosts.length - 1]._id : null;
      
      // Transform posts with or without profiles
      const transformedPosts = await this.transformPostsWithProfiles(resultPosts, includeProfiles);
      
      return res.status(200).json({
        data: {
          posts: transformedPosts,
          nextCursor: nextCursor ? nextCursor.toString() : null,
          hasMore
        }
      });
    } catch (error) {
      logger.error('Error in getHashtagFeed:', error);
      return next(createError(500, 'Error retrieving hashtag feed'));
    }
  }

  /**
   * Get a specific post by ID
   */
  async getPostById(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const includeProfiles = req.query.includeProfiles === 'true';
      
      if (!id) {
        return next(createError(400, 'Post ID is required'));
      }
      
      const post = await Post.findById(id);
      
      if (!post) {
        return next(createError(404, 'Post not found'));
      }
      
      // Transform post to match frontend expectations
      const postObj = post.toObject() as any;
      let transformedPost = {
        ...postObj,
        id: postObj._id.toString(),
        author: {
          id: postObj.userID.toString(),
          username: "user", // Default values since we don't have user data
          name: "User",
          avatar: ""
        }
      };
      
      // If profiles are requested, fetch and add profile data
      if (includeProfiles && post.userID) {
        const profileMap = await this.fetchProfileData([post.userID.toString()]);
        const profile = profileMap.get(post.userID.toString());
        
        if (profile) {
          transformedPost.author = {
            ...transformedPost.author,
            username: profile.username || transformedPost.author.username,
            name: profile.name ? 
              (typeof profile.name === 'object' ? 
                `${profile.name.first || ''} ${profile.name.last || ''}`.trim() : 
                profile.name) : 
              transformedPost.author.name,
            avatar: profile.avatar || transformedPost.author.avatar,
            description: profile.description,
            location: profile.location,
            website: profile.website,
            premium: profile.premium,
            labels: profile.labels,
            stats: profile.stats
          };
        }
      }
      
      return res.status(200).json({
        data: transformedPost
      });
    } catch (error) {
      logger.error('Error in getPostById:', error);
      return next(createError(500, 'Error retrieving post'));
    }
  }

  /**
   * Get posts from a specific user
   */
  async getUserFeed(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { userId } = req.params;
      const limit = parseInt(req.query.limit as string) || 20;
      const cursor = req.query.cursor as string;
      const includeProfiles = req.query.includeProfiles === 'true';
      
      if (!userId) {
        return next(createError(400, 'User ID is required'));
      }
      
      // Build query
      const query: any = {
        userID: userId,
        isDraft: { $ne: true },
        scheduledFor: { $exists: false }
      };
      
      // Add cursor-based pagination if cursor is provided
      if (cursor) {
        query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
      }
      
      // Get posts from the specified user
      const posts = await Post.find(query)
        .sort({ created_at: -1 })
        .limit(limit + 1); // Get one extra to determine if there are more
      
      const hasMore = posts.length > limit;
      const resultPosts = hasMore ? posts.slice(0, limit) : posts;
      const nextCursor = hasMore && resultPosts.length > 0 ? resultPosts[resultPosts.length - 1]._id : null;
      
      // Transform posts with or without profiles
      const transformedPosts = await this.transformPostsWithProfiles(resultPosts, includeProfiles);
      
      return res.status(200).json({
        data: {
          posts: transformedPosts,
          nextCursor: nextCursor ? nextCursor.toString() : null,
          hasMore
        }
      });
    } catch (error) {
      logger.error('Error in getUserFeed:', error);
      return next(createError(500, 'Error retrieving user feed'));
    }
  }

  /**
   * Get bookmarked posts for the authenticated user
   */
  async getBookmarksFeed(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;
      const limit = parseInt(req.query.limit as string) || 20;
      const cursor = req.query.cursor as string;
      const includeProfiles = req.query.includeProfiles === 'true';
      
      if (!userId) {
        return next(createError(401, 'Authentication required'));
      }
      
      // Find all bookmarks for the user
      const bookmarks = await Bookmark.find({ userId: userId })
        .sort({ createdAt: -1 });
      
      // Get the post IDs from bookmarks
      const postIds = bookmarks.map(bookmark => bookmark.postId);
      
      // Build query
      const query: any = {
        _id: { $in: postIds }
      };
      
      // Add cursor-based pagination if cursor is provided
      if (cursor) {
        query._id = { ...query._id, $lt: new mongoose.Types.ObjectId(cursor) };
      }
      
      // Fetch the actual posts
      const posts = await Post.find(query)
        .sort({ created_at: -1 })
        .limit(limit + 1); // Get one extra to determine if there are more
      
      const hasMore = posts.length > limit;
      const resultPosts = hasMore ? posts.slice(0, limit) : posts;
      const nextCursor = hasMore && resultPosts.length > 0 ? resultPosts[resultPosts.length - 1]._id : null;
      
      // Transform posts with or without profiles
      const transformedPosts = await this.transformPostsWithProfiles(resultPosts, includeProfiles);
      
      return res.status(200).json({
        data: {
          posts: transformedPosts,
          nextCursor: nextCursor ? nextCursor.toString() : null,
          hasMore
        }
      });
    } catch (error) {
      logger.error('Error in getBookmarksFeed:', error);
      return next(createError(500, 'Error retrieving bookmarks feed'));
    }
  }

  /**
   * Get replies to a specific post
   */
  async getRepliesFeed(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { parentId } = req.params;
      const limit = parseInt(req.query.limit as string) || 20;
      const cursor = req.query.cursor as string;
      const includeProfiles = req.query.includeProfiles === 'true';
      
      if (!parentId) {
        return next(createError(400, 'Parent post ID is required'));
      }
      
      // Check if the parent post exists
      const parentPost = await Post.findById(parentId);
      if (!parentPost) {
        return next(createError(404, 'Parent post not found'));
      }
      
      // Build query
      const query: any = {
        in_reply_to_status_id: parentId,
        isDraft: { $ne: true },
        scheduledFor: { $exists: false }
      };
      
      // Add cursor-based pagination if cursor is provided
      if (cursor) {
        query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
      }
      
      // Get replies to the parent post
      const posts = await Post.find(query)
        .sort({ created_at: -1 })
        .limit(limit + 1); // Get one extra to determine if there are more
      
      const hasMore = posts.length > limit;
      const resultPosts = hasMore ? posts.slice(0, limit) : posts;
      const nextCursor = hasMore && resultPosts.length > 0 ? resultPosts[resultPosts.length - 1]._id : null;
      
      // Transform posts with or without profiles
      const transformedPosts = await this.transformPostsWithProfiles(resultPosts, includeProfiles);
      
      return res.status(200).json({
        data: {
          posts: transformedPosts,
          nextCursor: nextCursor ? nextCursor.toString() : null,
          hasMore
        }
      });
    } catch (error) {
      logger.error('Error in getRepliesFeed:', error);
      return next(createError(500, 'Error retrieving replies feed'));
    }
  }

  /**
   * Get posts with media
   */
  async getMediaFeed(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const cursor = req.query.cursor as string;
      const includeProfiles = req.query.includeProfiles === 'true';
      const query: any = {
        isDraft: { $ne: true },
        scheduledFor: { $exists: false },
        media: { $exists: true, $ne: [] }
      };
      if (cursor) {
        query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
      }
      const posts = await Post.find(query)
        .sort({ created_at: -1 })
        .limit(limit + 1);
      const hasMore = posts.length > limit;
      const resultPosts = hasMore ? posts.slice(0, limit) : posts;
      const nextCursor = hasMore && resultPosts.length > 0 ? resultPosts[resultPosts.length - 1]._id : null;
      const transformedPosts = await this.transformPostsWithProfiles(resultPosts, includeProfiles);
      return res.status(200).json({
        data: {
          posts: transformedPosts,
          nextCursor: nextCursor ? nextCursor.toString() : null,
          hasMore
        }
      });
    } catch (error) {
      logger.error('Error in getMediaFeed:', error);
      return next(createError(500, 'Error retrieving media feed'));
    }
  }

  /**
   * Get quote posts
   */
  async getQuotesFeed(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const cursor = req.query.cursor as string;
      const includeProfiles = req.query.includeProfiles === 'true';
      const query: any = {
        isDraft: { $ne: true },
        scheduledFor: { $exists: false },
        quoteTo: { $exists: true, $ne: null }
      };
      if (cursor) {
        query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
      }
      const posts = await Post.find(query)
        .sort({ created_at: -1 })
        .limit(limit + 1);
      const hasMore = posts.length > limit;
      const resultPosts = hasMore ? posts.slice(0, limit) : posts;
      const nextCursor = hasMore && resultPosts.length > 0 ? resultPosts[resultPosts.length - 1]._id : null;
      const transformedPosts = await this.transformPostsWithProfiles(resultPosts, includeProfiles);
      return res.status(200).json({
        data: {
          posts: transformedPosts,
          nextCursor: nextCursor ? nextCursor.toString() : null,
          hasMore
        }
      });
    } catch (error) {
      logger.error('Error in getQuotesFeed:', error);
      return next(createError(500, 'Error retrieving quotes feed'));
    }
  }

  /**
   * Get reposts
   */
  async getRepostsFeed(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const cursor = req.query.cursor as string;
      const includeProfiles = req.query.includeProfiles === 'true';
      const query: any = {
        isDraft: { $ne: true },
        scheduledFor: { $exists: false },
        repostTo: { $exists: true, $ne: null }
      };
      if (cursor) {
        query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
      }
      const posts = await Post.find(query)
        .sort({ created_at: -1 })
        .limit(limit + 1);
      const hasMore = posts.length > limit;
      const resultPosts = hasMore ? posts.slice(0, limit) : posts;
      const nextCursor = hasMore && resultPosts.length > 0 ? resultPosts[resultPosts.length - 1]._id : null;
      const transformedPosts = await this.transformPostsWithProfiles(resultPosts, includeProfiles);
      return res.status(200).json({
        data: {
          posts: transformedPosts,
          nextCursor: nextCursor ? nextCursor.toString() : null,
          hasMore
        }
      });
    } catch (error) {
      logger.error('Error in getRepostsFeed:', error);
      return next(createError(500, 'Error retrieving reposts feed'));
    }
  }

  /**
   * Get only regular posts (not replies, quotes, or reposts)
   */
  async getPostsFeed(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const cursor = req.query.cursor as string;
      const includeProfiles = req.query.includeProfiles === 'true';
      const query: any = {
        isDraft: { $ne: true },
        scheduledFor: { $exists: false },
        in_reply_to_status_id: { $exists: false },
        quoteTo: { $exists: false },
        repostTo: { $exists: false }
      };
      if (cursor) {
        query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
      }
      const posts = await Post.find(query)
        .sort({ created_at: -1 })
        .limit(limit + 1);
      const hasMore = posts.length > limit;
      const resultPosts = hasMore ? posts.slice(0, limit) : posts;
      const nextCursor = hasMore && resultPosts.length > 0 ? resultPosts[resultPosts.length - 1]._id : null;
      const transformedPosts = await this.transformPostsWithProfiles(resultPosts, includeProfiles);
      return res.status(200).json({
        data: {
          posts: transformedPosts,
          nextCursor: nextCursor ? nextCursor.toString() : null,
          hasMore
        }
      });
    } catch (error) {
      logger.error('Error in getPostsFeed:', error);
      return next(createError(500, 'Error retrieving posts feed'));
    }
  }

  /**
   * Get posts from users the authenticated user is following
   */
  async getFollowingFeed(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return next(createError(401, 'Authentication required'));
      }
      const limit = parseInt(req.query.limit as string) || 20;
      const cursor = req.query.cursor as string;
      const includeProfiles = req.query.includeProfiles === 'true';
      // Get the user's following list (assuming a 'following' field or a Follow model)
      // Example: User has a following array of user IDs
      // You may need to adjust this based on your actual schema
      const User = mongoose.model('User');
      const user = await User.findById(userId).select('following');
      if (!user || !user.following || !Array.isArray(user.following) || user.following.length === 0) {
        return res.status(200).json({
          data: { posts: [], nextCursor: null, hasMore: false }
        });
      }
      const followingIds = user.following.map((id: any) => id.toString());
      const query: any = {
        userID: { $in: followingIds },
        isDraft: { $ne: true },
        scheduledFor: { $exists: false }
      };
      if (cursor) {
        query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
      }
      const posts = await Post.find(query)
        .sort({ created_at: -1 })
        .limit(limit + 1);
      const hasMore = posts.length > limit;
      const resultPosts = hasMore ? posts.slice(0, limit) : posts;
      const nextCursor = hasMore && resultPosts.length > 0 ? resultPosts[resultPosts.length - 1]._id : null;
      const transformedPosts = await this.transformPostsWithProfiles(resultPosts, includeProfiles);
      return res.status(200).json({
        data: {
          posts: transformedPosts,
          nextCursor: nextCursor ? nextCursor.toString() : null,
          hasMore
        }
      });
    } catch (error) {
      logger.error('Error in getFollowingFeed:', error);
      return next(createError(500, 'Error retrieving following feed'));
    }
  }
}
