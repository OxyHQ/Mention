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
import { Lane, normalizeLaneName } from '../models/Lane';
import { LaneMute } from '../models/LaneMute';
import { Post } from '../models/Post';
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

/** Shape of a `Lane` document as the routes below read it back. */
interface LaneLean {
  _id: unknown;
  ownerId: string;
  name: string;
  displayMode: LaneDisplayMode;
  createdAt: Date;
  updatedAt: Date;
}

interface SerializedLane {
  id: string;
  ownerId: string;
  name: string;
  displayMode: LaneDisplayMode;
  createdAt: Date;
  updatedAt: Date;
  postCount?: number;
}

function serialize(doc: LaneLean, postCount?: number): SerializedLane {
  return {
    id: String(doc._id),
    ownerId: doc.ownerId,
    name: doc.name,
    displayMode: doc.displayMode,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
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

  const rows = await Post.aggregate<{ _id: string; count: number }>([
    { $match: { laneId: { $in: laneIds } } },
    { $group: { _id: '$laneId', count: { $sum: 1 } } },
  ]);
  for (const row of rows) {
    if (row?._id) counts.set(String(row._id), row.count);
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

    const lanes = await Lane.find({ ownerId, displayMode: 'tab' })
      .sort({ createdAt: -1 })
      .lean<LaneLean[]>();

    return sendSuccessResponse(res, 200, lanes.map((lane) => serialize(lane)));
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
      const lanes = await Lane.find({ ownerId: userId })
        .sort({ createdAt: -1 })
        .lean<LaneLean[]>();

      const counts = await countPostsByLane(lanes.map((lane) => String(lane._id)));
      const items = lanes.map((lane) => serialize(lane, counts.get(String(lane._id)) ?? 0));
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
    const mutes = await LaneMute.find({ viewerOxyUserId: userId })
      .sort({ createdAt: -1 })
      .limit(MAX_MUTED_LANES)
      .lean<Array<{ laneId: string; laneOwnerOxyUserId: string; createdAt: Date }>>();

    if (mutes.length === 0) {
      return sendSuccessResponse(res, 200, []);
    }

    const [lanes, owners] = await Promise.all([
      Lane.find({ _id: { $in: mutes.map((mute) => mute.laneId) } })
        .select('name displayMode')
        .lean<Array<{ _id: unknown; name: string; displayMode: LaneDisplayMode }>>(),
      resolveUserSummaries(mutes.map((mute) => mute.laneOwnerOxyUserId)),
    ]);

    const laneById = new Map(lanes.map((lane) => [String(lane._id), lane]));
    const items: MutedLane[] = [];
    for (const mute of mutes) {
      const lane = laneById.get(mute.laneId);
      // A mute whose lane is gone. The delete cascade removes these rows before
      // the lane itself, so this is only reachable if that cascade was
      // interrupted — drop the row from the list rather than render a blank one.
      if (!lane) continue;
      const owner: PostUser | undefined = owners.get(mute.laneOwnerOxyUserId)?.user;
      if (!owner) continue;
      items.push({
        lane: { id: String(lane._id), name: lane.name, displayMode: lane.displayMode },
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
    const count = await Lane.countDocuments({ ownerId: userId });
    if (count >= MAX_LANES_PER_OWNER) {
      return sendErrorResponse(
        res,
        400,
        'Bad Request',
        `You can have at most ${MAX_LANES_PER_OWNER} lanes`,
      );
    }

    try {
      const created = await Lane.create({
        ownerId: userId,
        name,
        displayMode: displayMode ?? 'mixed',
      });
      return sendSuccessResponse(res, 201, serialize(created.toObject() as LaneLean, 0), 'Lane created');
    } catch (createErr) {
      if ((createErr as { code?: number }).code === 11000) {
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
 * Renaming is free — nothing routes by name (see `models/Lane` on why there is no
 * slug). Changing `displayMode` changes which posts a profile tab CONTAINS, so
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
      const lane = await Lane.findById(req.params.id);
      if (!lane || !callerManagesLane(lane, userId)) {
        return sendErrorResponse(res, 404, 'Not Found', 'Lane not found');
      }

      if (name !== undefined) {
        if (!normalizeLaneName(name)) {
          return sendErrorResponse(res, 400, 'Bad Request', 'name must not be empty after normalization');
        }
        // `nameLower` follows from the model's own hook, so the normalization
        // has exactly one definition.
        lane.name = name;
      }
      if (displayMode !== undefined) {
        lane.displayMode = displayMode;
      }

      try {
        await lane.save();
      } catch (saveErr) {
        if ((saveErr as { code?: number }).code === 11000) {
          return sendErrorResponse(res, 409, 'Conflict', 'You already have a lane with that name');
        }
        throw saveErr;
      }

      return sendSuccessResponse(res, 200, serialize(lane.toObject() as LaneLean), 'Lane updated');
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
 * THE ORDER OF THE THREE WRITES IS LOAD-BEARING:
 *
 *  1. unset `laneId` on the lane's posts,
 *  2. delete the readers' mutes of it,
 *  3. delete the lane.
 *
 * Backwards, posts would be left pointing at a lane that no longer exists.
 * Hydration would emit no chip (harmless), but the profile exclusion query
 * matches on lane ids it can still find — so posts the owner had tucked away
 * would REAPPEAR on their profile. An interruption partway through this order
 * leaves an empty lane, which is harmless and re-deletable.
 */
router.delete('/:id', ...writeLimiters, validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const laneId = String(req.params.id);

    const lane = await Lane.findById(laneId)
      .select('_id ownerId')
      .lean<{ _id: unknown; ownerId: string } | null>();
    if (!lane || !callerManagesLane(lane, userId)) {
      return sendErrorResponse(res, 404, 'Not Found', 'Lane not found');
    }

    // Scoped by the lane's PUBLISHER, not by the caller. They are the same person
    // on this route, but the publisher is what the invariant is actually about:
    // the lane's posts are the publisher's, and a post left pointing at a deleted
    // lane REAPPEARS on the profile its owner had tucked it away from.
    await Post.updateMany(
      { oxyUserId: lane.ownerId, laneId },
      { $unset: { laneId: '' } },
    );
    await LaneMute.deleteMany({ laneId });
    await Lane.deleteOne({ _id: laneId });

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

    const lane = await Lane.findById(laneId)
      .select('ownerId')
      .lean<{ ownerId: string } | null>();
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

    const existing = await LaneMute.findOne({ viewerOxyUserId: userId, laneId })
      .select('_id')
      .lean<{ _id: unknown } | null>();
    if (existing) {
      return sendSuccessResponse(res, 200, { success: true }, 'Lane already muted');
    }

    const count = await LaneMute.countDocuments({ viewerOxyUserId: userId });
    if (count >= MAX_MUTED_LANES) {
      return sendErrorResponse(
        res,
        400,
        'Bad Request',
        `You can mute at most ${MAX_MUTED_LANES} lanes`,
      );
    }

    try {
      await LaneMute.create({
        viewerOxyUserId: userId,
        laneId,
        laneOwnerOxyUserId: lane.ownerId,
      });
    } catch (createErr) {
      // The unique index — a concurrent request won the race, which is the same
      // outcome the caller asked for.
      if ((createErr as { code?: number }).code !== 11000) throw createErr;
    }

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
    await LaneMute.deleteOne({ viewerOxyUserId: userId, laneId: String(req.params.id) });
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
