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

    const { title, description, isPublic = false, memberOxyUserIds = [] } = req.body || {};
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'Title is required' });
    }

    const feed = await CustomFeed.create({
      ownerOxyUserId: userId,
      title: title.trim(),
      description: description?.trim(),
      isPublic: !!isPublic,
      memberOxyUserIds: Array.isArray(memberOxyUserIds) ? memberOxyUserIds : [],
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

    const { mine, publicOnly } = req.query as any;
    const q: any = {};
    if (mine === 'true') q.ownerOxyUserId = userId;
    if (publicOnly === 'true') q.isPublic = true;
    if (!mine && !publicOnly) {
      // default: mine + public
      q.$or = [{ ownerOxyUserId: userId }, { isPublic: true }];
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

    const { title, description, isPublic, memberOxyUserIds } = req.body || {};
    if (title !== undefined) feed.title = String(title);
    if (description !== undefined) feed.description = String(description);
    if (isPublic !== undefined) feed.isPublic = !!isPublic;
    if (memberOxyUserIds !== undefined && Array.isArray(memberOxyUserIds)) feed.memberOxyUserIds = memberOxyUserIds;
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
    const { cursor, limit = 20 } = req.query as any;
    const feed = await CustomFeed.findById(req.params.id).lean();
    if (!feed) return res.status(404).json({ error: 'Feed not found' });
    if (!feed.isPublic && feed.ownerOxyUserId !== userId) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const q: any = {
      oxyUserId: { $in: feed.memberOxyUserIds || [] },
      visibility: 'public',
    };
    if (cursor) {
      q._id = { $lt: new mongoose.Types.ObjectId(String(cursor)) };
    }

    const docs = await Post.find(q).sort({ createdAt: -1 }).limit(Number(limit) + 1).lean();
    const hasMore = docs.length > Number(limit);
    const toReturn = hasMore ? docs.slice(0, Number(limit)) : docs;
    const nextCursor = hasMore ? String(docs[Number(limit) - 1]._id) : undefined;

    const transformed = await (feedController as any).transformPostsWithProfiles(toReturn, userId);

    res.json({
      items: transformed.map((p: any) => ({ id: p.id, type: 'post', data: p, createdAt: p.date, updatedAt: p.date })),
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

