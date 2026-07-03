import { Request, Response } from "express";
import Analytics from "../models/Analytics";
import Post from "../models/Post";
import { getDateRange } from "./utils/dateUtils";
import { normalizeHashtag } from "../utils/textProcessing";
import { logger } from '../utils/logger';

/**
 * Truncate `now` to the start of the given analytics period bucket so the
 * `{ userID, period, date }` upsert coalesces into ONE document per bucket
 * (per day / week / month / year) instead of inserting a fresh row on every
 * call (the previous `new Date()` had millisecond precision, so no two updates
 * ever shared a key). Weeks start on Monday.
 */
function startOfPeriodBucket(period: string, now: Date): Date {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0); // start of day — the baseline for every bucket
  switch (period) {
    case 'weekly': {
      const daysSinceMonday = (date.getDay() + 6) % 7; // getDay(): 0=Sun..6=Sat
      date.setDate(date.getDate() - daysSinceMonday);
      return date;
    }
    case 'monthly':
      date.setDate(1);
      return date;
    case 'yearly':
      date.setMonth(0, 1);
      return date;
    case 'daily':
    default:
      return date;
  }
}

export const getAnalytics = async (req: Request, res: Response) => {
  try {
    const { userID, period = "weekly" } = req.query;
    const { startDate, endDate } = getDateRange(period as string);

    const analytics = await Analytics.find({
      userID,
      period,
      date: { $gte: startDate, $lte: endDate }
    }).sort({ date: 1 });

    // Get aggregate post stats
    const postStats = await Post.aggregate([
      { $match: { userID, created_at: { $gte: startDate, $lte: endDate } } },
      { $group: {
        _id: null,
        totalPosts: { $sum: 1 },
        totalLikes: { $sum: "$_count.likes" },
        totalBoosts: { $sum: "$_count.boosts" },
        totalQuotes: { $sum: "$_count.quotes" },
        totalSaved: { $sum: "$_count.saved" },
        totalReplies: { $sum: "$_count.replies" }
      }}
    ]);

    res.json({
      timeSeriesData: analytics,
      aggregate: postStats[0] || {},
      growth: {}
    });
  } catch (error) {
    logger.error('Error fetching analytics:', error);
    res.status(500).json({ 
      message: "Error fetching analytics",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

export const updateAnalytics = async (req: Request, res: Response) => {
  try {
    const { userID, type, data } = req.body;
    const now = new Date();

    // Update or create analytics record for each period
    const periods = ["daily", "weekly", "monthly", "yearly"];

    await Promise.all(periods.map(async (period) => {
      // Bucket the date to the period start so repeated updates within the same
      // bucket coalesce into one document via the `{ userID, period, date }`
      // upsert key (a millisecond-precise `new Date()` never coalesced).
      const date = startOfPeriodBucket(period, now);

      const update = {
        $inc: {
          [`stats.${type}`]: 1,
          ...data
        }
      };

      await Analytics.findOneAndUpdate(
        { userID, period, date },
        update,
        { upsert: true, new: true }
      );
    }));

    res.json({ message: "Analytics updated successfully" });
  } catch (error) {
    logger.error('Error updating analytics:', error);
    res.status(500).json({ 
      message: "Error updating analytics",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

export const getHashtagStats = async (req: Request, res: Response) => {
  try {
    const { hashtag } = req.params;
    const { period } = req.query;
    const { startDate, endDate } = getDateRange(period as string);

    // Match the canonical lowercase `hashtags` array (backed by the
    // `{ hashtags: 1, ..., createdAt: -1 }` index) instead of an unanchored
    // `$regex` on a non-existent `text` field (which collection-scanned and
    // matched nothing). Stored tags are normalized (lowercase, no leading '#').
    const normalizedTag = normalizeHashtag(String(hashtag ?? ''));

    const stats = await Post.aggregate([
      {
        $match: {
          hashtags: normalizedTag,
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: null,
          totalPosts: { $sum: 1 },
          totalLikes: { $sum: { $ifNull: ["$stats.likesCount", 0] } },
          totalBoosts: { $sum: { $ifNull: ["$stats.boostsCount", 0] } },
          totalReplies: { $sum: { $ifNull: ["$stats.commentsCount", 0] } }
        }
      }
    ]);

    res.json(stats[0] || {
      totalPosts: 0,
      totalLikes: 0,
      totalBoosts: 0,
      totalReplies: 0
    });
  } catch (error) {
    logger.error('Error fetching hashtag stats:', error);
    res.status(500).json({ 
      message: "Error fetching hashtag stats",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

export const getTopPosts = async (req: Request, res: Response) => {
  try {
    const { userID, period = "weekly" } = req.query;
    const { startDate, endDate } = getDateRange(period as string);
    
    const topPosts = await Post.aggregate([
      { $match: { userID, created_at: { $gte: startDate, $lte: endDate } } },
      { $project: {
        text: 1,
        created_at: 1,
        engagement: {
          $add: [
            { $ifNull: ["$_count.likes", 0] },
            { $ifNull: ["$_count.boosts", 0] },
            { $ifNull: ["$_count.quotes", 0] },
            { $ifNull: ["$_count.replies", 0] },
            { $ifNull: ["$_count.saved", 0] }
          ]
        },
        stats: "$_count"
      }},
      { $sort: { engagement: -1 } },
      { $limit: 10 }
    ]);
    
    res.json(topPosts);
  } catch (error) {
    logger.error('Error fetching top posts:', error);
    res.status(500).json({ 
      message: "Error fetching top posts",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

export const getFollowerDetails = async (req: Request, res: Response) => {
  try {
    const { userID, period = "weekly" } = req.query;
    const { startDate, endDate } = getDateRange(period as string);
    
    res.json({ totalFollowers: 0, newFollowers: 0, activeFollowers: 0 });
  } catch (error) {
    logger.error('Error fetching follower details:', error);
    res.status(500).json({ 
      message: "Error fetching follower details",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
};