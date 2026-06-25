import { Router, Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import Poke from '../models/Poke';
import { createNotification } from '../utils/notificationUtils';
import { logger } from '../utils/logger';
import { oxy } from '../../server';
import type { User } from '@oxyhq/core';

const router = Router();

const POKE_PAGE_DEFAULT_LIMIT = 50;
const POKE_PAGE_MAX_LIMIT = 100;
const POKE_LOOKUP_CONCURRENCY = 8;
const MAX_OXY_USER_ID_LENGTH = 128;
const SUGGESTION_LIMIT = 20;
const SUGGESTION_CANDIDATE_LIMIT = 200;

function normalizeOxyUserId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_OXY_USER_ID_LENGTH) return null;
  return trimmed;
}

function parsePageLimit(value: unknown): number {
  if (typeof value !== 'string') return POKE_PAGE_DEFAULT_LIMIT;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return POKE_PAGE_DEFAULT_LIMIT;
  return Math.min(parsed, POKE_PAGE_MAX_LIMIT);
}

function parseCursor(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Resolve an array of Oxy user IDs into profile objects (best-effort). */
async function resolveUsers(ids: string[]): Promise<Map<string, User>> {
  const uniqueIds = [...new Set(ids.map(normalizeOxyUserId).filter((id): id is string => !!id))];
  const map = new Map<string, User>();

  const bulkGetUsers = (oxy as { getUsersByIds?: (ids: string[]) => Promise<User[]> }).getUsersByIds;
  if (typeof bulkGetUsers === 'function') {
    try {
      const users = await bulkGetUsers.call(oxy, uniqueIds);
      for (const user of users) {
        if (user?.id) map.set(user.id, user);
      }
      return map;
    } catch {
      // Fall back to bounded single-user lookups below.
    }
  }

  for (let i = 0; i < uniqueIds.length; i += POKE_LOOKUP_CONCURRENCY) {
    const batch = uniqueIds.slice(i, i + POKE_LOOKUP_CONCURRENCY);
    await Promise.all(
      batch.map(async (id) => {
        try {
          const user = await oxy.getUserById(id);
          if (user) map.set(id, user);
        } catch { /* skip unresolvable */ }
      }),
    );
  }
  return map;
}

function toUserSummary(user: User) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    avatar: user.avatar,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDuplicateKeyError(error: unknown): boolean {
  return isRecord(error) && error.code === 11000;
}

function extractUsersFromResult(result: unknown, key: 'followers' | 'following'): User[] {
  const list = isRecord(result) ? result[key] : result;
  return Array.isArray(list) ? list.filter((user): user is User => isRecord(user) && typeof user.id === 'string') : [];
}

router.get('/received', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const limit = parsePageLimit(req.query.limit);
    const cursor = parseCursor(req.query.cursor);
    const receivedQuery = cursor ? { pokedId: userId, createdAt: { $lt: cursor } } : { pokedId: userId };

    const pokes = await Poke.find(receivedQuery)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean();
    const pagePokes = pokes.slice(0, limit);
    const pokerIds = pagePokes.map((p) => p.pokerId);

    const [profiles, pokedBackDocs] = await Promise.all([
      resolveUsers(pokerIds),
      pokerIds.length
        ? Poke.find({ pokerId: userId, pokedId: { $in: pokerIds } }).select('pokedId').limit(pokerIds.length).lean()
        : [],
    ]);

    const pokedBackSet = new Set(pokedBackDocs.map((p) => p.pokedId));

    const items = pagePokes.flatMap((p) => {
      const user = profiles.get(p.pokerId);
      return user
        ? [{
            id: p._id,
            user: toUserSummary(user),
            pokeCount: 1,
            pokedBack: pokedBackSet.has(p.pokerId),
            createdAt: p.createdAt,
          }]
        : [];
    });

    const nextCursor = pokes.length > limit ? pagePokes.at(-1)?.createdAt?.toISOString() : undefined;
    return res.json({ pokes: items, nextCursor });
  } catch (error) {
    logger.error('[Pokes] Error listing received pokes:', { userId: req.user?.id, error });
    return res.status(500).json({ message: 'Error listing received pokes' });
  }
});

router.get('/sent', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const limit = parsePageLimit(req.query.limit);
    const cursor = parseCursor(req.query.cursor);
    const sentQuery = cursor ? { pokerId: userId, createdAt: { $lt: cursor } } : { pokerId: userId };

    const pokes = await Poke.find(sentQuery)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean();
    const pagePokes = pokes.slice(0, limit);
    const pokedIds = pagePokes.map((p) => p.pokedId);
    const profiles = await resolveUsers(pokedIds);

    const items = pagePokes.flatMap((p) => {
      const user = profiles.get(p.pokedId);
      return user
        ? [{
            id: p._id,
            user: toUserSummary(user),
            createdAt: p.createdAt,
          }]
        : [];
    });

    const nextCursor = pokes.length > limit ? pagePokes.at(-1)?.createdAt?.toISOString() : undefined;
    return res.json({ pokes: items, nextCursor });
  } catch (error) {
    logger.error('[Pokes] Error listing sent pokes:', { userId: req.user?.id, error });
    return res.status(500).json({ message: 'Error listing sent pokes' });
  }
});

// Suggested users to poke (followers/following not yet poked)
router.get('/suggested', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const [followersResult, followingResult] = await Promise.all([
      oxy.getUserFollowers(userId).catch(() => []),
      oxy.getUserFollowing(userId).catch(() => []),
    ]);

    const followerIds = extractUsersFromResult(followersResult, 'followers').map((user) => user.id);
    const followingIds = extractUsersFromResult(followingResult, 'following').map((user) => user.id);

    // Merge and deduplicate before querying poke state; do not load the caller's full poke history.
    const candidateIds = [...new Set([...followerIds, ...followingIds])]
      .map(normalizeOxyUserId)
      .filter((id): id is string => !!id && id !== userId)
      .slice(0, SUGGESTION_CANDIDATE_LIMIT);

    const existingPokes = candidateIds.length
      ? await Poke.find({ pokerId: userId, pokedId: { $in: candidateIds } })
        .select('pokedId')
        .limit(candidateIds.length)
        .lean()
      : [];
    const alreadyPokedIds = new Set(existingPokes.map((p) => p.pokedId));

    const limitedIds = candidateIds.filter((id) => !alreadyPokedIds.has(id)).slice(0, SUGGESTION_LIMIT);
    const profiles = await resolveUsers(limitedIds);

    const items = limitedIds.flatMap((id) => {
      const user = profiles.get(id);
      return user ? [{ user: toUserSummary(user) }] : [];
    });

    return res.json({ suggestions: items });
  } catch (error) {
    logger.error('[Pokes] Error listing suggested pokes:', { userId: req.user?.id, error });
    return res.status(500).json({ message: 'Error listing suggested pokes' });
  }
});

// Check if current user has poked a user
router.get('/:userId/status', async (req: AuthRequest, res: Response) => {
  try {
    const pokerId = req.user?.id;
    const { userId } = req.params;
    if (!pokerId) return res.status(401).json({ message: 'Unauthorized' });
    const normalizedUserId = normalizeOxyUserId(userId);
    if (!normalizedUserId) return res.status(400).json({ message: 'Valid userId is required' });

    const exists = await Poke.exists({ pokerId, pokedId: normalizedUserId });
    return res.json({ poked: !!exists });
  } catch (error) {
    logger.error('[Pokes] Error checking poke status:', { userId: req.user?.id, targetId: normalizeOxyUserId(req.params.userId), error });
    return res.status(500).json({ message: 'Error checking poke status' });
  }
});

// Poke a user
router.post('/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const pokerId = req.user?.id;
    const { userId } = req.params;
    if (!pokerId) return res.status(401).json({ message: 'Unauthorized' });
    const normalizedUserId = normalizeOxyUserId(userId);
    if (!normalizedUserId) return res.status(400).json({ message: 'Valid userId is required' });
    if (normalizedUserId === pokerId) return res.status(400).json({ message: 'Cannot poke yourself' });

    const targetUser = await oxy.getUserById(normalizedUserId).catch(() => null);
    if (!targetUser) return res.status(404).json({ message: 'User not found' });

    const result = await Poke.updateOne(
      { pokerId, pokedId: normalizedUserId },
      { $setOnInsert: { pokerId, pokedId: normalizedUserId } },
      { upsert: true }
    );

    // Only send notification when a new poke was created (not on duplicate)
    if (result.upsertedCount === 1) {
      await createNotification({
        recipientId: String(normalizedUserId),
        actorId: String(pokerId),
        type: 'poke',
        entityId: String(pokerId),
        entityType: 'profile',
      });
    }

    return res.json({ poked: true });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return res.json({ poked: true });
    }
    logger.error('[Pokes] Error poking user:', { userId: req.user?.id, targetId: normalizeOxyUserId(req.params.userId), error });
    return res.status(500).json({ message: 'Error poking user' });
  }
});

// Undo poke
router.delete('/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const pokerId = req.user?.id;
    const { userId } = req.params;
    if (!pokerId) return res.status(401).json({ message: 'Unauthorized' });
    const normalizedUserId = normalizeOxyUserId(userId);
    if (!normalizedUserId) return res.status(400).json({ message: 'Valid userId is required' });

    await Poke.deleteOne({ pokerId, pokedId: normalizedUserId });
    return res.json({ poked: false });
  } catch (error) {
    logger.error('[Pokes] Error undoing poke:', { userId: req.user?.id, targetId: normalizeOxyUserId(req.params.userId), error });
    return res.status(500).json({ message: 'Error undoing poke' });
  }
});

export default router;
