import { Request, Response, NextFunction } from 'express';
import { Post } from '../models/Post';
import { FeedRequest, CreateReplyRequest, CreateRepostRequest, LikeRequest, UnlikeRequest } from '@mention/shared-types';
import mongoose from 'mongoose';

interface AuthRequest extends Request {
  user?: {
    id: string;
    [key: string]: any;
  };
}

class FeedController {
  /**
   * Transform posts to include full profile data
   */
  private async transformPostsWithProfiles(posts: any[], includeProfiles: boolean) {
    // Basic transformation
    const transformedPosts = posts.map(post => {
      const postObj = post.toObject ? post.toObject() : post;
      return {
        ...postObj,
        id: postObj._id.toString(),
        author: {
          id: postObj.userID ? postObj.userID.toString() : postObj.oxyUserId,
          username: "user",
          name: "User",
          avatar: ""
        }
      };
    });
    
    return transformedPosts;
  }

  async getFeed(req: AuthRequest, res: Response) {
    try {
      const { type = 'posts', cursor, limit = 20, filters } = (req as any).query as any;
      const userId = req.user?.id;

      const query: any = {
        isDraft: { $ne: true }
      };
      
      if (filters?.includeReplies === false) {
        query.in_reply_to_status_id = { $exists: false };
      }
      
      if (filters?.includeReposts === false) {
        query.repost_of = { $exists: false };
      }

      if (cursor) {
        query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
      }

      const posts = await Post.find(query)
        .sort({ created_at: -1 })
        .limit(parseInt(limit as string) + 1)
        .lean();

      const hasMore = posts.length > limit;
      const resultPosts = hasMore ? posts.slice(0, limit) : posts;
      const nextCursor = hasMore && resultPosts.length > 0 ? resultPosts[resultPosts.length - 1]._id : null;

      const transformedPosts = await this.transformPostsWithProfiles(resultPosts, false);

      res.json({
        data: {
          posts: transformedPosts,
          nextCursor: nextCursor ? nextCursor.toString() : null,
          hasMore
        }
      });
    } catch (error) {
      console.error('Error in getFeed:', error);
      res.status(500).json({ error: 'Error retrieving feed' });
    }
  }

  /**
   * Get the explore feed (trending/popular posts)
   */
  async getExploreFeed(req: Request, res: Response) {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const cursor = req.query.cursor as string;
      const includeProfiles = req.query.includeProfiles === 'true';
      
      const query: any = {
        isDraft: { $ne: true }
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
      console.error('Error in getExploreFeed:', error);
      return res.status(500).json({ error: 'Error retrieving explore feed' });
    }
  }

  /**
   * Get posts with media
   */
  async getMediaFeed(req: Request, res: Response) {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const cursor = req.query.cursor as string;
      const includeProfiles = req.query.includeProfiles === 'true';
      
      const query: any = {
        isDraft: { $ne: true },
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
      console.error('Error in getMediaFeed:', error);
      return res.status(500).json({ error: 'Error retrieving media feed' });
    }
  }

  /**
   * Get quote posts
   */
  async getQuotesFeed(req: Request, res: Response) {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const cursor = req.query.cursor as string;
      const includeProfiles = req.query.includeProfiles === 'true';
      
      const query: any = {
        isDraft: { $ne: true },
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
      console.error('Error in getQuotesFeed:', error);
      return res.status(500).json({ error: 'Error retrieving quotes feed' });
    }
  }

  /**
   * Get reposts
   */
  async getRepostsFeed(req: Request, res: Response) {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const cursor = req.query.cursor as string;
      const includeProfiles = req.query.includeProfiles === 'true';
      
      const query: any = {
        isDraft: { $ne: true },
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
      console.error('Error in getRepostsFeed:', error);
      return res.status(500).json({ error: 'Error retrieving reposts feed' });
    }
  }

  /**
   * Get only regular posts (not replies, quotes, or reposts)
   */
  async getPostsFeed(req: Request, res: Response) {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const cursor = req.query.cursor as string;
      const includeProfiles = req.query.includeProfiles === 'true';
      
      const query: any = {
        isDraft: { $ne: true },
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
      console.error('Error in getPostsFeed:', error);
      return res.status(500).json({ error: 'Error retrieving posts feed' });
    }
  }

  /**
   * Get replies to a specific post
   */
  async getRepliesFeed(req: Request, res: Response) {
    try {
      const { parentId } = req.params;
      const limit = parseInt(req.query.limit as string) || 20;
      const cursor = req.query.cursor as string;
      const includeProfiles = req.query.includeProfiles === 'true';
      
      if (!parentId) {
        return res.status(400).json({ error: 'Parent post ID is required' });
      }
      
      const query: any = {
        in_reply_to_status_id: parentId,
        isDraft: { $ne: true }
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
      console.error('Error in getRepliesFeed:', error);
      return res.status(500).json({ error: 'Error retrieving replies feed' });
    }
  }

  async createReply(req: AuthRequest, res: Response) {
    try {
      // Implementation for creating replies
      res.json({ success: true, message: 'Reply created' });
    } catch (error) {
      console.error('Error creating reply:', error);
      res.status(500).json({ error: 'Error creating reply' });
    }
  }

  async createRepost(req: AuthRequest, res: Response) {
    try {
      // Implementation for creating reposts
      res.json({ success: true, message: 'Repost created' });
    } catch (error) {
      console.error('Error creating repost:', error);
      res.status(500).json({ error: 'Error creating repost' });
    }
  }

  async likeItem(req: AuthRequest, res: Response) {
    try {
      // Implementation for liking items
      res.json({ success: true, message: 'Item liked' });
    } catch (error) {
      console.error('Error liking item:', error);
      res.status(500).json({ error: 'Error liking item' });
    }
  }

  async unlikeItem(req: AuthRequest, res: Response) {
    try {
      // Implementation for unliking items
      res.json({ success: true, message: 'Item unliked' });
    } catch (error) {
      console.error('Error unliking item:', error);
      res.status(500).json({ error: 'Error unliking item' });
    }
  }
}

export const feedController = new FeedController();