import express, { Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import AccountList, { IAccountList } from '../models/AccountList';
import { Post } from '../models/Post';
import mongoose from 'mongoose';
import { feedController } from '../controllers/feed.controller';
import { endorsementSignalService } from '../services/EndorsementSignalService';
import { logger } from '../utils/logger';

const router = express.Router();

/**
 * Fire-and-forget endorsement re-sync for a list whose membership changed.
 * Never blocks or fails the request — Oxy reputation signals are eventually
 * consistent (the outbox retries on failure).
 */
function syncListEndorsements(listId: string): void {
  void endorsementSignalService
    .syncScope('accountList', listId)
    .catch((error) => logger.warn(`[Lists] endorsement sync failed for ${listId}:`, error));
}

function syncListMembershipChange(
  listId: string,
  ownerId: string,
  previousMemberIds: string[],
  nextMemberIds: string[],
): void {
  void endorsementSignalService
    .syncScopeMembershipChange('accountList', listId, ownerId, previousMemberIds, nextMemberIds)
    .catch((error) => logger.warn(`[Lists] endorsement membership sync failed for ${listId}:`, error));
}

type LeanAccountList = Pick<
  IAccountList,
  'ownerOxyUserId' | 'title' | 'description' | 'isPublic' | 'memberOxyUserIds' | 'subscriberCount' | 'createdAt' | 'updatedAt'
> & { _id: mongoose.Types.ObjectId; subscriberCount?: number };

/**
 * Normalize a lean AccountList so `subscriberCount` is always present.
 * Lists created before the field existed lack it in MongoDB; `.lean()` bypasses
 * schema defaults, so default it to 0 here for a stable DTO shape.
 */
function serializeList(list: LeanAccountList): LeanAccountList & { subscriberCount: number } {
  return { ...list, subscriberCount: list.subscriberCount ?? 0 };
}

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

    syncListEndorsements(String(list._id));
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
    const { mine, publicOnly } = req.query;
    const q: Record<string, unknown> = {};
    if (mine === 'true') q.ownerOxyUserId = userId;
    if (publicOnly === 'true') q.isPublic = true;
    if (!mine && !publicOnly) q.$or = [{ ownerOxyUserId: userId }, { isPublic: true }];
    const items = await AccountList.find(q).sort({ updatedAt: -1 }).lean<LeanAccountList[]>();
    const serialized = items.map(serializeList);
    res.json({ items: serialized, total: serialized.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list lists' });
  }
});

// Get list
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const list = await AccountList.findById(req.params.id).lean<LeanAccountList>();
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (!list.isPublic && list.ownerOxyUserId !== userId) return res.status(403).json({ error: 'Not allowed' });
    res.json(serializeList(list));
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
    const previousMemberIds = [...(list.memberOxyUserIds || [])];
    if (Array.isArray(memberOxyUserIds)) list.memberOxyUserIds = memberOxyUserIds;
    await list.save();
    if (Array.isArray(memberOxyUserIds)) {
      syncListMembershipChange(String(list._id), list.ownerOxyUserId, previousMemberIds, list.memberOxyUserIds || []);
    } else {
      syncListEndorsements(String(list._id));
    }
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
    // Capture members BEFORE delete so we can retract their endorsements.
    const ownerId = list.ownerOxyUserId;
    const memberIds = [...(list.memberOxyUserIds || [])];
    const listId = String(list._id);
    await list.deleteOne();
    void endorsementSignalService
      .syncScopeRemoval('accountList', listId, ownerId, memberIds)
      .catch((error) => logger.warn(`[Lists] endorsement retraction failed for ${listId}:`, error));
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
    syncListEndorsements(String(list._id));
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
    const previousMemberIds = [...(list.memberOxyUserIds || [])];
    const toRemove = new Set(Array.isArray(userIds) ? userIds : []);
    list.memberOxyUserIds = (list.memberOxyUserIds || []).filter(id => !toRemove.has(id));
    await list.save();
    syncListMembershipChange(String(list._id), list.ownerOxyUserId, previousMemberIds, list.memberOxyUserIds || []);
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove members' });
  }
});

// Timeline of a list (chronological posts from members)
router.get('/:id/timeline', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { cursor, limit = 20 } = req.query;
    const list = await AccountList.findById(req.params.id).lean();
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (!list.isPublic && list.ownerOxyUserId !== userId) return res.status(403).json({ error: 'Not allowed' });

    const q: Record<string, unknown> = { oxyUserId: { $in: list.memberOxyUserIds || [] }, visibility: 'public' };
    if (cursor) q._id = { $lt: new mongoose.Types.ObjectId(String(cursor)) };
    const docs = await Post.find(q).sort({ createdAt: -1 }).limit(Number(limit) + 1).lean();
    const hasMore = docs.length > Number(limit);
    const toReturn = hasMore ? docs.slice(0, Number(limit)) : docs;
    const nextCursor = hasMore ? String(docs[Number(limit) - 1]._id) : undefined;
    const transformed = await feedController.transformPostsWithProfiles(toReturn, userId);
    // Date lives on the hydrated post's `metadata` (HydratedPost has no top-level
    // `date`); the previous `p.date` read was always undefined under the loose cast.
    res.json({ items: transformed.map((p) => ({ id: p.id, type: 'post', data: p, createdAt: p.metadata?.createdAt, updatedAt: p.metadata?.updatedAt })), hasMore, nextCursor, totalCount: transformed.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load list timeline' });
  }
});

export default router;
