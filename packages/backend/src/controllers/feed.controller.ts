import { Request, Response } from 'express';
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
  async getFeed(req: AuthRequest, res: Response) {
    try {
      const { type = 'posts', cursor, limit = 20, filters } = (req as any).query as any;
      const userId = req.user?.id;

      // Basic implementation - you can expand this based on your needs
      const query: any = {};
      
      if (filters?.includeReplies === false) {
        query.in_reply_to_status_id = { $exists: false };
      }
      
      if (filters?.includeReposts === false) {
        query.repost_of = { $exists: false };
      }

      const posts = await Post.find(query)
        .sort({ created_at: -1 })
        .limit(limit)
        .lean();

      res.json({
        items: posts.map(post => ({
          id: post._id,
          type: 'post',
          data: {
            id: post._id,
            _id: post._id,
            oxyUserId: post.userID.toString(), // Convert ObjectId to string
            type: 'text',
            content: {
              text: post.text
            },
            visibility: 'public',
            isEdited: false,
            language: post.lang,
            tags: [],
            mentions: post.mentions?.map((m: any) => m.toString()) || [],
            hashtags: post.hashtags?.map((h: any) => h.toString()) || [],
            repostOf: post.repost_of?.toString(),
            quoteOf: post.quoted_post_id?.toString(),
            parentPostId: post.in_reply_to_status_id?.toString(),
            stats: {
              likesCount: post.likes?.length || 0,
              repostsCount: post.reposts?.length || 0,
              commentsCount: post.replies?.length || 0,
              viewsCount: 0,
              sharesCount: 0
            },
            metadata: {
              isSensitive: post.possibly_sensitive || false,
              isPinned: false,
              isBookmarked: false,
              isLiked: false,
              isReposted: false,
              isCommented: false,
              isFollowingAuthor: false,
              authorBlocked: false,
              authorMuted: false
            },
            createdAt: post.created_at,
            updatedAt: post.updated_at
          },
          createdAt: post.created_at,
          updatedAt: post.updated_at
        })),
        hasMore: posts.length === limit,
        totalCount: posts.length
      });
    } catch (error) {
      console.error('Error fetching feed:', error);
      res.status(500).json({ message: 'Error fetching feed', error });
    }
  }

  async createReply(req: AuthRequest, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      const { postId, content, mentions, hashtags } = (req as any).body as CreateReplyRequest;

      const reply = new Post({
        text: content,
        userID: new mongoose.Types.ObjectId(userId),
        in_reply_to_status_id: new mongoose.Types.ObjectId(postId),
        mentions: mentions?.map((m: string) => new mongoose.Types.ObjectId(m)) || [],
        hashtags: hashtags?.map((h: string) => new mongoose.Types.ObjectId(h)) || []
      });

      await reply.save();
      await reply.populate('userID', 'username name avatar verified');

      res.status(201).json({ success: true, reply });
    } catch (error) {
      console.error('Error creating reply:', error);
      res.status(500).json({ message: 'Error creating reply', error });
    }
  }

  async createRepost(req: AuthRequest, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      const { originalPostId, comment, mentions, hashtags } = (req as any).body as CreateRepostRequest;

      const repost = new Post({
        text: comment || '',
        userID: new mongoose.Types.ObjectId(userId),
        repost_of: new mongoose.Types.ObjectId(originalPostId),
        mentions: mentions?.map((m: string) => new mongoose.Types.ObjectId(m)) || [],
        hashtags: hashtags?.map((h: string) => new mongoose.Types.ObjectId(h)) || []
      });

      await repost.save();
      await repost.populate('userID', 'username name avatar verified');

      res.status(201).json({ success: true, repost });
    } catch (error) {
      console.error('Error creating repost:', error);
      res.status(500).json({ message: 'Error creating repost', error });
    }
  }

  async likeItem(req: AuthRequest, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      const { postId, type } = (req as any).body as LikeRequest;

      const post = await Post.findById(postId);
      if (!post) {
        return res.status(404).json({ message: 'Post not found' });
      }

      if (!post.likes.includes(new mongoose.Types.ObjectId(userId))) {
        post.likes.push(new mongoose.Types.ObjectId(userId));
        await post.save();
      }

      res.json({ success: true, liked: true });
    } catch (error) {
      console.error('Error liking item:', error);
      res.status(500).json({ message: 'Error liking item', error });
    }
  }

  async unlikeItem(req: AuthRequest, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      const { postId, type } = (req as any).body as UnlikeRequest;

      const post = await Post.findById(postId);
      if (!post) {
        return res.status(404).json({ message: 'Post not found' });
      }

      post.likes = post.likes.filter(id => id.toString() !== userId);
      await post.save();

      res.json({ success: true, liked: false });
    } catch (error) {
      console.error('Error unliking item:', error);
      res.status(500).json({ message: 'Error unliking item', error });
    }
  }
}

export const feedController = new FeedController(); 