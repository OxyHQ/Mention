import { Router } from 'express';
import CustomFeed from '../models/CustomFeed';
import { Post } from '../models/Post';
import mongoose from 'mongoose';
import { feedController } from '../controllers/feed.controller';
import { validateBody, validateObjectId, schemas } from '../middleware/validate';
import FeedLike from '../models/FeedLike';
import { oxy as oxyClient } from '../../server';
import { logger } from '../utils/logger';

interface AuthRequest extends Request {
  user?: { id: string };
}

const router = Router();

// Create a new custom feed
router.post('/', validateBody(schemas.createCustomFeed), async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { title, description, isPublic = false, memberOxyUserIds = [], keywords = [], includeReplies = true, includeReposts = true, includeMedia = true, language } = req.body || {};
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'Title is required' });
    }

    const feed = await CustomFeed.create({
      ownerOxyUserId: userId,
      title: title.trim(),
      description: description?.trim(),
      isPublic: !!isPublic,
      memberOxyUserIds: Array.isArray(memberOxyUserIds) ? memberOxyUserIds : [],
      keywords: Array.isArray(keywords) ? keywords : String(keywords || '').split(',').map((s: string) => s.trim()).filter(Boolean),
      includeReplies: !!includeReplies,
      includeReposts: !!includeReposts,
      includeMedia: !!includeMedia,
      language: language || undefined,
    });

    // Normalize _id to id for frontend consistency
    const normalizedFeed = {
      ...feed.toObject(),
      id: feed._id ? String(feed._id) : (feed as any).id,
    };
    res.status(201).json(normalizedFeed);
  } catch (error) {
    logger.error('[CustomFeeds] Create custom feed error:', { userId: req.user?.id, error, body: req.body });
    res.status(500).json({ error: 'Failed to create feed' });
  }
});

// List feeds accessible to current user
router.get('/', async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { mine, publicOnly, search } = req.query as any;
    const q: any = {};
    if (mine === 'true') q.ownerOxyUserId = userId;
    if (publicOnly === 'true') q.isPublic = true;
    if (!mine && !publicOnly) {
      // default: mine + public
      q.$or = [{ ownerOxyUserId: userId }, { isPublic: true }];
    }

    // Add search functionality
    if (search && typeof search === 'string' && search.trim()) {
      const searchTerm = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchRegex = new RegExp(searchTerm, 'i');
      const searchCondition = {
        $or: [
          { title: searchRegex },
          { description: searchRegex },
          { keywords: searchRegex }
        ]
      };
      
      // Combine with existing query conditions
      if (q.$or) {
        // If there's already an $or (for mine/public), wrap both in $and
        q.$and = [{ $or: q.$or }, searchCondition];
        delete q.$or;
      } else {
        // If there's no $or, add search conditions directly
        q.$or = searchCondition.$or;
      }
    }

    const items = await CustomFeed.find(q).sort({ updatedAt: -1 }).lean();
    
    // Get like counts and isLiked status for all feeds
    const feedIds = items.map((item: any) => item._id || item.id);
    const likeCountsMap = new Map<string, number>();
    const likedFeedsSet = new Set<string>();
    
    if (feedIds.length > 0) {
      // Get like counts for all feeds in one query (always fetch, even without userId)
      const likeCounts = await FeedLike.aggregate([
        { $match: { feedId: { $in: feedIds.map((id: any) => new mongoose.Types.ObjectId(id)) } } },
        { $group: { _id: '$feedId', count: { $sum: 1 } } },
      ]);
      
      likeCounts.forEach((item: any) => {
        likeCountsMap.set(String(item._id), item.count);
      });
      
      // Get feeds liked by current user (only if userId exists)
      if (userId) {
        const userLikes = await FeedLike.find({ userId, feedId: { $in: feedIds.map((id: any) => new mongoose.Types.ObjectId(id)) } }).lean();
        userLikes.forEach((like: any) => {
          likedFeedsSet.add(String(like.feedId));
        });
      }
    }
    
    // Get unique owner IDs and fetch owner information
    const ownerIds = [...new Set(items.map((item: any) => item.ownerOxyUserId).filter(Boolean))];
    const ownersMap = new Map<string, any>();
    
    if (ownerIds.length > 0) {
      await Promise.all(
        ownerIds.map(async (ownerId) => {
          try {
            const ownerData = await oxyClient.getUserById(ownerId);
            ownersMap.set(ownerId, {
              id: ownerData?.id || ownerId,
              username: ownerData?.username || ownerData?.handle || ownerId,
              handle: ownerData?.username || ownerData?.handle || ownerId,
              displayName: ownerData?.name?.full || ownerData?.displayName || ownerData?.username || ownerId,
              avatar: typeof ownerData?.avatar === 'string' 
                ? ownerData.avatar 
                : (ownerData?.avatar as any)?.url || ownerData?.profileImage || undefined,
            });
          } catch (error) {
            logger.warn(`[CustomFeeds] Failed to fetch owner ${ownerId}:`, error);
            ownersMap.set(ownerId, {
              id: ownerId,
              username: ownerId,
              handle: ownerId,
              displayName: ownerId,
              avatar: undefined,
            });
          }
        })
      );
    }
    
    // Normalize _id to id for frontend consistency and add like data and owner info
    const normalizedItems = items.map((item: any) => {
      const feedId = item._id ? String(item._id) : item.id;
      return {
        ...item,
        id: feedId,
        likeCount: likeCountsMap.get(feedId) || 0,
        isLiked: userId ? likedFeedsSet.has(feedId) : false,
        owner: item.ownerOxyUserId ? ownersMap.get(item.ownerOxyUserId) : undefined,
      };
    });
    res.json({ items: normalizedItems, total: normalizedItems.length });
  } catch (error) {
    logger.error('[CustomFeeds] List custom feeds error:', { userId: req.user?.id, error, query: req.query });
    res.status(500).json({ error: 'Failed to list feeds' });
  }
});

// Get a feed by id
router.get('/:id', validateObjectId('id'), async (req: any, res) => {
  try {
    const userId = req.user?.id;
    const feed = await CustomFeed.findById(req.params.id).lean();
    if (!feed) return res.status(404).json({ error: 'Feed not found' });
    if (!feed.isPublic && feed.ownerOxyUserId !== userId) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    
    const feedId = (feed as any)._id ? String((feed as any)._id) : (feed as any).id;
    
    // Get like count
    const likeCount = await FeedLike.countDocuments({ feedId: new mongoose.Types.ObjectId(feedId) });
    
    // Get isLiked status for current user
    let isLiked = false;
    if (userId) {
      const userLike = await FeedLike.findOne({ userId, feedId: new mongoose.Types.ObjectId(feedId) });
      isLiked = !!userLike;
    }
    
    // Fetch owner information from Oxy
    let owner = null;
    if (feed.ownerOxyUserId) {
      try {
        const ownerData = await oxyClient.getUserById(feed.ownerOxyUserId);
        owner = {
          id: ownerData?.id || feed.ownerOxyUserId,
          username: ownerData?.username || ownerData?.handle || feed.ownerOxyUserId,
          handle: ownerData?.username || ownerData?.handle || feed.ownerOxyUserId,
          displayName: ownerData?.name?.full || ownerData?.displayName || ownerData?.username || feed.ownerOxyUserId,
          avatar: typeof ownerData?.avatar === 'string' 
            ? ownerData.avatar 
            : (ownerData?.avatar as any)?.url || ownerData?.profileImage || undefined,
        };
      } catch (error) {
        logger.warn('[CustomFeeds] Failed to fetch owner info:', error);
        // Fallback to just the ID if fetch fails
        owner = {
          id: feed.ownerOxyUserId,
          username: feed.ownerOxyUserId,
          handle: feed.ownerOxyUserId,
          displayName: feed.ownerOxyUserId,
          avatar: undefined,
        };
      }
    }
    
    // Normalize _id to id for frontend consistency
    const normalizedFeed = {
      ...feed,
      id: feedId,
      likeCount,
      isLiked,
      owner,
    };
    res.json(normalizedFeed);
  } catch (error) {
    logger.error('[CustomFeeds] Get feed error:', { userId: req.user?.id, feedId: req.params.id, error });
    res.status(500).json({ error: 'Failed to get feed' });
  }
});

// Update a feed (owner only)
router.put('/:id', validateObjectId('id'), validateBody(schemas.updateCustomFeed), async (req: any, res) => {
  try {
    const userId = req.user?.id;
    const feed = await CustomFeed.findById(req.params.id);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });
    if (feed.ownerOxyUserId !== userId) return res.status(403).json({ error: 'Not allowed' });

    const { title, description, isPublic, memberOxyUserIds, keywords, includeReplies, includeReposts, includeMedia, language } = req.body || {};
    if (title !== undefined) feed.title = String(title);
    if (description !== undefined) feed.description = String(description);
    if (isPublic !== undefined) feed.isPublic = !!isPublic;
    if (memberOxyUserIds !== undefined && Array.isArray(memberOxyUserIds)) feed.memberOxyUserIds = memberOxyUserIds;
    if (keywords !== undefined) feed.keywords = Array.isArray(keywords) ? keywords : String(keywords).split(',').map((s: string) => s.trim()).filter(Boolean);
    if (includeReplies !== undefined) feed.includeReplies = !!includeReplies;
    if (includeReposts !== undefined) feed.includeReposts = !!includeReposts;
    if (includeMedia !== undefined) feed.includeMedia = !!includeMedia;
    if (language !== undefined) feed.language = language;
    await feed.save();
    // Normalize _id to id for frontend consistency
    const normalizedFeed = {
      ...feed.toObject(),
      id: feed._id ? String(feed._id) : (feed as any).id,
    };
    res.json(normalizedFeed);
  } catch (error) {
    logger.error('[CustomFeeds] Update custom feed error:', { userId: req.user?.id, feedId: req.params.id, error, body: req.body });
    res.status(500).json({ error: 'Failed to update feed' });
  }
});

// Delete a feed (owner only)
router.delete('/:id', validateObjectId('id'), async (req: any, res) => {
  try {
    const userId = req.user?.id;
    const feed = await CustomFeed.findById(req.params.id);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });
    if (feed.ownerOxyUserId !== userId) return res.status(403).json({ error: 'Not allowed' });
    await feed.deleteOne();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete feed' });
  }
});

// Add members (owner only)
router.post('/:id/members', validateObjectId('id'), validateBody(schemas.manageFeedMembers), async (req: any, res) => {
  try {
    const userId = req.user?.id;
    const { userIds } = req.body || {};
    const feed = await CustomFeed.findById(req.params.id);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });
    if (feed.ownerOxyUserId !== userId) return res.status(403).json({ error: 'Not allowed' });
    const toAdd: string[] = Array.isArray(userIds) ? userIds : [];
    const set = new Set([...(feed.memberOxyUserIds || []), ...toAdd]);
    feed.memberOxyUserIds = Array.from(set);
    await feed.save();
    // Normalize _id to id for frontend consistency
    const normalizedFeed = {
      ...feed.toObject(),
      id: feed._id ? String(feed._id) : (feed as any).id,
    };
    res.json(normalizedFeed);
  } catch (error) {
    res.status(500).json({ error: 'Failed to add members' });
  }
});

// Remove members (owner only)
router.delete('/:id/members', validateObjectId('id'), validateBody(schemas.manageFeedMembers), async (req: any, res) => {
  try {
    const userId = req.user?.id;
    const { userIds } = req.body || {};
    const feed = await CustomFeed.findById(req.params.id);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });
    if (feed.ownerOxyUserId !== userId) return res.status(403).json({ error: 'Not allowed' });
    const toRemove: Set<string> = new Set(Array.isArray(userIds) ? userIds : []);
    feed.memberOxyUserIds = (feed.memberOxyUserIds || []).filter(id => !toRemove.has(id));
    await feed.save();
    // Normalize _id to id for frontend consistency
    const normalizedFeed = {
      ...feed.toObject(),
      id: feed._id ? String(feed._id) : (feed as any).id,
    };
    res.json(normalizedFeed);
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove members' });
  }
});

// Timeline for a custom feed
router.get('/:id/timeline', validateObjectId('id'), async (req: any, res) => {
  try {
    const userId = req.user?.id;
    // Validate and sanitize inputs
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || 20)), 1), 100); // Clamp between 1-100
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor.trim() : undefined;

    const feed = await CustomFeed.findById(req.params.id).lean();
    if (!feed) return res.status(404).json({ error: 'Feed not found' });
    if (!feed.isPublic && feed.ownerOxyUserId !== userId) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    // Expand authors from direct members + lists
    // IMPORTANT: Only include explicitly added members, NOT the owner
    let authors: string[] = Array.from(new Set(feed.memberOxyUserIds || []));
    try {
      if (feed.sourceListIds && feed.sourceListIds.length) {
        const { AccountList } = require('../models/AccountList');
        const lists = await AccountList.find({ _id: { $in: feed.sourceListIds } }).lean();
        lists.forEach((l: any) => (l.memberOxyUserIds || []).forEach((id: string) => authors.push(id)));
        authors = Array.from(new Set(authors));
      }
    } catch (e) {
      // Failed to expand list members - continue without them
    }

    // Explicitly exclude the owner unless they're in the member list
    // This ensures the owner's posts are only shown if they explicitly added themselves
    const ownerId = feed.ownerOxyUserId;
    const ownerIsInMembers = authors.includes(ownerId);
    
    // If owner is not in members, explicitly exclude them
    if (!ownerIsInMembers && ownerId) {
      // Filter out owner from authors if somehow they got in, and add exclusion condition
      authors = authors.filter(id => id !== ownerId);
    }


    // Build query based on feed configuration
    const q: any = {
      visibility: 'public',
    };

    // Collect all conditions in $and array for proper MongoDB query structure
    const conditions: any[] = [];

    // Author filter: if authors are specified, filter by them (owner excluded unless explicitly added)
    if (authors.length > 0) {
      conditions.push({ oxyUserId: { $in: authors } });
    } else if (ownerId && !ownerIsInMembers) {
      // If no authors but owner exists and is not in members, explicitly exclude owner
      // This handles the case where only keywords are specified
      conditions.push({ oxyUserId: { $ne: ownerId } });
    }

    // Keyword filter: posts must match keywords in content or hashtags
    if (feed.keywords && feed.keywords.length) {
      const keywordRegexes = feed.keywords.map((k: string) => 
        new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      );
      const keywordConditions = [
        { 'content.text': { $in: keywordRegexes } },
        { hashtags: { $in: feed.keywords.map((k: string) => k.toLowerCase()) } }
      ];
      
      // If authors are also specified, keywords become an AND condition
      // Otherwise, keywords are the primary filter (can be from any author)
      if (authors.length > 0) {
        // Posts must be from authors AND match keywords
        conditions.push({ $or: keywordConditions });
      } else {
        // No authors specified, so posts from ANY author that match keywords
        // Use $or for keywords (can match text OR hashtags)
        conditions.push({ $or: keywordConditions });
      }
    }

    // If no authors and no keywords, return empty (feed has no criteria)
    if (authors.length === 0 && (!feed.keywords || feed.keywords.length === 0)) {
      return res.json({
        items: [],
        hasMore: false,
        nextCursor: undefined,
        totalCount: 0,
      });
    }

    // Apply content type filters
    if (feed.includeReplies === false) {
      conditions.push({ $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] });
    }
    
    if (feed.includeReposts === false) {
      conditions.push({ $or: [{ repostOf: null }, { repostOf: { $exists: false } }] });
    }
    
    if (feed.includeMedia === false) {
      conditions.push({ 
        $and: [
          { type: { $nin: ['image', 'video'] } },
          { 'content.media': { $exists: false } },
          { 'content.images': { $exists: false } }
        ]
      });
    }
    
    if (feed.language) {
      conditions.push({ language: feed.language });
    }

    // Combine all conditions with $and
    if (conditions.length > 0) {
      q.$and = conditions;
    }

    // Apply cursor pagination with validation
    if (cursor) {
      // Validate ObjectId format to prevent injection
      if (mongoose.Types.ObjectId.isValid(cursor)) {
        try {
          q._id = { $lt: new mongoose.Types.ObjectId(cursor) };
        } catch (e) {
          // Invalid ObjectId - ignore and continue without cursor pagination
        }
      }
    }

    const docs = await Post.find(q).sort({ createdAt: -1 }).limit(limit + 1).lean();
    
    const hasMore = docs.length > limit;
    const toReturn = hasMore ? docs.slice(0, limit) : docs;
    const nextCursor = hasMore && toReturn.length > 0 
      ? String(toReturn[toReturn.length - 1]._id) 
      : undefined;

    const transformed = await (feedController as any).transformPostsWithProfiles(toReturn, userId);

    // Return in FeedResponse format - items as direct posts (not wrapped)
    // Frontend Feed component expects items to be posts directly
    res.json({
      items: transformed, // Return posts directly, not wrapped
      hasMore,
      nextCursor,
      totalCount: transformed.length,
    });
  } catch (error) {
    logger.error('[CustomFeeds] Custom feed timeline error:', { userId: req.user?.id, feedId: req.params.id, error });
    res.status(500).json({ error: 'Failed to load timeline' });
  }
});

// Like a feed
router.post('/:id/like', validateObjectId('id'), async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const feedId = req.params.id;
    const feed = await CustomFeed.findById(feedId);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });

    // Check if already liked
    const existingLike = await FeedLike.findOne({ userId, feedId });
    if (existingLike) {
      const likeCount = await FeedLike.countDocuments({ feedId });
      return res.json({
        success: true,
        liked: true,
        likeCount,
        message: 'Feed already liked',
      });
    }

    // Create like record
    await FeedLike.create({ userId, feedId });

    // Get updated like count
    const likeCount = await FeedLike.countDocuments({ feedId });

    res.json({
      success: true,
      liked: true,
      likeCount,
      message: 'Feed liked successfully',
    });
  } catch (error: any) {
    logger.error('[CustomFeeds] Like feed error:', { userId: req.user?.id, feedId: req.params.id, error });
    if (error.code === 11000) {
      // Duplicate key error - already liked
      const feedId = req.params.id;
      const likeCount = await FeedLike.countDocuments({ feedId });
      return res.json({
        success: true,
        liked: true,
        likeCount,
        message: 'Feed already liked',
      });
    }
    res.status(500).json({ error: 'Failed to like feed' });
  }
});

// Unlike a feed
router.delete('/:id/like', validateObjectId('id'), async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const feedId = req.params.id;
    const feed = await CustomFeed.findById(feedId);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });

    // Remove like record
    const result = await FeedLike.deleteOne({ userId, feedId });
    
    // Get updated like count
    const likeCount = await FeedLike.countDocuments({ feedId });

    if (result.deletedCount === 0) {
      return res.json({
        success: true,
        liked: false,
        likeCount,
        message: 'Feed not liked',
      });
    }

    res.json({
      success: true,
      liked: false,
      likeCount,
      message: 'Feed unliked successfully',
    });
  } catch (error) {
    logger.error('[CustomFeeds] Unlike feed error:', { userId: req.user?.id, feedId: req.params.id, error });
    res.status(500).json({ error: 'Failed to unlike feed' });
  }
});

export default router;
