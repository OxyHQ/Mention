import { Router, Response } from 'express';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getDb } from '../db/postgres';
import { isUniqueViolation } from '@oxyhq/db';
import { ENTITY_FOLLOW_TYPES, entityFollows } from '../db/schema/engagement';
import { logger } from '../utils/logger';
import { listSubscriptionService, LIST_ENTITY_TYPE } from '../services/ListSubscriptionService';
import { canViewList, loadListVisibility } from '../services/listAccess';
import { queryInt, queryString } from '../utils/queryParams';
import { normalizeHashtag } from '../utils/textProcessing';

const router = Router();

const DEFAULT_FOLLOW_PAGE_SIZE = 20;
const MAX_FOLLOW_PAGE_SIZE = 50;

/** `entity_follows.entity_type` — the values the CHECK constraint admits. */
type EntityFollowType = (typeof ENTITY_FOLLOW_TYPES)[number];

/**
 * Upper bound on a followed entity's id.
 *
 * A hashtag has no row to check existence against — following `#wwdc` before
 * anyone has posted it is the normal case, and the hashtag screen offers the
 * button on any tag — so the bound on what a client may write is length, not
 * existence. Comfortably above a real tag (Mastodon caps one at 64 characters)
 * and above either live id shape, while keeping a row's size bounded.
 */
const MAX_ENTITY_ID_LENGTH = 100;

/** Separator in the keyset cursor. Not a legal character in either half. */
const CURSOR_SEPARATOR = '|';

function isValidEntityType(type: string): type is EntityFollowType {
  return (ENTITY_FOLLOW_TYPES as readonly string[]).includes(type);
}

const clampFollowPageSize = (limit: number | undefined): number =>
  Math.min(Math.max(limit || DEFAULT_FOLLOW_PAGE_SIZE, 1), MAX_FOLLOW_PAGE_SIZE);

/** One `entity_follows` row exactly as it goes on the wire. */
interface SerializedEntityFollow {
  _id: string;
  id: string;
  userId: string;
  entityType: EntityFollowType;
  entityId: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * `_id` alongside `id`, because a Mongoose document serialized as `_id` and a
 * port changes no response body. `__v` is dropped — it is Mongo bookkeeping the
 * schema deliberately does not carry (`schema/CONVENTIONS.md`).
 */
function serializeFollow(row: typeof entityFollows.$inferSelect): SerializedEntityFollow {
  return {
    _id: row.id,
    id: row.id,
    userId: row.userId,
    entityType: row.entityType,
    entityId: row.entityId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

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
 * Both values must be real strings. Under Mongo the reason was injection — an
 * `{"$ne": null}` object reached the query as an OPERATOR. Postgres binds them
 * as parameters, so that particular hazard is gone, but `entity_id` and
 * `entity_type` are both `text NOT NULL` and a non-string is a client error
 * worth a 400 rather than a driver failure worth a 500.
 *
 * A hashtag is stored in canonical form. `normalizeHashtag` is the SAME function
 * every post-write path uses to derive `Post.hashtags`, so a followed tag and an
 * indexed tag are by construction the same string, and `#Design`/`#design`/`#de
 * sign` all resolve to one row instead of one row apiece. Without this the
 * unique constraint on `{userId, entityType, entityId}` never fires for case
 * variants: the viewer accumulates a row per casing, each one counted again by
 * the affinity signals, and an unfollow removes only the casing it arrived by.
 *
 * A list id is passed through untouched — normalization applies to tags, which
 * are free text, not to ids.
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
    // `subscriber_count`. `GET /lists/:id` already refuses a non-owner on a
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

    const [follow] = await getDb()
      .insert(entityFollows)
      .values({ userId, entityType, entityId })
      .returning();

    // Following a list is a subscription: bump the list's subscriber count.
    // This does NOT follow the list's members and does NOT affect follower counts.
    if (entityType === LIST_ENTITY_TYPE) {
      await listSubscriptionService.incrementSubscriberCount(entityId);
    }

    logger.debug('Entity follow created', { type: entityType });

    res.status(201).json({ follow: serializeFollow(follow) });
  } catch (error: unknown) {
    // NAMED: this route answers 409 for "already following" and nothing else. A
    // bare 23505 check would report any future unique index on this table as a
    // duplicate follow.
    if (isUniqueViolation(error, 'entity_follows_user_id_entity_type_entity_id_key')) {
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
 * deletes only the caller's own row (the predicate is scoped to `userId`) and
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

    const removed = await getDb()
      .delete(entityFollows)
      .where(
        and(
          eq(entityFollows.userId, userId),
          eq(entityFollows.entityType, entityType),
          eq(entityFollows.entityId, entityId),
        ),
      )
      .returning({ id: entityFollows.id });

    if (removed.length === 0) {
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

    const [follow] = await getDb()
      .select({ id: entityFollows.id })
      .from(entityFollows)
      .where(
        and(
          eq(entityFollows.userId, userId),
          eq(entityFollows.entityType, entityType),
          eq(entityFollows.entityId, entityId),
        ),
      )
      .limit(1);

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
 * Decode a keyset cursor emitted by the listing below.
 *
 * Returns `null` for a cursor that is not one this route produced, which the
 * caller answers with a 400 rather than silently serving page one — a cursor
 * quietly ignored makes an infinite-scroll client loop over the first page
 * forever with no error anywhere.
 */
function parseFollowCursor(cursor: string): { createdAt: Date; id: string } | null {
  const separator = cursor.indexOf(CURSOR_SEPARATOR);
  if (separator <= 0 || separator === cursor.length - 1) return null;
  const createdAt = new Date(cursor.slice(0, separator));
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id: cursor.slice(separator + 1) };
}

/**
 * List current user's entity follows
 * GET /entity-follows?type=...&limit=...&cursor=...
 *
 * NEWEST FIRST, which is what the client documents it consumes
 * (`services/entityFollowService.ts`). Mongo got that ordering for free from a
 * descending `_id` sort, because an ObjectId embeds its creation time. A `text`
 * primary key does not: a post-cutover uuid v7 begins `0198…` and an ObjectId
 * minted in 2024 begins `65b0…`, so ordering on the id alone would file every
 * NEW follow BELOW every old one — silently, and only after the cutover. The
 * sort therefore moves onto `created_at`, with the id as the unique tiebreak
 * that keeps the order TOTAL (offset or keyset, a non-total order duplicates and
 * skips rows at the page boundary).
 *
 * The cursor stays a single opaque string, so the request/response shape is
 * unchanged; only its contents are now the pair the sort needs.
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const rawType = queryString(req.query.type);
    const limit = clampFollowPageSize(queryInt(req.query.limit));
    const cursor = queryString(req.query.cursor);

    if (rawType !== undefined && !isValidEntityType(rawType)) {
      return res.status(400).json({ message: `type must be one of: ${ENTITY_FOLLOW_TYPES.join(', ')}` });
    }

    const conditions: SQL[] = [eq(entityFollows.userId, userId)];
    if (rawType !== undefined) {
      conditions.push(eq(entityFollows.entityType, rawType));
    }
    if (cursor) {
      const decoded = parseFollowCursor(cursor);
      if (!decoded) {
        return res.status(400).json({ message: 'cursor is malformed' });
      }
      // Row comparison, so the two columns are compared as ONE value in the same
      // order the sort uses. Writing it as `created_at < x OR (created_at = x AND
      // id < y)` is the same predicate and is the one that gets the parenthesis
      // wrong.
      //
      // The timestamp is bound as an ISO STRING with an explicit cast, not as a
      // `Date`. A drizzle column knows how to encode a `Date`; a bare parameter
      // inside a hand-written `sql` template does not, and postgres.js rejects
      // it with `TypeError: The "string" argument must be of type string … .
      // Received an instance of Date`. It surfaces as a 500 on the SECOND page
      // only, because the first page carries no cursor.
      conditions.push(
        sql`(${entityFollows.createdAt}, ${entityFollows.id}) < (${decoded.createdAt.toISOString()}::timestamptz, ${decoded.id}::text)`,
      );
    }

    const follows = await getDb()
      .select()
      .from(entityFollows)
      .where(and(...conditions))
      .orderBy(desc(entityFollows.createdAt), desc(entityFollows.id))
      .limit(limit + 1);

    const hasMore = follows.length > limit;
    const results = (hasMore ? follows.slice(0, limit) : follows).map(serializeFollow);
    const last = results[results.length - 1];
    const nextCursor =
      hasMore && last ? `${last.createdAt.toISOString()}${CURSOR_SEPARATOR}${last.id}` : undefined;

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
 * One existed and no client ever called it. It returned raw entity-follow rows
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
