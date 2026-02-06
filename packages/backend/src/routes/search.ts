import express, { Request, Response } from "express";
import mongoose from "mongoose";
import Post from "../models/Post";
import { logger } from '../utils/logger';
import { feedController } from '../controllers/feed.controller';
import { AuthRequest } from '../types/auth';

const router = express.Router();

// Helper to escape regex special characters (prevent ReDoS)
const escapeRegex = (str: string): string => {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const {
      query,
      type = "all",
      dateFrom,
      dateTo,
      author,
      minLikes,
      minReposts,
      mediaType,
      hasMedia,
      language,
      limit = "20",
      cursor
    } = req.query;

    const currentUserId = req.user?.id;
    const results: any = { posts: [] };

    if (type === "all" || type === "posts") {
      // Build query with filters
      const filter: any = {};

      // Text search with escaped regex (prevent ReDoS)
      if (query && typeof query === 'string') {
        const escapedQuery = escapeRegex(query.trim());
        filter.$or = [
          { 'content.text': { $regex: escapedQuery, $options: 'i' } },
          { hashtags: { $regex: escapedQuery, $options: 'i' } }
        ];
      }

      // Date range filter
      if (dateFrom || dateTo) {
        filter.createdAt = {};
        if (dateFrom && typeof dateFrom === 'string') {
          const fromDate = new Date(dateFrom);
          if (!isNaN(fromDate.getTime())) {
            filter.createdAt.$gte = fromDate;
          }
        }
        if (dateTo && typeof dateTo === 'string') {
          const toDate = new Date(dateTo);
          if (!isNaN(toDate.getTime())) {
            filter.createdAt.$lte = toDate;
          }
        }
        // Remove empty date filter if no valid dates
        if (Object.keys(filter.createdAt).length === 0) {
          delete filter.createdAt;
        }
      }

      // Author filter
      if (author && typeof author === 'string') {
        const authorIds = author.split(',').map(id => id.trim()).filter(Boolean);
        if (authorIds.length > 0) {
          filter.oxyUserId = { $in: authorIds };
        }
      }

      // Engagement filters
      if (minLikes && typeof minLikes === 'string') {
        const likesNum = parseInt(minLikes, 10);
        if (!isNaN(likesNum) && likesNum >= 0) {
          filter['stats.likesCount'] = { $gte: likesNum };
        }
      }

      if (minReposts && typeof minReposts === 'string') {
        const repostsNum = parseInt(minReposts, 10);
        if (!isNaN(repostsNum) && repostsNum >= 0) {
          filter['stats.repostsCount'] = { $gte: repostsNum };
        }
      }

      // Media filters
      if (hasMedia === 'true' || hasMedia === true) {
        filter['content.media'] = { $exists: true, $ne: null };
      }

      if (mediaType && typeof mediaType === 'string') {
        const validMediaTypes = ['image', 'video', 'gif'];
        if (validMediaTypes.includes(mediaType)) {
          filter['content.media.type'] = mediaType;
        }
      }

      // Language filter
      if (language && typeof language === 'string') {
        filter.language = language;
      }

      // Cursor-based pagination
      if (cursor && typeof cursor === 'string' && mongoose.Types.ObjectId.isValid(cursor)) {
        filter._id = { $lt: new mongoose.Types.ObjectId(cursor) };
      }

      // Validate and normalize limit (max 100)
      const limitNum = Math.min(Math.max(parseInt(limit as string, 10) || 20, 1), 100);

      // Execute query with lean() for read-only performance
      const posts = await Post.find(filter)
        .sort({ createdAt: -1 })
        .limit(limitNum + 1) // Fetch one extra to check if there are more
        .lean();

      // Check if there are more results
      const hasMore = posts.length > limitNum;
      const postsToReturn = hasMore ? posts.slice(0, limitNum) : posts;

      // Calculate next cursor
      const nextCursor = hasMore && postsToReturn.length > 0
        ? postsToReturn[postsToReturn.length - 1]._id.toString()
        : undefined;

      // Transform posts with user profiles
      const transformedPosts = await (feedController as any).transformPostsWithProfiles(postsToReturn, currentUserId);
      results.posts = transformedPosts;
      results.hasMore = hasMore;
      results.nextCursor = nextCursor;
    }

    res.json(results);
  } catch (error) {
    logger.error('Search error:', error);
    res.status(500).json({
      message: "Error performing search",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

export default router;