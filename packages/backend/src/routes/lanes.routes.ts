/**
 * Lanes API — a publisher's own named carriageways, and a reader's mutes.
 *
 * Two routers, because the two halves answer to different people:
 *
 *  - {@link publicLanesRouter} is reader-agnostic and cacheable: the lanes a
 *    visitor needs in order to draw a profile's tabs.
 *  - {@link default} (the authenticated router) is everything scoped to the
 *    caller — their own lanes, and the lanes they have silenced.
 *
 * EXPRESS ORDERING: `/mine` and `/muted` are declared BEFORE `/:id`, or `:id`
 * swallows them. Same dodge `routes/posts.ts` already makes for
 * `/bookmarks/folders`.
 */

import { Router, type Request, type Response } from 'express';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  LANE_DISPLAY_MODES,
  MAX_LANES_PER_OWNER,
  MAX_LANE_NAME_LENGTH,
  MAX_MUTED_LANES,
  type LaneDisplayMode,
  type MutedLane,
  type PostUser,
} from '@mention/shared-types';
import {
  requireOxyAuth as requireAuth,
  getRequiredOxyUserId as getAuthenticatedUserId,
  type OxyAuthRequest as AuthRequest,
} from '@oxyhq/core/server';
import { getDb } from '../db/postgres';
import { isUniqueViolation } from '@oxyhq/db';
import { laneMutes, lanes } from '../db/schema/channels';
import { posts } from '../db/schema/posts';
import {
  insertLane,
  normalizeLaneName,
  updateLane,
  type LaneRow,
} from '../db/channels/laneRepository';
import { resolveUserSummaries } from '../services/PostHydrationService';
import { validateBody, validateObjectId } from '../middleware/validate';
import { laneReadRateLimiter, laneWriteRateLimiter, lanesRateLimiter } from '../middleware/security';
import { config } from '../config';
import { sendErrorResponse, sendSuccessResponse } from '../utils/apiHelpers';
import { logger } from '../utils/logger';

/**
 * Compliance limiters, production-gated like every other limiter in the repo.
 * Spread per route rather than applied with `router.use`, so a read never spends
 * the write budget and the grouping is legible where it applies.
 *
 * `GET /lanes/mine` keeps {@link lanesRateLimiter} INSTEAD of these: it is the
 * one route here bounding a real cost (an uncached aggregation over the caller's
 * whole post history) rather than satisfying a scanner, and it has its own
 * behavioural test.
 */
const readLimiters = config.runtime.isProduction ? [laneReadRateLimiter] : [];
const writeLimiters = config.runtime.isProduction ? [laneWriteRateLimiter] : [];

/** Longest owner id we will look up — an Oxy user id is a 24-char hex ObjectId. */
const MAX_OWNER_ID_LENGTH = 64;

const laneDisplayModeSchema = z.enum(
  LANE_DISPLAY_MODES as unknown as [LaneDisplayMode, ...LaneDisplayMode[]],
);

const createLaneSchema = z.object({
  name: z
    .string()
    .min(1, 'name is required')
    .max(MAX_LANE_NAME_LENGTH, `name must be ${MAX_LANE_NAME_LENGTH} characters or less`)
    .transform((value) => value.trim()),
  displayMode: laneDisplayModeSchema.optional(),
});

const updateLaneSchema = z.object({
  name: z
    .string()
    .min(1, 'name must not be empty')
    .max(MAX_LANE_NAME_LENGTH, `name must be ${MAX_LANE_NAME_LENGTH} characters or less`)
    .transform((value) => value.trim())
    .optional(),
  displayMode: laneDisplayModeSchema.optional(),
});

/**
 * The unique constraint whose violation IS the 409 on create and rename: one
 * lane name per publisher. Named so a future index on `lanes` cannot quietly
 * start answering "you already have a lane with that name" — see
 * `@oxyhq/db`'s `pgErrors.ts`.
 */
const LANE_NAME_UNIQUE = 'lanes_owner_name_lower_key';

interface SerializedLane {
  id: string;
  ownerId: string;
  name: string;
  displayMode: LaneDisplayMode;
  createdAt: Date;
  updatedAt: Date;
  postCount?: number;
}

function serialize(row: LaneRow, postCount?: number): SerializedLane {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    displayMode: row.displayMode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(postCount === undefined ? {} : { postCount }),
  };
}

/**
 * How many posts sit in each of `laneIds`, in ONE aggregate served by
 * `post_lane_chrono_v1`. A lane with no posts is simply absent from the result,
 * which the caller reads as zero.
 *
 * Counted on read rather than denormalized: a stored counter would have to be
 * maintained on create, on a lane move, on delete and in every admin purge, and
 * a wrong count is worse than no count.
 */
/**
 * Whether this caller may edit or delete THIS lane, read from the lane's own
 * owner rather than from anything the request supplied — so a caller cannot name
 * a publisher they happen to control and reach a lane belonging to another.
 *
 * A lane's publisher is one `ownerId` and the caller is one `oxyUserId`, so this
 * is one comparison. A CHANNEL's lanes are not reachable here: the caller is
 * always themselves, never the channel account, so a channel lane answers 404
 * exactly as any other publisher's does. Managing them needs the account-graph
 * membership check `publishAsOxyUserId` goes through, which this route does not
 * make.
 */
function callerManagesLane(lane: { ownerId: string }, userId: string): boolean {
  return lane.ownerId === userId;
}

async function countPostsByLane(laneIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (laneIds.length === 0) return counts;

  // `::int` so postgres.js hands back a NUMBER — a bare `count(*)` is a bigint,
  // which the driver returns as a STRING, and the count would silently change
  // type on the wire.
  const rows = await getDb()
    .select({ laneId: posts.laneId, total: sql<number>`count(*)::int` })
    .from(posts)
    .where(inArray(posts.laneId, laneIds))
    .groupBy(posts.laneId);
  for (const row of rows) {
    if (row.laneId) counts.set(row.laneId, row.total);
  }
  return counts;
}

/* ------------------------------------------------------------------------- */
/* Public                                                                     */
/* ------------------------------------------------------------------------- */

export const publicLanesRouter = Router();

// The ANONYMOUS-reachable surface — no account needed — so the limiter is earned
// rather than cosmetic: an unauthenticated caller keys to a hashed IP.
//
// Mounted PER ROUTE below rather than with `router.use`: an empty spread makes
// `use()` throw outside production, AND a `use` behind an `if` is invisible to
// CodeQL, whose dataflow does not follow a conditional. See the sibling note in
// `channels.routes.ts`.

/**
 * GET /lanes?ownerId=<id>
 *
 * The publisher's lanes that HAVE a tab — `displayMode: 'tab'` and nothing else.
 * `mixed` has no tab of its own and `hidden` is off the showcase, so neither
 * belongs in a list whose only purpose is drawing tabs.
 *
 * Reader-agnostic on purpose: it answers the same thing for everyone, which is
 * what makes it cacheable. Whether the reader may see the publisher's posts at
 * all is enforced where the posts are served (`laneSource`'s
 * `canViewAuthorFeed`), not here — a lane name is not a post.
 */
publicLanesRouter.get('/', ...readLimiters, async (req: Request, res: Response) => {
  try {
    const ownerId = typeof req.query.ownerId === 'string' ? req.query.ownerId.trim() : '';
    if (!ownerId || ownerId.length > MAX_OWNER_ID_LENGTH) {
      return sendErrorResponse(res, 400, 'Bad Request', 'ownerId is required');
    }

    const tabs = await getDb()
      .select()
      .from(lanes)
      .where(and(eq(lanes.ownerId, ownerId), eq(lanes.displayMode, 'tab')))
      .orderBy(desc(lanes.createdAt));

    return sendSuccessResponse(res, 200, tabs.map((lane) => serialize(lane)));
  } catch (err) {
    logger.error('[Lanes] Error listing public lanes:', { error: err });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to list lanes');
  }
});

/* ------------------------------------------------------------------------- */
/* Authenticated                                                              */
/* ------------------------------------------------------------------------- */

const router = Router();

// Defensive — the parent router already enforces it.
router.use(requireAuth);

/**
 * GET /lanes/mine
 * The caller's own lanes, newest first, each with its current post count.
 *
 * The management view, so unlike the public list it includes `mixed` and `hidden`
 * lanes.
 */
router.get(
  '/mine',
  // The one lanes route whose cost scales with the caller's own history:
  // `countPostsByLane` aggregates over every lane-bearing post they have written,
  // uncached and unpaged. Production-gated like every other limiter here, so tests
  // and local development are unaffected.
  ...(config.runtime.isProduction ? [lanesRateLimiter] : []),
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const owned = await getDb()
        .select()
        .from(lanes)
        .where(eq(lanes.ownerId, userId))
        .orderBy(desc(lanes.createdAt));

      const counts = await countPostsByLane(owned.map((lane) => lane.id));
      const items = owned.map((lane) => serialize(lane, counts.get(lane.id) ?? 0));
      return sendSuccessResponse(res, 200, items);
    } catch (err) {
      logger.error('[Lanes] Error listing own lanes:', { userId: req.user?.id, error: err });
      return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to list lanes');
    }
  },
);

/**
 * GET /lanes/muted
 * The lanes this reader has silenced, newest mute first, each with the publisher
 * it belongs to.
 *
 * The owner is resolved through {@link resolveUserSummaries} — the same identity
 * path every post author goes through — never assembled by hand.
 */
router.get('/muted', ...readLimiters, async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const db = getDb();
    const mutes = await db
      .select({
        laneId: laneMutes.laneId,
        laneOwnerOxyUserId: laneMutes.laneOwnerOxyUserId,
        createdAt: laneMutes.createdAt,
      })
      .from(laneMutes)
      .where(eq(laneMutes.viewerOxyUserId, userId))
      .orderBy(desc(laneMutes.createdAt))
      .limit(MAX_MUTED_LANES);

    if (mutes.length === 0) {
      return sendSuccessResponse(res, 200, []);
    }

    const [muted, owners] = await Promise.all([
      db
        .select({ id: lanes.id, name: lanes.name, displayMode: lanes.displayMode })
        .from(lanes)
        .where(inArray(lanes.id, mutes.map((mute) => mute.laneId))),
      resolveUserSummaries(mutes.map((mute) => mute.laneOwnerOxyUserId)),
    ]);

    const laneById = new Map(muted.map((lane) => [lane.id, lane]));
    const items: MutedLane[] = [];
    for (const mute of mutes) {
      const lane = laneById.get(mute.laneId);
      // A mute whose lane is gone. `lane_mutes.lane_id` is `ON DELETE CASCADE`,
      // so an orphan cannot persist — but the mutes and the lanes are two
      // statements, and a lane deleted between them lands exactly here. Drop the
      // row rather than render a blank one.
      if (!lane) continue;
      const owner: PostUser | undefined = owners.get(mute.laneOwnerOxyUserId)?.user;
      if (!owner) continue;
      items.push({
        lane: { id: lane.id, name: lane.name, displayMode: lane.displayMode },
        owner,
        createdAt: mute.createdAt.toISOString(),
      });
    }

    return sendSuccessResponse(res, 200, items);
  } catch (err) {
    logger.error('[Lanes] Error listing muted lanes:', { userId: req.user?.id, error: err });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to list muted lanes');
  }
});

/**
 * POST /lanes
 * Body: `{ name: string, displayMode?: 'mixed'|'tab'|'hidden' }`
 *
 * The 409 comes from the UNIQUE `{ownerId, nameLower}` index, not from
 * the pre-check: `countDocuments` is not a lock, so two concurrent creates of the
 * same name are stopped by the constraint or not at all.
 */
router.post('/', ...writeLimiters, validateBody(createLaneSchema), async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { name, displayMode } = req.body as z.infer<typeof createLaneSchema>;

    const nameLower = normalizeLaneName(name);
    if (!nameLower) {
      return sendErrorResponse(res, 400, 'Bad Request', 'name must not be empty after normalization');
    }

    // The cap is PER PUBLISHER.
    const [owned] = await getDb()
      .select({ total: sql<number>`count(*)::int` })
      .from(lanes)
      .where(eq(lanes.ownerId, userId));
    if (owned.total >= MAX_LANES_PER_OWNER) {
      return sendErrorResponse(
        res,
        400,
        'Bad Request',
        `You can have at most ${MAX_LANES_PER_OWNER} lanes`,
      );
    }

    try {
      const created = await insertLane({
        ownerId: userId,
        name,
        displayMode: displayMode ?? 'mixed',
      });
      return sendSuccessResponse(res, 201, serialize(created, 0), 'Lane created');
    } catch (createErr) {
      if (isUniqueViolation(createErr, LANE_NAME_UNIQUE)) {
        return sendErrorResponse(res, 409, 'Conflict', 'You already have a lane with that name');
      }
      throw createErr;
    }
  } catch (err) {
    logger.error('[Lanes] Error creating lane:', { userId: req.user?.id, error: err });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to create lane');
  }
});

/**
 * PATCH /lanes/:id
 * Body: `{ name?: string, displayMode?: 'mixed'|'tab'|'hidden' }`
 *
 * Renaming is free, and a lane deliberately has NO slug: the tab routes by id, so
 * a slug would be either immutable (stale the moment somebody renames) or
 * regenerated (breaking the URL), and it would add a second uniqueness
 * constraint and a whole class of collisions to carry forever. The only derived
 * identity a lane has is `name_lower`, which `db/channels/laneRepository.ts`
 * owns. Changing `displayMode` changes which posts a profile tab CONTAINS, so
 * the client has to invalidate both of its post-list caches afterwards.
 */
router.patch(
  '/:id',
  ...writeLimiters,
  validateObjectId('id'),
  validateBody(updateLaneSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const { name, displayMode } = req.body as z.infer<typeof updateLaneSchema>;

      if (name === undefined && displayMode === undefined) {
        return sendErrorResponse(res, 400, 'Bad Request', 'Nothing to update');
      }

      // Scoped by the lane's OWN publisher, read from the row rather than from
      // the request, so somebody else's lane stays a 404 and not an oracle.
      const laneId = String(req.params.id);
      const [lane] = await getDb()
        .select({ ownerId: lanes.ownerId })
        .from(lanes)
        .where(eq(lanes.id, laneId))
        .limit(1);
      if (!lane || !callerManagesLane(lane, userId)) {
        return sendErrorResponse(res, 404, 'Not Found', 'Lane not found');
      }

      if (name !== undefined && !normalizeLaneName(name)) {
        return sendErrorResponse(res, 400, 'Bad Request', 'name must not be empty after normalization');
      }

      let updated: LaneRow | null;
      try {
        // `name_lower` follows from the repository's own derivation, so the
        // normalization has exactly one definition.
        updated = await updateLane(laneId, { name, displayMode });
      } catch (saveErr) {
        if (isUniqueViolation(saveErr, LANE_NAME_UNIQUE)) {
          return sendErrorResponse(res, 409, 'Conflict', 'You already have a lane with that name');
        }
        throw saveErr;
      }
      if (!updated) {
        // Deleted between the authorization read and the write.
        return sendErrorResponse(res, 404, 'Not Found', 'Lane not found');
      }

      return sendSuccessResponse(res, 200, serialize(updated), 'Lane updated');
    } catch (err) {
      logger.error('[Lanes] Error updating lane:', {
        userId: req.user?.id,
        id: req.params.id,
        error: err,
      });
      return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to update lane');
    }
  },
);

/**
 * DELETE /lanes/:id
 *
 * ONE statement, because the three writes the Mongo handler had to sequence by
 * hand are now the database's own: `posts.lane_id` is `ON DELETE SET NULL` and
 * `lane_mutes.lane_id` is `ON DELETE CASCADE`, so deleting the row releases the
 * posts and drops the readers' mutes atomically. There is no order left to get
 * wrong, and no interruption that can leave a post pointing at a lane that no
 * longer exists.
 *
 * The FK also covers a case the Mongo version did not: its `updateMany` was
 * scoped to the lane's publisher, so a post carrying the lane but written under
 * a different publisher kept a dangling `laneId`. `SET NULL` is unscoped, which
 * is what the invariant actually says.
 */
router.delete('/:id', ...writeLimiters, validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const laneId = String(req.params.id);

    const db = getDb();
    const [lane] = await db
      .select({ ownerId: lanes.ownerId })
      .from(lanes)
      .where(eq(lanes.id, laneId))
      .limit(1);
    if (!lane || !callerManagesLane(lane, userId)) {
      return sendErrorResponse(res, 404, 'Not Found', 'Lane not found');
    }

    await db.delete(lanes).where(eq(lanes.id, laneId));

    return sendSuccessResponse(res, 200, { success: true }, 'Lane deleted');
  } catch (err) {
    logger.error('[Lanes] Error deleting lane:', {
      userId: req.user?.id,
      id: req.params.id,
      error: err,
    });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to delete lane');
  }
});

/**
 * POST /lanes/:id/mute
 * Silence one lane of one publisher. Idempotent — the unique
 * `{viewerOxyUserId, laneId}` index is what makes a repeat a no-op.
 *
 * **Muting your OWN lane is refused (400).** It would delete your own posts from
 * your own Following feed, which nobody means to ask for.
 */
router.post('/:id/mute', ...writeLimiters, validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const laneId = String(req.params.id);

    const db = getDb();
    const [lane] = await db
      .select({ ownerId: lanes.ownerId })
      .from(lanes)
      .where(eq(lanes.id, laneId))
      .limit(1);
    if (!lane) {
      return sendErrorResponse(res, 404, 'Not Found', 'Lane not found');
    }
    if (lane.ownerId === userId) {
      return sendErrorResponse(res, 400, 'Bad Request', 'You cannot mute your own lane');
    }
    // A CHANNEL's lane needs no special case: the channel is an Oxy account, so
    // `laneOwnerOxyUserId` is a real user id that `GET /lanes/muted` resolves
    // through `resolveUserSummaries` like any other, and a channel's posts DO
    // reach a follower's timeline — so there is something for the mute to
    // suppress.

    const [existing] = await db
      .select({ id: laneMutes.id })
      .from(laneMutes)
      .where(and(eq(laneMutes.viewerOxyUserId, userId), eq(laneMutes.laneId, laneId)))
      .limit(1);
    if (existing) {
      return sendSuccessResponse(res, 200, { success: true }, 'Lane already muted');
    }

    const [muted] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(laneMutes)
      .where(eq(laneMutes.viewerOxyUserId, userId));
    if (muted.total >= MAX_MUTED_LANES) {
      return sendErrorResponse(
        res,
        400,
        'Bad Request',
        `You can mute at most ${MAX_MUTED_LANES} lanes`,
      );
    }

    // `doNothing` on the row's own identity: a concurrent request that won the
    // race produced exactly the state the caller asked for, so a duplicate is a
    // no-op rather than an error. The pre-check above is not a lock and never
    // was — this is what makes the mute idempotent.
    await db
      .insert(laneMutes)
      .values({ viewerOxyUserId: userId, laneId, laneOwnerOxyUserId: lane.ownerId })
      .onConflictDoNothing({ target: [laneMutes.viewerOxyUserId, laneMutes.laneId] });

    return sendSuccessResponse(res, 201, { success: true }, 'Lane muted');
  } catch (err) {
    logger.error('[Lanes] Error muting lane:', {
      userId: req.user?.id,
      id: req.params.id,
      error: err,
    });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to mute lane');
  }
});

/**
 * DELETE /lanes/:id/mute
 * Unmute. Idempotent: a lane that was not muted answers the same success, because
 * "not muted" is exactly the state the caller asked for.
 */
router.delete('/:id/mute', ...writeLimiters, validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    await getDb()
      .delete(laneMutes)
      .where(
        and(
          eq(laneMutes.viewerOxyUserId, userId),
          eq(laneMutes.laneId, String(req.params.id)),
        ),
      );
    return sendSuccessResponse(res, 200, { success: true }, 'Lane unmuted');
  } catch (err) {
    logger.error('[Lanes] Error unmuting lane:', {
      userId: req.user?.id,
      id: req.params.id,
      error: err,
    });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to unmute lane');
  }
});

export default router;
