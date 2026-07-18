import express, { Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import AccountList, { IAccountList } from '../models/AccountList';
import { Post } from '../models/Post';
import mongoose from 'mongoose';
import { feedController } from '../controllers/feed.controller';
import { endorsementSignalService } from '../services/EndorsementSignalService';
import { logger } from '../utils/logger';
import { queryInt, queryString } from '../utils/queryParams';
import { escapeRegex } from '../utils/textProcessing';
import { feedIPRateLimiter, feedRateLimiter } from '../middleware/security';

const router = express.Router();

/**
 * A list's timeline is a FEED — the same shape and the same cost as a page of
 * `/feed/mtn` — so it earns the same per-endpoint limiters the feed routes use,
 * on top of the app-wide limiter in `server.ts`. The global one bounds abuse of
 * the API as a whole; these bound abuse of the expensive DB reads specifically.
 *
 * Production-gated, mirroring `feed.routes.ts`: the limiters are Redis-backed
 * and a dev machine has no Redis.
 */
const timelineRateLimiters = process.env.NODE_ENV === 'production'
  ? [feedIPRateLimiter, feedRateLimiter]
  : [];

/** List timeline page size (`GET /lists/:id/timeline`). */
const DEFAULT_TIMELINE_PAGE_SIZE = 20;
const MAX_TIMELINE_PAGE_SIZE = 100;

/** Hard cap on the `GET /lists` page size — `?limit` can only narrow it. */
const MAX_LIST_PAGE_SIZE = 100;

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

// List lists (mine/public), optionally filtered by a search term.
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const { mine, publicOnly } = req.query;
    const q: Record<string, unknown> = {};
    if (mine === 'true') q.ownerOxyUserId = userId;
    if (publicOnly === 'true') q.isPublic = true;
    // Visibility gate: without an explicit filter the viewer sees their OWN lists
    // plus every public list. The search term (below) narrows within that gate —
    // it never widens it, so a non-owner still can't reach a private list.
    if (!mine && !publicOnly) q.$or = [{ ownerOxyUserId: userId }, { isPublic: true }];

    // Filter by `search` (name/description, case-insensitive). Previously ignored —
    // the search tab received every accessible list unfiltered. Regex-ESCAPED so a
    // raw query can't be interpreted as a pattern (regex injection / backtracking).
    const search = queryString(req.query.search)?.trim();
    if (search) {
      const searchRegex = new RegExp(escapeRegex(search), 'i');
      const searchCondition = { $or: [{ title: searchRegex }, { description: searchRegex }] };
      if (q.$or) {
        // Combine the visibility OR with the search OR under $and so both must hold.
        q.$and = [{ $or: q.$or }, searchCondition];
        delete q.$or;
      } else {
        q.$or = searchCondition.$or;
      }
    }

    // Opt-in pagination: `?limit` present ⇒ page (offset/limit, over-fetching one
    // row to detect `hasMore`); absent ⇒ the historical "return every accessible
    // list" the lists screen / add-to-list sheet depend on. `_id` breaks
    // `updatedAt` ties so offsets never shuffle rows between pages.
    const rawLimit = queryInt(req.query.limit);
    const offset = Math.max(0, queryInt(req.query.offset) ?? 0);
    let listQuery = AccountList.find(q).sort({ updatedAt: -1, _id: -1 });
    let pageLimit: number | undefined;
    if (rawLimit !== undefined) {
      pageLimit = Math.min(Math.max(1, rawLimit), MAX_LIST_PAGE_SIZE);
      listQuery = listQuery.skip(offset).limit(pageLimit + 1);
    }
    const fetched = await listQuery.lean<LeanAccountList[]>();
    const hasMore = pageLimit !== undefined && fetched.length > pageLimit;
    const page = hasMore ? fetched.slice(0, pageLimit) : fetched;
    const serialized = page.map(serializeList);

    const total = pageLimit !== undefined ? await AccountList.countDocuments(q) : serialized.length;
    res.json({
      items: serialized,
      total,
      pagination: { offset, limit: pageLimit ?? serialized.length, hasMore },
    });
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
router.get('/:id/timeline', ...timelineRateLimiters, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const cursor = queryString(req.query.cursor);
    // Bounded positive integer: the page's last row is read by index below, so a
    // NaN / zero / negative limit would index outside the page.
    const limit = Math.min(Math.max(queryInt(req.query.limit) || DEFAULT_TIMELINE_PAGE_SIZE, 1), MAX_TIMELINE_PAGE_SIZE);
    const list = await AccountList.findById(req.params.id).lean();
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (!list.isPublic && list.ownerOxyUserId !== userId) return res.status(403).json({ error: 'Not allowed' });

    const q: Record<string, unknown> = { oxyUserId: { $in: list.memberOxyUserIds || [] }, visibility: 'public' };
    if (cursor) q._id = { $lt: new mongoose.Types.ObjectId(cursor) };
    const docs = await Post.find(q).sort({ createdAt: -1 }).limit(limit + 1).lean();
    const hasMore = docs.length > limit;
    const toReturn = hasMore ? docs.slice(0, limit) : docs;
    const nextCursor = hasMore ? String(docs[limit - 1]._id) : undefined;
    const transformed = await feedController.transformPostsWithProfiles(toReturn, userId);
    // Date lives on the hydrated post's `metadata` (HydratedPost has no top-level
    // `date`); the previous `p.date` read was always undefined under the loose cast.
    res.json({ items: transformed.map((p) => ({ id: p.id, type: 'post', data: p, createdAt: p.metadata?.createdAt, updatedAt: p.metadata?.updatedAt })), hasMore, nextCursor, totalCount: transformed.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load list timeline' });
  }
});

export default router;
