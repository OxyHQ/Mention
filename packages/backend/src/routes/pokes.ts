import { Router, Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import Poke from '../models/Poke';
import { createNotification } from '../utils/notificationUtils';
import { logger } from '../utils/logger';
import { oxy } from '../../server';
import type { User } from '@oxyhq/core';

const router = Router();

/** Resolve an array of Oxy user IDs into profile objects (best-effort). */
async function resolveUsers(ids: string[]): Promise<Map<string, User>> {
  const map = new Map<string, User>();
  if (ids.length === 0) return map;
  try {
    // Single batched round-trip instead of one getUserById per id.
    const users = await oxy.getUsersByIds(ids);
    for (const user of users) {
      if (user?.id) map.set(user.id, user);
    }
  } catch (error) {
    logger.warn('[Pokes] Failed to resolve users in batch:', { count: ids.length, error });
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

const POKES_LIMIT = 100;

router.get('/received', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const pokes = await Poke.find({ pokedId: userId }).sort({ createdAt: -1 }).limit(POKES_LIMIT).lean();
    const pokerIds = pokes.map((p) => p.pokerId);
    const pokedBackDocs = pokerIds.length > 0
      ? await Poke.find({ pokerId: userId, pokedId: { $in: pokerIds } }).select('pokedId').lean()
      : [];

    const pokedBackSet = new Set(pokedBackDocs.map((p) => p.pokedId));
    const profiles = await resolveUsers(pokerIds);

    const items = pokes.flatMap((p) => {
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

    return res.json({ pokes: items });
  } catch (error) {
    logger.error('[Pokes] Error listing received pokes:', { userId: req.user?.id, error });
    return res.status(500).json({ message: 'Error listing received pokes' });
  }
});

router.get('/sent', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const pokes = await Poke.find({ pokerId: userId }).sort({ createdAt: -1 }).limit(POKES_LIMIT).lean();
    const pokedIds = pokes.map((p) => p.pokedId);
    const profiles = await resolveUsers(pokedIds);

    const items = pokes.flatMap((p) => {
      const user = profiles.get(p.pokedId);
      return user
        ? [{
            id: p._id,
            user: toUserSummary(user),
            createdAt: p.createdAt,
          }]
        : [];
    });

    return res.json({ pokes: items });
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

    // Fetch followers and following in parallel. Do NOT load the caller's full
    // poke history — only the poke state for the suggestion candidates is
    // needed, and an unbounded `Poke.find({ pokerId })` scans every poke the
    // caller has ever sent.
    const [followersResult, followingResult] = await Promise.all([
      oxy.getUserFollowers(userId).catch(() => []),
      oxy.getUserFollowing(userId).catch(() => []),
    ]);

    const followerIds = extractUsersFromResult(followersResult, 'followers').map((user) => user.id);
    const followingIds = extractUsersFromResult(followingResult, 'following').map((user) => user.id);

    // Merge and deduplicate the follow graph, excluding self.
    const candidatePool = [...new Set([...followerIds, ...followingIds])]
      .filter((id) => id !== userId);

    // Bound the poke-state lookup to the suggestion candidates instead of the
    // caller's entire poke history.
    const existingPokes = candidatePool.length > 0
      ? await Poke.find({ pokerId: userId, pokedId: { $in: candidatePool } }).select('pokedId').lean()
      : [];
    const alreadyPokedIds = new Set(existingPokes.map((p) => p.pokedId));

    // Exclude already-poked candidates, then limit to 20 suggestions.
    const limitedIds = candidatePool.filter((id) => !alreadyPokedIds.has(id)).slice(0, 20);
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
    if (!userId) return res.status(400).json({ message: 'userId is required' });

    const exists = await Poke.exists({ pokerId, pokedId: userId });
    return res.json({ poked: !!exists });
  } catch (error) {
    logger.error('[Pokes] Error checking poke status:', { userId: req.user?.id, targetId: req.params.userId, error });
    return res.status(500).json({ message: 'Error checking poke status' });
  }
});

// Poke a user
router.post('/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const pokerId = req.user?.id;
    const { userId } = req.params;
    if (!pokerId) return res.status(401).json({ message: 'Unauthorized' });
    if (!userId) return res.status(400).json({ message: 'userId is required' });
    if (userId === pokerId) return res.status(400).json({ message: 'Cannot poke yourself' });

    const result = await Poke.updateOne(
      { pokerId, pokedId: userId },
      { $setOnInsert: { pokerId, pokedId: userId } },
      { upsert: true }
    );

    // Only send notification when a new poke was created (not on duplicate)
    if (result.upsertedCount === 1) {
      await createNotification({
        recipientId: String(userId),
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
    logger.error('[Pokes] Error poking user:', { userId: req.user?.id, targetId: req.params.userId, error });
    return res.status(500).json({ message: 'Error poking user' });
  }
});

// Undo poke
router.delete('/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const pokerId = req.user?.id;
    const { userId } = req.params;
    if (!pokerId) return res.status(401).json({ message: 'Unauthorized' });
    if (!userId) return res.status(400).json({ message: 'userId is required' });

    await Poke.deleteOne({ pokerId, pokedId: userId });
    return res.json({ poked: false });
  } catch (error) {
    logger.error('[Pokes] Error undoing poke:', { userId: req.user?.id, targetId: req.params.userId, error });
    return res.status(500).json({ message: 'Error undoing poke' });
  }
});

export default router;
