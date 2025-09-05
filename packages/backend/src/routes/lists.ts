import express, { Request, Response } from 'express';
import AccountList from '../models/AccountList';
import { Post } from '../models/Post';
import mongoose from 'mongoose';
import { feedController } from '../controllers/feed.controller';

const router = express.Router();

interface AuthRequest extends Request { user?: { id: string } }

// Create list (accounts)
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { title, description, isPublic = true, memberOxyUserIds = [] } = req.body || {};
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const list = await AccountList.create({
      ownerOxyUserId: userId,
      title: String(title),
      description: description ? String(description) : undefined,
      isPublic: !!isPublic,
      memberOxyUserIds: Array.isArray(memberOxyUserIds) ? memberOxyUserIds : [],
    });

    res.status(201).json(list);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create list' });
  }
});

// List lists (mine/public)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const { mine, publicOnly } = req.query as any;
    const q: any = {};
    if (mine === 'true') q.ownerOxyUserId = userId;
    if (publicOnly === 'true') q.isPublic = true;
    if (!mine && !publicOnly) q.$or = [{ ownerOxyUserId: userId }, { isPublic: true }];
    const items = await AccountList.find(q).sort({ updatedAt: -1 }).lean();
    res.json({ items, total: items.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list lists' });
  }
});

// Get list
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const list = await AccountList.findById(req.params.id).lean();
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (!list.isPublic && list.ownerOxyUserId !== userId) return res.status(403).json({ error: 'Not allowed' });
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get list' });
  }
});

// Update list
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const list = await AccountList.findById(req.params.id);
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (list.ownerOxyUserId !== userId) return res.status(403).json({ error: 'Not allowed' });
    const { title, description, isPublic, memberOxyUserIds } = req.body || {};
    if (title !== undefined) list.title = String(title);
    if (description !== undefined) list.description = String(description);
    if (isPublic !== undefined) list.isPublic = !!isPublic;
    if (Array.isArray(memberOxyUserIds)) list.memberOxyUserIds = memberOxyUserIds;
    await list.save();
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update list' });
  }
});

// Delete list
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const list = await AccountList.findById(req.params.id);
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (list.ownerOxyUserId !== userId) return res.status(403).json({ error: 'Not allowed' });
    await list.deleteOne();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete list' });
  }
});

// Add/remove members
router.post('/:id/members', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { userIds } = req.body || {};
    const list = await AccountList.findById(req.params.id);
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (list.ownerOxyUserId !== userId) return res.status(403).json({ error: 'Not allowed' });
    const set = new Set([...(list.memberOxyUserIds || []), ...(Array.isArray(userIds) ? userIds : [])]);
    list.memberOxyUserIds = Array.from(set);
    await list.save();
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: 'Failed to add members' });
  }
});

router.delete('/:id/members', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { userIds } = req.body || {};
    const list = await AccountList.findById(req.params.id);
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (list.ownerOxyUserId !== userId) return res.status(403).json({ error: 'Not allowed' });
    const toRemove = new Set(Array.isArray(userIds) ? userIds : []);
    list.memberOxyUserIds = (list.memberOxyUserIds || []).filter(id => !toRemove.has(id));
    await list.save();
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove members' });
  }
});

// Timeline of a list (chronological posts from members)
router.get('/:id/timeline', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { cursor, limit = 20 } = req.query as any;
    const list = await AccountList.findById(req.params.id).lean();
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (!list.isPublic && list.ownerOxyUserId !== userId) return res.status(403).json({ error: 'Not allowed' });

    const q: any = { oxyUserId: { $in: list.memberOxyUserIds || [] }, visibility: 'public' };
    if (cursor) q._id = { $lt: new mongoose.Types.ObjectId(String(cursor)) };
    const docs = await Post.find(q).sort({ createdAt: -1 }).limit(Number(limit) + 1).lean();
    const hasMore = docs.length > Number(limit);
    const toReturn = hasMore ? docs.slice(0, Number(limit)) : docs;
    const nextCursor = hasMore ? String(docs[Number(limit) - 1]._id) : undefined;
    const transformed = await (feedController as any).transformPostsWithProfiles(toReturn, userId);
    res.json({ items: transformed.map((p: any) => ({ id: p.id, type: 'post', data: p, createdAt: p.date, updatedAt: p.date })), hasMore, nextCursor, totalCount: transformed.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load list timeline' });
  }
});

export default router;
