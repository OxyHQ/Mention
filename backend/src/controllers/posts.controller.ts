import { Request, Response, NextFunction } from "express";
import Post from "../models/Post";
import { logger } from '../utils/logger';
import mongoose, { Types } from 'mongoose';
import { getIO } from '../utils/socket';
import Hashtag, { IHashtag } from '../models/Hashtag';
import { AuthRequest } from '../types/auth';
import createError from 'http-errors';

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
  };
}

const extractHashtags = (text: string): string[] => {
  const matches = text.match(/#[a-zA-Z0-9_]+/g) || [];
  return matches.map(tag => tag.toLowerCase().substring(1));
};

export const createPost = async (req: AuthRequest, res: Response) => {
  try {
    const { text, media, in_reply_to_status_id, quoted_post_id, isDraft, scheduledFor } = req.body;
    const mentionsInput: string[] = req.body.mentions || [];
    const hashtagsInput: string[] = req.body.hashtags || [];
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'User ID not found in request'
      });
    }

    // Process hashtags
    let hashtagIds: Types.ObjectId[] = [];
    if (hashtagsInput.length > 0) {
      const hashtagDocs = await Promise.all(
        hashtagsInput.map(async (tag) => {
          const existingHashtag = await Hashtag.findOne({ name: tag.toLowerCase() });
          if (existingHashtag) {
            await Hashtag.findByIdAndUpdate(existingHashtag._id, { $inc: { count: 1 } });
            return existingHashtag;
          } else {
            return await Hashtag.create({ name: tag.toLowerCase(), count: 1 });
          }
        })
      );
      hashtagIds = hashtagDocs.map(doc => (doc as unknown as { _id: Types.ObjectId })._id);
    }

    // Determine post status
    let status = 'published';
    if (isDraft) {
      status = 'draft';
    } else if (scheduledFor) {
      status = 'scheduled';
    }

    // Create the post
    const post = new Post({
      text,
      userID: userId,
      media: media || [],
      hashtags: hashtagIds,
      in_reply_to_status_id: in_reply_to_status_id || null,
      quoted_post_id: quoted_post_id || null,
      source: 'web',
      lang: 'en',
      isDraft,
      scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
      status
    });

    await post.save();

    // Populate the post with user and other referenced data
    const populatedPost = await Post.findById(post._id)
      .populate({
        path: 'userID',
        select: 'username name avatar email description'
      })
      .populate({
        path: 'quoted_post_id',
        populate: {
          path: 'userID',
          select: 'username name avatar email description'
        }
      })
      .populate({
        path: 'mentions',
        select: 'username name avatar email description'
      })
      .populate('likes', '_id')
      .populate('reposts', '_id')
      .populate('replies', '_id')
      .populate('bookmarks', '_id');

    // Emit socket event for new post
    const io = getIO();
    if (io && populatedPost) {
      console.log('Emitting newPost event to /posts namespace');
      io.of('/posts').emit('newPost', { 
        post: {
          ...populatedPost.toObject(),
          id: populatedPost._id
        }
      });
    }

    return res.status(201).json({
      data: populatedPost
    });
  } catch (error: any) {
    console.error('Error in createPost:', {
      error: error.message,
      stack: error.stack
    });
    return res.status(500).json({
      error: 'Server error',
      message: `Error creating post: ${error.message}`
    });
  }
};

export const getPosts = async (req: Request, res: Response) => {
  try {
    const { page = 1, limit = 20, userID } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const query = userID ? { userID } : {};
    
    const posts = await Post.find(query)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(Number(limit))
      .populate('userID', 'username displayName avatar');

    const total = await Post.countDocuments(query);

    res.json({
      posts,
      totalPages: Math.ceil(total / Number(limit)),
      currentPage: Number(page)
    });
  } catch (error) {
    logger.error('Error fetching posts:', error);
    res.status(500).json({
      message: "Error fetching posts",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

export const getPostById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const post = await Post.findById(id)
      .populate('userID', 'username displayName avatar')
      .populate('mentions', 'username displayName avatar')
      .populate({
        path: 'replies',
        populate: {
          path: 'userID',
          select: 'username displayName avatar'
        }
      });

    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }

    res.json(post);
  } catch (error) {
    logger.error('Error fetching post:', error);
    res.status(500).json({
      message: "Error fetching post",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

export const updatePost = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { text, media } = req.body;
    
    const post = await Post.findById(id);
    
    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }

    if (post.userID?.toString() !== req.user?.id) {
      return res.status(403).json({ message: "Not authorized to update this post" });
    }

    const updatedPost = await Post.findByIdAndUpdate(
      id,
      { 
        text,
        media,
        edited: true,
        edited_at: new Date()
      },
      { new: true }
    );

    res.json(updatedPost);
  } catch (error) {
    logger.error('Error updating post:', error);
    res.status(500).json({
      message: "Error updating post",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

export const deletePost = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userID = req.user?.id;
    
    const post = await Post.findById(id);
    
    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }

    if (!userID || post.userID?.toString() !== userID) {
      return res.status(403).json({ message: "Not authorized to delete this post" });
    }

    await Post.findByIdAndDelete(id);

    // Emit socket event for post deletion
    const io = getIO();
    if (io) {
      io.of('/posts').emit('postDeleted', {
        postId: id,
        userId: userID
      });
    }

    res.json({ message: "Post deleted successfully" });
  } catch (error) {
    logger.error('Error deleting post:', error);
    res.status(500).json({
      message: "Error deleting post",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

export const likePost = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userID = req.user?.id;

    const post = await Post.findByIdAndUpdate(
      id,
      {
        $addToSet: { likes: userID },
      },
      { new: true }
    )
    .populate('likes', '_id')
    .populate('reposts', '_id')
    .populate('replies', '_id')
    .populate('bookmarks', '_id');

    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }

    // Emit socket event for post like
    const io = getIO();
    if (io) {
      io.of('/posts').emit('postUpdate', {
        type: 'like',
        postId: id,
        userId: userID,
        _count: {
          likes: post.likes.length,
          reposts: post.reposts.length,
          replies: post.replies.length,
          bookmarks: post.bookmarks.length
        }
      });
    }

    res.json(post);
  } catch (error) {
    logger.error('Error liking post:', error);
    res.status(500).json({
      message: "Error liking post",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

export const unlikePost = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userID = req.user?.id;

    const post = await Post.findByIdAndUpdate(
      id,
      {
        $pull: { likes: userID },
      },
      { new: true }
    )
    .populate('likes', '_id')
    .populate('reposts', '_id')
    .populate('replies', '_id')
    .populate('bookmarks', '_id');

    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }

    // Emit socket event for post unlike
    const io = getIO();
    if (io) {
      io.of('/posts').emit('postUpdate', {
        type: 'unlike',
        postId: id,
        userId: userID,
        _count: {
          likes: post.likes.length,
          reposts: post.reposts.length,
          replies: post.replies.length,
          bookmarks: post.bookmarks.length
        }
      });
    }

    res.json(post);
  } catch (error) {
    logger.error('Error unliking post:', error);
    res.status(500).json({
      message: "Error unliking post",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

export const bookmarkPost = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const postId = req.params.id;
    
    // Extract user ID from the request, handling different formats
    // The auth middleware sets req.user.id, but we need to handle both formats
    const userId = req.user?.id || (req.user as any)?._id;

    // Debug authentication information
    console.log('Auth debug for bookmark:', {
      hasUser: !!req.user,
      userFields: req.user ? Object.keys(req.user) : [],
      userId,
      headers: {
        authorization: req.headers.authorization ? 'Bearer [redacted]' : 'none',
        contentType: req.headers['content-type']
      }
    });

    if (!userId) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'User ID not found in request'
      });
    }

    // Convert string ID to ObjectId if needed
    const userIdObj = typeof userId === 'string' ? new mongoose.Types.ObjectId(userId) : userId;

    const post = await Post.findByIdAndUpdate(
      postId,
      {
        $addToSet: { bookmarks: userIdObj },
      },
      { new: true }
    )
    .populate('likes', '_id')
    .populate('reposts', '_id')
    .populate('replies', '_id')
    .populate('bookmarks', '_id');

    if (!post) {
      return res.status(404).json({
        error: 'Post not found',
        message: 'The requested post does not exist'
      });
    }

    // Also update the user's bookmarks

    // Emit socket event
    const io = getIO();
    if (io) {
      io.of('/posts').emit('postUpdate', {
        type: 'bookmark',
        postId: post._id,
        userId: userIdObj,
        _count: {
          likes: post.likes.length,
          reposts: post.reposts.length,
          replies: post.replies.length,
          bookmarks: post.bookmarks.length
        }
      });
    }

    res.json({
      message: 'Post bookmarked successfully',
      bookmarkCount: post.bookmarks.length
    });
  } catch (error) {
    console.error('Bookmark error:', error);
    next(createError(500, 'Error bookmarking post'));
  }
};

export const unbookmarkPost = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const postId = req.params.id;
    
    // Extract user ID from the request, handling different formats
    const userId = req.user?.id || (req.user as any)?._id;

    // Debug authentication information
    console.log('Auth debug for unbookmark:', {
      hasUser: !!req.user,
      userFields: req.user ? Object.keys(req.user) : [],
      userId,
      headers: {
        authorization: req.headers.authorization ? 'Bearer [redacted]' : 'none',
        contentType: req.headers['content-type']
      }
    });

    if (!userId) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'User ID not found in request'
      });
    }

    // Convert string ID to ObjectId if needed
    const userIdObj = typeof userId === 'string' ? new mongoose.Types.ObjectId(userId) : userId;

    const post = await Post.findByIdAndUpdate(
      postId,
      {
        $pull: { bookmarks: userIdObj },
      },
      { new: true }
    )
    .populate('likes', '_id')
    .populate('reposts', '_id')
    .populate('replies', '_id')
    .populate('bookmarks', '_id');

    if (!post) {
      return res.status(404).json({
        error: 'Post not found',
        message: 'The requested post does not exist'
      });
    }

    // Emit socket event
    const io = getIO();
    if (io) {
      io.of('/posts').emit('postUpdate', {
        type: 'unbookmark',
        postId: post._id,
        userId: userIdObj,
        _count: {
          likes: post.likes.length,
          reposts: post.reposts.length,
          replies: post.replies.length,
          bookmarks: post.bookmarks.length
        }
      });
    }

    res.json({
      message: 'Post unbookmarked successfully',
      bookmarkCount: post.bookmarks.length
    });
  } catch (error) {
    console.error('Unbookmark error:', error);
    next(createError(500, 'Error unbookmarking post'));
  }
};

export const repostPost = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userID = req.user?.id;

    const originalPost = await Post.findById(id);
    if (!originalPost) {
      return res.status(404).json({ message: "Original post not found" });
    }

    const repost = await Post.create({
      userID,
      repost_of: id,
      created_at: new Date(),
      _count: { likes: 0, reposts: 0, quotes: 0, bookmarks: 0, replies: 0 }
    });

    await Post.findByIdAndUpdate(id, {
      $inc: { '_count.reposts': 1 }
    });

    const populatedRepost = await Post.findById(repost._id)
      .populate('userID', 'username displayName avatar')
      .populate('repost_of');

    res.status(201).json(populatedRepost);
  } catch (error) {
    logger.error('Error reposting:', error);
    res.status(500).json({
      message: "Error reposting",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

export const quotePost = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { text, media, mentions, hashtags: inputHashtags } = req.body;
    const userID = req.user?.id;

    const originalPost = await Post.findById(id);
    if (!originalPost) {
      return res.status(404).json({ message: "Original post not found" });
    }

    // Extract hashtags from text
    const extractedHashtags = extractHashtags(text);
    const hashtags = [...new Set([...extractedHashtags, ...(inputHashtags || [])])];

    const quote = await Post.create({
      text,
      userID,
      media,
      mentions,
      hashtags,
      quoted_post_id: id,
      created_at: new Date(),
      _count: { likes: 0, reposts: 0, quotes: 0, bookmarks: 0, replies: 0 }
    });

    await Post.findByIdAndUpdate(id, {
      $inc: { '_count.quotes': 1 }
    });

    const populatedQuote = await Post.findById(quote._id)
      .populate('userID', 'username displayName avatar')
      .populate('mentions', 'username displayName avatar')
      .populate('quoted_post_id');

    res.status(201).json(populatedQuote);
  } catch (error) {
    logger.error('Error quoting post:', error);
    res.status(500).json({
      message: "Error quoting post",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

export const getPostsByHashtag = async (req: Request, res: Response) => {
  try {
    const { hashtag } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const posts = await Post.find({ hashtags: hashtag.toLowerCase() })
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(Number(limit))
      .populate('userID', 'username displayName avatar')
      .populate('mentions', 'username displayName avatar')
      .populate('quoted_post_id')
      .populate('repost_of');

    const total = await Post.countDocuments({ hashtags: hashtag.toLowerCase() });

    res.json({
      posts,
      totalPages: Math.ceil(total / Number(limit)),
      currentPage: Number(page)
    });
  } catch (error) {
    logger.error('Error fetching posts by hashtag:', error);
    res.status(500).json({
      message: "Error fetching posts by hashtag",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

export const removeRepost = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userID = req.user?.id;

    const post = await Post.findById(id);
    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }

    // Find and delete the repost
    const repost = await Post.findOneAndDelete({
      userID,
      repost_of: id
    });

    if (!repost) {
      return res.status(404).json({ message: "Repost not found" });
    }

    // Decrement repost count on original post
    const updatedPost = await Post.findByIdAndUpdate(id, {
      $inc: { '_count.reposts': -1 }
    }, { new: true });

    // Emit socket event for repost removal
    const io = getIO();
    if (io && updatedPost) {
      io.of('/posts').emit('postUpdate', {
        type: 'unrepost',
        postId: id,
        userId: userID,
        repostCount: updatedPost._count?.reposts ?? 0
      });
    }

    res.json({ message: "Repost removed successfully" });
  } catch (error) {
    logger.error('Error removing repost:', error);
    res.status(500).json({
      message: "Error removing repost",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

export const getDrafts = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'User ID not found in request'
      });
    }

    const drafts = await Post.find({
      userID: userId,
      status: 'draft'
    })
    .sort({ created_at: -1 })
    .populate('userID', 'username name avatar email description')
    .populate('mentions', 'username name avatar')
    .populate('hashtags', 'name');

    return res.json({
      success: true,
      data: drafts
    });
  } catch (error) {
    console.error('Error fetching drafts:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch drafts'
    });
  }
};

export const getScheduledPosts = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'User ID not found in request'
      });
    }

    const scheduledPosts = await Post.find({
      userID: userId,
      status: 'scheduled',
      scheduledFor: { $gt: new Date() }
    })
    .sort({ scheduledFor: 1 })
    .populate('userID', 'username name avatar email description')
    .populate('mentions', 'username name avatar')
    .populate('hashtags', 'name');

    return res.json({
      success: true,
      data: scheduledPosts
    });
  } catch (error) {
    console.error('Error fetching scheduled posts:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch scheduled posts'
    });
  }
};