import { Router, type Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { pokes } from '../db/schema/engagement';
import { createNotification } from '../utils/notificationUtils';
import { logger } from '../utils/logger';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { blockedEitherWay } from '../utils/privacyHelpers';
import { safetyRequesterFor } from '../utils/safetyRequester';
import type { User } from '@oxy.so/core';
import type { PostUser } from '@mention/shared-types';
import { resolveActorProfiles } from '../utils/notificationActor';

const router = Router();

/** The public identity a pokes list carries for each person. */
function toUserSummary(user: PostUser) {
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
  return Array.isArray(list)
    ? list.filter((user): user is User => isRecord(user) && typeof user.id === 'string')
    : [];
}

const POKES_LIMIT = 100;
/** Suggestion candidates block-checked per request: one Oxy batch. */
const POKE_SUGGESTION_BLOCK_WINDOW = 100;

router.get('/received', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const db = getDb();
    // Ordered by `created_at` descending to match `pokes_poked_id_created_at_idx`
    // exactly. This is a bounded list, not a paginated one — there
    // is no cursor to straddle, so no tiebreak column is owed.
    const received = await db
      .select()
      .from(pokes)
      .where(eq(pokes.pokedId, userId))
      .orderBy(desc(pokes.createdAt))
      .limit(POKES_LIMIT);
    // The same block policy the write path enforces, applied to this read: a
    // poke from someone a block now separates from the viewer, either way,
    // stays in `pokes` (blocking does not rewrite history) but does not surface.
    const blockedIds = await blockedEitherWay(
      safetyRequesterFor(req),
      received.map((p) => p.pokerId),
    );
    const visibleReceived = received.filter((p) => !blockedIds.has(p.pokerId));

    const pokerIds = visibleReceived.map((p) => p.pokerId);
    // Independent reads: whom the viewer poked back, and who the pokers are.
    const [pokedBackRows, profiles] = await Promise.all([
      pokerIds.length > 0
        ? db
            .select({ pokedId: pokes.pokedId })
            .from(pokes)
            .where(and(eq(pokes.pokerId, userId), inArray(pokes.pokedId, pokerIds)))
        : [],
      resolveActorProfiles(pokerIds),
    ]);

    const pokedBackSet = new Set(pokedBackRows.map((p) => p.pokedId));

    const items = visibleReceived.flatMap((p) => {
      const user = profiles.get(p.pokerId);
      return user
        ? [
            {
              id: p.id,
              user: toUserSummary(user),
              pokeCount: 1,
              pokedBack: pokedBackSet.has(p.pokerId),
              createdAt: p.createdAt,
            },
          ]
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
    const profiles = await resolveActorProfiles(pokedIds);

    const items = sent.flatMap((p) => {
      const user = profiles.get(p.pokedId);
      return user
        ? [
            {
              id: p.id,
              user: toUserSummary(user),
              createdAt: p.createdAt,
            },
          ]
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
      oxy.follows.followers(userId).catch(() => []),
      oxy.follows.following(userId).catch(() => []),
    ]);

    const followerIds = extractUsersFromResult(followersResult, 'followers').map((user) => user.id);
    const followingIds = extractUsersFromResult(followingResult, 'following').map(
      (user) => user.id,
    );

    // Merge and deduplicate the follow graph, excluding self.
    const candidatePool = [...new Set([...followerIds, ...followingIds])].filter(
      (id) => id !== userId,
    );

    // Bound the poke-state lookup to the suggestion candidates instead of the
    // caller's entire poke history.
    const existingPokes =
      candidatePool.length > 0
        ? await getDb()
            .select({ pokedId: pokes.pokedId })
            .from(pokes)
            .where(and(eq(pokes.pokerId, userId), inArray(pokes.pokedId, candidatePool)))
        : [];
    const alreadyPokedIds = new Set(existingPokes.map((p) => p.pokedId));

    // Exclude already-poked candidates and anyone a block separates from the
    // viewer, either way — the policy `POST /:userId` enforces, applied to what
    // gets SUGGESTED — then limit to 20. The block check reads one Oxy batch.
    const unpoked = candidatePool
      .filter((id) => !alreadyPokedIds.has(id))
      .slice(0, POKE_SUGGESTION_BLOCK_WINDOW);
    const blockedIds = await blockedEitherWay(safetyRequesterFor(req), unpoked);
    const limitedIds = unpoked.filter((id) => !blockedIds.has(id)).slice(0, 20);
    const profiles = await resolveActorProfiles(limitedIds);

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
    logger.error('[Pokes] Error checking poke status:', {
      userId: req.user?.id,
      targetId: req.params.userId,
      error,
    });
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

    // Oxy is the sole authority for the block relationship between these two
    // accounts — Mention holds no copy of it. `blockedEitherWay` asks Oxy with
    // the caller's own proof, and Oxy answers both directions, which is what
    // "respect the block policy either way" requires. (`privacy.isBlocked`
    // reads only the caller's OWN block list: one direction.)
    //
    // An unanswerable check is refused, not treated as permission — the same
    // fail-closed rule `canViewerAccessPoll`/`canViewerReadPostId` use.
    try {
      if ((await blockedEitherWay(safetyRequesterFor(req), [userId])).has(userId)) {
        return res.status(403).json({ message: 'You cannot poke this user' });
      }
    } catch (error) {
      logger.warn('[Pokes] Refusing poke: block relationship could not be verified', {
        userId: pokerId,
        targetId: userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return res.status(403).json({ message: 'Unable to verify you may contact this user' });
    }

    // One active poke per ORDERED pair — `pokes_poker_id_poked_id_key` is
    // directional, so A→B and B→A are two rows. `ON CONFLICT DO NOTHING` on that
    // pair is the upsert AND its duplicate-key rescue in one statement: a re-poke returns the same `{poked: true}` without a second row
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
    logger.error('[Pokes] Error poking user:', {
      userId: req.user?.id,
      targetId: req.params.userId,
      error,
    });
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
    logger.error('[Pokes] Error undoing poke:', {
      userId: req.user?.id,
      targetId: req.params.userId,
      error,
    });
    return res.status(500).json({ message: 'Error undoing poke' });
  }
});

export default router;
