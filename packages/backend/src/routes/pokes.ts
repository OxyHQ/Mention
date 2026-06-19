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
  await Promise.all(
    ids.map(async (id) => {
      try {
        const user = await oxy.getUserById(id);
        if (user) map.set(id, user);
      } catch { /* skip unresolvable */ }
    }),
  );
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

    const [pokes, pokedBackDocs] = await Promise.all([
      Poke.find({ pokedId: userId }).sort({ createdAt: -1 }).limit(POKES_LIMIT).lean(),
      Poke.find({ pokerId: userId }).select('pokedId').lean(),
    ]);

    const pokedBackSet = new Set(pokedBackDocs.map((p) => p.pokedId));
    const pokerIds = pokes.map((p) => p.pokerId);
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

    // Fetch existing pokes, followers, and following in parallel
    const [existingPokes, followersResult, followingResult] = await Promise.all([
      Poke.find({ pokerId: userId }).select('pokedId').lean(),
      oxy.getUserFollowers(userId).catch(() => []),
      oxy.getUserFollowing(userId).catch(() => []),
    ]);
    const alreadyPokedIds = new Set(existingPokes.map((p) => p.pokedId));

    const followerIds = extractUsersFromResult(followersResult, 'followers').map((user) => user.id);
    const followingIds = extractUsersFromResult(followingResult, 'following').map((user) => user.id);

    // Merge and deduplicate, excluding self and already-poked
    const candidateIds = [...new Set([...followerIds, ...followingIds])]
      .filter((id) => id !== userId && !alreadyPokedIds.has(id));

    // Limit to 20 suggestions
    const limitedIds = candidateIds.slice(0, 20);
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
