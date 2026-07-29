import { Router, Response } from 'express';
import { FilterQuery } from 'mongoose';
import { EntityFollow, ENTITY_FOLLOW_TYPES, type EntityFollowType, type IEntityFollow } from '../models/EntityFollow';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { logger } from '../utils/logger';
import { listSubscriptionService, LIST_ENTITY_TYPE } from '../services/ListSubscriptionService';
import { canViewList, loadListVisibility } from '../services/listAccess';
import { queryInt, queryString } from '../utils/queryParams';
import { normalizeHashtag } from '../utils/textProcessing';

const router = Router();

const DEFAULT_FOLLOW_PAGE_SIZE = 20;
const MAX_FOLLOW_PAGE_SIZE = 50;

/**
 * Upper bound on a followed entity's id.
 *
 * A hashtag has no row to check existence against — following `#wwdc` before
 * anyone has posted it is the normal case, and the hashtag screen offers the
 * button on any tag — so the bound on what a client may write is length, not
 * existence. Comfortably above a real tag (Mastodon caps one at 64 characters)
 * and above a 24-character ObjectId, while keeping a row's size bounded.
 */
const MAX_ENTITY_ID_LENGTH = 100;

function isValidEntityType(type: string): type is EntityFollowType {
  return (ENTITY_FOLLOW_TYPES as readonly string[]).includes(type);
}

const clampFollowPageSize = (limit: number | undefined): number =>
  Math.min(Math.max(limit || DEFAULT_FOLLOW_PAGE_SIZE, 1), MAX_FOLLOW_PAGE_SIZE);

/**
 * A resolved `{entityType, entityId}` pair. `entityId` is CANONICAL: for a
 * hashtag it has been through {@link normalizeHashtag}, so it is the single
 * form that is ever stored or queried.
 */
interface EntityRef {
  entityType: EntityFollowType;
  entityId: string;
}

type EntityRefResult = { ok: true; ref: EntityRef } | { ok: false; message: string };

/**
 * Validate and canonicalize the pair every entry point carries.
 *
 * Both values end up in a Mongo query, so both must be real strings — an
 * `{"$ne": null}` object would otherwise reach the query as an operator.
 *
 * A hashtag is stored in canonical form. `normalizeHashtag` is the SAME function
 * every post-write path uses to derive `Post.hashtags`, so a followed tag and an
 * indexed tag are by construction the same string, and `#Design`/`#design`/`#de
 * sign` all resolve to one row instead of one row apiece. Without this the
 * unique index on `{userId, entityType, entityId}` never fires for case
 * variants: the viewer accumulates a row per casing, each one counted again by
 * the affinity signals, and an unfollow removes only the casing it arrived by.
 *
 * A list id is an ObjectId and is passed through untouched — normalization
 * applies to tags, which are free text, not to ids.
 */
function resolveEntityRef(entityType: unknown, entityId: unknown): EntityRefResult {
  if (typeof entityType !== 'string' || typeof entityId !== 'string' || !entityType || !entityId) {
    return { ok: false, message: 'entityType and entityId are required' };
  }

  if (!isValidEntityType(entityType)) {
    return { ok: false, message: `entityType must be one of: ${ENTITY_FOLLOW_TYPES.join(', ')}` };
  }

  // Bound the RAW input: normalization only ever shortens, so checking here
  // rejects an oversized payload before doing any work on it.
  if (entityId.length > MAX_ENTITY_ID_LENGTH) {
    return { ok: false, message: `entityId must be at most ${MAX_ENTITY_ID_LENGTH} characters` };
  }

  if (entityType === 'hashtag') {
    const canonical = normalizeHashtag(entityId);
    if (!canonical) {
      // Everything was stripped — punctuation or emoji only. There is no tag
      // here to follow, and an empty entityId would violate the schema anyway.
      return { ok: false, message: 'entityId must contain at least one letter, number, or underscore' };
    }
    return { ok: true, ref: { entityType, entityId: canonical } };
  }

  return { ok: true, ref: { entityType, entityId } };
}

/**
 * Follow an entity
 * POST /entity-follows
 */
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const body: Record<string, unknown> = req.body ?? {};
    const parsed = resolveEntityRef(body.entityType, body.entityId);
    if (!parsed.ok) {
      return res.status(400).json({ message: parsed.message });
    }
    const { entityType, entityId } = parsed.ref;

    // Subscribing to a list is an act ON someone else's list: it merges that
    // list's members into the subscriber's feed (so its membership becomes
    // inferable from who shows up there) and it mutates the list's
    // `subscriberCount`. `GET /lists/:id` already refuses a non-owner on a
    // private list, so this write answers to the very same rule — one
    // definition of it, in `listAccess`.
    if (entityType === LIST_ENTITY_TYPE) {
      const list = await loadListVisibility(entityId);
      if (!list) {
        return res.status(404).json({ message: 'List not found' });
      }
      if (!canViewList(list, userId)) {
        return res.status(403).json({ message: 'Not allowed' });
      }
    }

    const follow = new EntityFollow({ userId, entityType, entityId });
    await follow.save();

    // Following a list is a subscription: bump the list's subscriber count.
    // This does NOT follow the list's members and does NOT affect follower counts.
    if (entityType === LIST_ENTITY_TYPE) {
      await listSubscriptionService.incrementSubscriberCount(entityId);
    }

    logger.debug('Entity follow created', { type: entityType });

    res.status(201).json({ follow });
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
      return res.status(409).json({ message: 'Already following this entity' });
    }
    logger.error('Error creating entity follow:', { userId: req.user?.id, error });
    res.status(500).json({
      message: 'Error creating entity follow',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Unfollow an entity
 * DELETE /entity-follows
 *
 * Deliberately NOT gated on list visibility, unlike the follow above. This
 * deletes only the caller's own row (the query is scoped to `userId`) and
 * decrements only the count that row inflated, so it grants nothing. Gating it
 * would do active harm: a viewer who subscribed while a list was public could
 * never unsubscribe once the owner flipped it private, and the stranded row
 * would keep feeding that list's members into their feed — turning the leak
 * this route now closes into a permanent one. Teardown has to converge.
 */
router.delete('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const body: Record<string, unknown> = req.body ?? {};
    const parsed = resolveEntityRef(body.entityType, body.entityId);
    if (!parsed.ok) {
      return res.status(400).json({ message: parsed.message });
    }
    const { entityType, entityId } = parsed.ref;

    const result = await EntityFollow.findOneAndDelete({ userId, entityType, entityId });

    if (!result) {
      return res.status(404).json({ message: 'Entity follow not found' });
    }

    // Unsubscribing from a list decrements its subscriber count (floored at 0).
    if (entityType === LIST_ENTITY_TYPE) {
      await listSubscriptionService.decrementSubscriberCount(entityId);
    }

    logger.debug('Entity follow removed', { type: entityType });

    res.json({ message: 'Entity unfollowed successfully' });
  } catch (error) {
    logger.error('Error deleting entity follow:', { userId: req.user?.id, error });
    res.status(500).json({
      message: 'Error deleting entity follow',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Check follow status
 * GET /entity-follows/status?entityType=...&entityId=...
 */
router.get('/status', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // `queryString` first, so an `?entityId[$ne]=x` object never reaches the
    // resolver — then the SAME resolution the writes use, or a client asking
    // about `Design` would miss the `design` row its own follow just created.
    const parsed = resolveEntityRef(queryString(req.query.entityType), queryString(req.query.entityId));
    if (!parsed.ok) {
      return res.status(400).json({ message: parsed.message });
    }
    const { entityType, entityId } = parsed.ref;

    const follow = await EntityFollow.findOne({ userId, entityType, entityId });

    res.json({ isFollowing: !!follow });
  } catch (error) {
    logger.error('Error checking entity follow status:', { userId: req.user?.id, error });
    res.status(500).json({
      message: 'Error checking entity follow status',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * List current user's entity follows
 * GET /entity-follows?type=...&limit=...&cursor=...
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const type = queryString(req.query.type);
    const limit = clampFollowPageSize(queryInt(req.query.limit));
    const cursor = queryString(req.query.cursor);

    if (type && !isValidEntityType(type)) {
      return res.status(400).json({ message: `type must be one of: ${ENTITY_FOLLOW_TYPES.join(', ')}` });
    }

    const query: FilterQuery<IEntityFollow> = { userId };
    if (type) {
      query.entityType = type;
    }
    if (cursor) {
      query._id = { $lt: cursor };
    }

    const follows = await EntityFollow.find(query)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = follows.length > limit;
    const results = hasMore ? follows.slice(0, limit) : follows;
    const nextCursor = hasMore && results.length > 0 ? String(results[results.length - 1]._id) : undefined;

    res.json({ follows: results, hasMore, nextCursor });
  } catch (error) {
    logger.error('Error listing entity follows:', { userId: req.user?.id, error });
    res.status(500).json({
      message: 'Error listing entity follows',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/*
 * There is deliberately no "followers of an entity" endpoint.
 *
 * One existed and no client ever called it. It returned raw `EntityFollow` rows
 * for any `{entityType, entityId}` to any authenticated user, paginated to
 * exhaustion — which enumerated a private list's subscribers, and enumerated by
 * name everyone who follows a given hashtag. Hashtag follows surface in no UI,
 * so that second one inferred sensitive interests (health, sexuality, politics)
 * about named accounts from a graph nobody had reason to believe was public.
 *
 * If a followers view is ever wanted, it needs a visibility rule of its own —
 * per entity kind — designed alongside the UI that consumes it. Do not restore
 * this as an ungated read.
 */

export default router;
