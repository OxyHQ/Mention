import { Router, Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { pokes } from '../db/schema/engagement';
import { createNotification } from '../utils/notificationUtils';
import { logger } from '../utils/logger';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import type { User } from '@oxyhq/core';

const router = Router();

/** Resolve an array of Oxy user IDs into profile objects (best-effort). */
async function resolveUsers(ids: string[]): Promise<Map<string, User>> {
  const map = new Map<string, User>();
  if (ids.length === 0) return map;
  try {
    // Single batched round-trip instead of one getUserById per id.
    const users = await getServiceOxyClient().getUsersByIds(ids);
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

function extractUsersFromResult(result: unknown, key: 'followers' | 'following'): User[] {
  const list = isRecord(result) ? result[key] : result;
  return Array.isArray(list) ? list.filter((user): user is User => isRecord(user) && typeof user.id === 'string') : [];
}

const POKES_LIMIT = 100;

router.get('/received', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const db = getDb();
    // Ordered by `created_at` descending to match `pokes_poked_id_created_at_idx`
    // exactly, as Mongo did. This is a bounded list, not a paginated one — there
    // is no cursor to straddle, so no tiebreak column is owed.
    const received = await db
      .select()
      .from(pokes)
      .where(eq(pokes.pokedId, userId))
      .orderBy(desc(pokes.createdAt))
      .limit(POKES_LIMIT);
    const pokerIds = received.map((p) => p.pokerId);
    const pokedBackRows = pokerIds.length > 0
      ? await db
          .select({ pokedId: pokes.pokedId })
          .from(pokes)
          .where(and(eq(pokes.pokerId, userId), inArray(pokes.pokedId, pokerIds)))
      : [];

    const pokedBackSet = new Set(pokedBackRows.map((p) => p.pokedId));
    const profiles = await resolveUsers(pokerIds);

    const items = received.flatMap((p) => {
      const user = profiles.get(p.pokerId);
      return user
        ? [{
            id: p.id,
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

    const sent = await getDb()
      .select()
      .from(pokes)
      .where(eq(pokes.pokerId, userId))
      .orderBy(desc(pokes.createdAt))
      .limit(POKES_LIMIT);
    const pokedIds = sent.map((p) => p.pokedId);
    const profiles = await resolveUsers(pokedIds);

    const items = sent.flatMap((p) => {
      const user = profiles.get(p.pokedId);
      return user
        ? [{
            id: p.id,
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
    const oxy = getServiceOxyClient();
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
      ? await getDb()
          .select({ pokedId: pokes.pokedId })
          .from(pokes)
          .where(and(eq(pokes.pokerId, userId), inArray(pokes.pokedId, candidatePool)))
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
    // Express 5 types every path param `string | string[]`; a non-string is
    // treated as ABSENT (the 400 below) rather than coerced, because `String([x])`
    // would silently manufacture a plausible id for a `text` column to match.
    const userId = typeof req.params.userId === 'string' ? req.params.userId : undefined;
    if (!pokerId) return res.status(401).json({ message: 'Unauthorized' });
    if (!userId) return res.status(400).json({ message: 'userId is required' });

    const [existing] = await getDb()
      .select({ id: pokes.id })
      .from(pokes)
      .where(and(eq(pokes.pokerId, pokerId), eq(pokes.pokedId, userId)))
      .limit(1);
    return res.json({ poked: !!existing });
  } catch (error) {
    logger.error('[Pokes] Error checking poke status:', { userId: req.user?.id, targetId: req.params.userId, error });
    return res.status(500).json({ message: 'Error checking poke status' });
  }
});

// Poke a user
router.post('/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const pokerId = req.user?.id;
    // Express 5 types every path param `string | string[]`; a non-string is
    // treated as ABSENT (the 400 below) rather than coerced, because `String([x])`
    // would silently manufacture a plausible id for a `text` column to match.
    const userId = typeof req.params.userId === 'string' ? req.params.userId : undefined;
    if (!pokerId) return res.status(401).json({ message: 'Unauthorized' });
    if (!userId) return res.status(400).json({ message: 'userId is required' });
    if (userId === pokerId) return res.status(400).json({ message: 'Cannot poke yourself' });

    // One active poke per ORDERED pair — `pokes_poker_id_poked_id_key` is
    // directional, so A→B and B→A are two rows. `ON CONFLICT DO NOTHING` on that
    // pair replaces the Mongo upsert AND its duplicate-key rescue in one
    // statement: a re-poke returns the same `{poked: true}` without a second row
    // and, crucially, without a second notification. An empty `returning()` is
    // what says "already poked", the same fact `upsertedCount` carried.
    const inserted = await getDb()
      .insert(pokes)
      .values({ pokerId, pokedId: userId })
      .onConflictDoNothing({ target: [pokes.pokerId, pokes.pokedId] })
      .returning({ id: pokes.id });

    // Only send notification when a new poke was created (not on duplicate)
    if (inserted.length === 1) {
      await createNotification({
        recipientId: userId,
        actorId: pokerId,
        type: 'poke',
        entityId: pokerId,
        entityType: 'profile',
      });
    }

    return res.json({ poked: true });
  } catch (error) {
    logger.error('[Pokes] Error poking user:', { userId: req.user?.id, targetId: req.params.userId, error });
    return res.status(500).json({ message: 'Error poking user' });
  }
});

// Undo poke
router.delete('/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const pokerId = req.user?.id;
    // Express 5 types every path param `string | string[]`; a non-string is
    // treated as ABSENT (the 400 below) rather than coerced, because `String([x])`
    // would silently manufacture a plausible id for a `text` column to match.
    const userId = typeof req.params.userId === 'string' ? req.params.userId : undefined;
    if (!pokerId) return res.status(401).json({ message: 'Unauthorized' });
    if (!userId) return res.status(400).json({ message: 'userId is required' });

    await getDb()
      .delete(pokes)
      .where(and(eq(pokes.pokerId, pokerId), eq(pokes.pokedId, userId)));
    return res.json({ poked: false });
  } catch (error) {
    logger.error('[Pokes] Error undoing poke:', { userId: req.user?.id, targetId: req.params.userId, error });
    return res.status(500).json({ message: 'Error undoing poke' });
  }
});

export default router;
