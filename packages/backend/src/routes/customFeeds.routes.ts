import { Router } from 'express';
import CustomFeed from '../models/CustomFeed';
import { Post } from '../models/Post';
import mongoose from 'mongoose';
import { feedController } from '../controllers/feed.controller';

interface AuthRequest extends Request {
  user?: { id: string };
}

const router = Router();

// Create a new custom feed
router.post('/', async (req: any, res) => {
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

    res.status(201).json(feed);
  } catch (error) {
    console.error('Create custom feed error:', error);
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
      const searchTerm = search.trim();
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
    res.json({ items, total: items.length });
  } catch (error) {
    console.error('List custom feeds error:', error);
    res.status(500).json({ error: 'Failed to list feeds' });
  }
});

// Get a feed by id
router.get('/:id', async (req: any, res) => {
  try {
    const userId = req.user?.id;
    const feed = await CustomFeed.findById(req.params.id).lean();
    if (!feed) return res.status(404).json({ error: 'Feed not found' });
    if (!feed.isPublic && feed.ownerOxyUserId !== userId) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    res.json(feed);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get feed' });
  }
});

// Update a feed (owner only)
router.put('/:id', async (req: any, res) => {
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
    res.json(feed);
  } catch (error) {
    console.error('Update custom feed error:', error);
    res.status(500).json({ error: 'Failed to update feed' });
  }
});

// Delete a feed (owner only)
router.delete('/:id', async (req: any, res) => {
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
router.post('/:id/members', async (req: any, res) => {
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
    res.json(feed);
  } catch (error) {
    res.status(500).json({ error: 'Failed to add members' });
  }
});

// Remove members (owner only)
router.delete('/:id/members', async (req: any, res) => {
  try {
    const userId = req.user?.id;
    const { userIds } = req.body || {};
    const feed = await CustomFeed.findById(req.params.id);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });
    if (feed.ownerOxyUserId !== userId) return res.status(403).json({ error: 'Not allowed' });
    const toRemove: Set<string> = new Set(Array.isArray(userIds) ? userIds : []);
    feed.memberOxyUserIds = (feed.memberOxyUserIds || []).filter(id => !toRemove.has(id));
    await feed.save();
    res.json(feed);
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove members' });
  }
});

// Timeline for a custom feed
router.get('/:id/timeline', async (req: any, res) => {
  try {
    const userId = req.user?.id;
    // Validate and sanitize inputs
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || 20)), 1), 100); // Clamp between 1-100
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor.trim() : undefined;
    
    // Validate feed ID format to prevent injection
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid feed ID format' });
    }
    
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
    console.error('Custom feed timeline error:', error);
    res.status(500).json({ error: 'Failed to load timeline' });
  }
});

export default router;
