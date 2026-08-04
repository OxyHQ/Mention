import { Router, Response } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { mutes } from '../db/schema/engagement';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { viewerOperatesAccount } from '../services/operatedAccountAccess';
import { createUserScopedOxyServices } from '../utils/oxyHelpers';
import { logger } from '../utils/logger';

const router = Router();

/**
 * A mute exactly as it goes on the wire.
 *
 * `_id` is what a Mongoose document serialized to and what any client holding an
 * old response still keys on, so the port keeps it. Mongoose's `__v` is dropped:
 * nothing reads it and `CONVENTIONS.md` forbids the column.
 */
interface SerializedMute {
  _id: string;
  userId: string;
  mutedId: string;
  createdAt: Date;
}

function serializeMute(row: typeof mutes.$inferSelect): SerializedMute {
  return {
    _id: row.id,
    userId: row.userId,
    mutedId: row.mutedId,
    createdAt: row.createdAt,
  };
}

/**
 * Mute a user
 * POST /api/mute
 */
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { mutedId } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!mutedId || typeof mutedId !== 'string') {
      return res.status(400).json({ message: 'mutedId is required' });
    }

    /**
     * You cannot mute an account you OPERATE.
     *
     * This used to read `userId === mutedId`, which is the same rule stated
     * narrowly enough to be wrong: a channel / organization / project / bot you
     * publish as is never your own id, so muting one passed. Muting hides your own
     * account's posts from your own feeds, which is not a preference anybody
     * holds — and for a channel with several members it also hides work written by
     * the others, from an operator who has no obvious way to connect the empty
     * feed to a row they tapped once.
     *
     * `viewerOperatesAccount` still answers `true` for `userId === mutedId`, so
     * self-muting stays refused; it is now one case of the general rule rather than
     * the only case anybody remembered to write down. 400 for the same reason the
     * report route gives.
     */
    const operatesTarget = await viewerOperatesAccount({
      targetOxyUserId: mutedId,
      callerId: userId,
      memberReader: createUserScopedOxyServices(req),
    });
    if (operatesTarget) {
      return res.status(400).json({ message: 'You cannot mute an account you operate' });
    }

    // `mutes_user_id_muted_id_key` decides "already muted", instead of a read
    // followed by a write that two concurrent taps could both pass — that race
    // used to surface as a duplicate-key 500 on the loser. An empty
    // `returning()` means the row was already there, which is the 200 branch.
    const db = getDb();
    const [created] = await db
      .insert(mutes)
      .values({ userId, mutedId })
      .onConflictDoNothing({ target: [mutes.userId, mutes.mutedId] })
      .returning();

    if (!created) {
      const [existing] = await db
        .select()
        .from(mutes)
        .where(and(eq(mutes.userId, userId), eq(mutes.mutedId, mutedId)))
        .limit(1);
      return res.status(200).json({
        message: 'User already muted',
        mute: existing ? serializeMute(existing) : undefined
      });
    }

    logger.debug('User mute created');

    res.status(201).json({
      message: 'User muted successfully',
      mute: serializeMute(created)
    });
  } catch (error) {
    logger.error('Error muting user:', { userId: req.user?.id, mutedId: req.body.mutedId, error });
    res.status(500).json({
      message: 'Error muting user',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Unmute a user
 * DELETE /api/mute/:mutedId
 */
router.delete('/:mutedId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    // Express 5 types every path param `string | string[]`; a non-string is
    // treated as ABSENT (the 400 below) rather than coerced.
    const mutedId = typeof req.params.mutedId === 'string' ? req.params.mutedId : undefined;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!mutedId) {
      return res.status(400).json({ message: 'mutedId is required' });
    }

    // Delete mute record
    const [result] = await getDb()
      .delete(mutes)
      .where(and(eq(mutes.userId, userId), eq(mutes.mutedId, mutedId)))
      .returning({ id: mutes.id });

    if (!result) {
      return res.status(404).json({ message: 'Mute not found' });
    }

    logger.debug('User mute removed');

    res.json({
      message: 'User unmuted successfully'
    });
  } catch (error) {
    logger.error('Error unmuting user:', { userId: req.user?.id, mutedId: req.params.mutedId, error });
    res.status(500).json({
      message: 'Error unmuting user',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Get muted users list for current user
 * GET /api/mute
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Newest first, with the primary key as the tiebreak. `created_at` is not
    // unique, and this list has no cursor to lose a tied row across — the
    // tiebreak is here so two mutes made in the same millisecond come back in a
    // stable order rather than whichever the planner happened to emit.
    const rows = await getDb()
      .select()
      .from(mutes)
      .where(eq(mutes.userId, userId))
      .orderBy(desc(mutes.createdAt), desc(mutes.id));

    res.json({
      mutes: rows.map(serializeMute),
      count: rows.length
    });
  } catch (error) {
    logger.error('Error fetching muted users:', { userId: req.user?.id, error });
    res.status(500).json({
      message: 'Error fetching muted users',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Check if a user is muted
 * GET /api/mute/check/:userId
 */
router.get('/check/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const currentUserId = req.user?.id;
    const userId = typeof req.params.userId === 'string' ? req.params.userId : undefined;

    if (!currentUserId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!userId) {
      return res.status(400).json({ message: 'userId is required' });
    }

    const [mute] = await getDb()
      .select({ id: mutes.id })
      .from(mutes)
      .where(and(eq(mutes.userId, currentUserId), eq(mutes.mutedId, userId)))
      .limit(1);

    res.json({
      isMuted: !!mute
    });
  } catch (error) {
    logger.error('Error checking mute status:', { userId: req.user?.id, targetUserId: req.params.userId, error });
    res.status(500).json({
      message: 'Error checking mute status',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
