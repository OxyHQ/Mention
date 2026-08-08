import express, { Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { config } from '../config';
import { getDb, type DatabaseOrTransaction, type Transaction } from '../db/postgres';
import { accountListMembers, accountLists } from '../db/schema/lists';
import { posts } from '../db/schema/posts';
import { findPostRecords } from '../db/posts/postRepository';
import { ChronoCursor, chronoCursorSql, chronoOrderBy } from '../mtn/feed/CursorBuilder';
import { feedController } from '../controllers/feed.controller';
import { endorsementSignalService } from '../services/EndorsementSignalService';
import { canViewList } from '../services/listAccess';
import { logger } from '../utils/logger';
import { queryInt, queryString } from '../utils/queryParams';
import { feedIPRateLimiter, feedRateLimiter } from '../middleware/security';

const router = express.Router();

/**
 * A list's timeline is a FEED — the same shape and the same cost as a page of
 * `/feed/mtn` — so it earns the same per-endpoint limiters the feed routes use,
 * on top of the app-wide limiter in `app.ts`. The global one bounds abuse of
 * the API as a whole; these bound abuse of the expensive DB reads specifically.
 *
 * Production-gated, mirroring `feed.routes.ts`: the limiters are Redis-backed
 * and a dev machine has no Redis.
 */
const timelineRateLimiters = config.runtime.isProduction
  ? [feedIPRateLimiter, feedRateLimiter]
  : [];

/** List timeline page size (`GET /lists/:id/timeline`). */
const DEFAULT_TIMELINE_PAGE_SIZE = 20;
const MAX_TIMELINE_PAGE_SIZE = 100;

/** Hard cap on the `GET /lists` page size — `?limit` can only narrow it. */
const MAX_LIST_PAGE_SIZE = 100;

/**
 * Escape the characters `LIKE` treats as wildcards.
 *
 * The Mongo version escaped REGEX metacharacters, which is the wrong alphabet
 * here: `%` and `_` are what `ILIKE` reads as patterns, and leaving them live
 * turns the search box into a way to match every list the viewer can see.
 */
function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * Fire-and-forget endorsement re-sync for a list whose membership changed.
 * Never blocks or fails the request — Oxy reputation signals are eventually
 * consistent (the outbox retries on failure).
 */
function syncListEndorsements(listId: string): void {
  void endorsementSignalService
    .syncScope('accountList', listId)
    .catch((error) => logger.warn('[Lists] endorsement sync failed', error));
}

function syncListMembershipChange(
  listId: string,
  ownerId: string,
  previousMemberIds: string[],
  nextMemberIds: string[],
): void {
  void endorsementSignalService
    .syncScopeMembershipChange('accountList', listId, ownerId, previousMemberIds, nextMemberIds)
    .catch((error) => logger.warn('[Lists] endorsement membership sync failed', error));
}

/** An account list exactly as it goes on the wire. */
interface SerializedList {
  _id: string;
  id: string;
  ownerOxyUserId: string;
  title: string;
  description?: string;
  isPublic: boolean;
  /** The membership junction, flattened back into the array the client reads. */
  memberOxyUserIds: string[];
  subscriberCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Re-assemble the response body a Mongoose document produced.
 *
 * `_id` is still emitted alongside `id` because the client reads
 * `created?._id || created?.id` (`services/listsService.ts`), and a port changes
 * no response body. An absent `description` is OMITTED rather than sent as
 * `null`: Mongoose left it `undefined`, which `JSON.stringify` drops, and
 * drizzle's `null` would serialize as `"description": null` — a different body
 * for the same absent value, and exactly what an `if (list.description)` check
 * on the client would start rendering as an empty field.
 */
function serializeList(
  row: typeof accountLists.$inferSelect,
  memberOxyUserIds: string[],
): SerializedList {
  return {
    _id: row.id,
    id: row.id,
    ownerOxyUserId: row.ownerOxyUserId,
    title: row.title,
    ...(row.description === null ? {} : { description: row.description }),
    isPublic: row.isPublic,
    memberOxyUserIds,
    subscriberCount: row.subscriberCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The member ids a client sent, in the order they sent them: non-empty strings
 * only, deduplicated.
 *
 * Mongo stored the raw array, so a repeated id simply sat there twice. The
 * junction's `(list_id, oxy_user_id)` unique constraint refuses that outright,
 * so the duplicate is collapsed HERE — keeping the first occurrence, which is
 * what preserves the arrangement the owner chose. A non-string could never name
 * an Oxy account, and Mongoose's cast would have turned an object into
 * `"[object Object]"` rather than rejecting it, so those are dropped too.
 */
function normalizeMemberIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const value of input) {
    if (typeof value === 'string' && value.length > 0) seen.add(value);
  }
  return Array.from(seen);
}

/** Members of the given lists, keyed by list id, each in the owner's order. */
async function loadMembersByList(
  db: DatabaseOrTransaction,
  listIds: string[],
): Promise<Map<string, string[]>> {
  const grouped = new Map<string, string[]>();
  if (listIds.length === 0) return grouped;

  // `inArray`, never a hand-built `= any(${ids})`: a raw JS array interpolated
  // into `sql` binds as a ROW constructor, and Postgres rejects it at runtime.
  const rows = await db
    .select({ listId: accountListMembers.listId, oxyUserId: accountListMembers.oxyUserId })
    .from(accountListMembers)
    .where(inArray(accountListMembers.listId, listIds))
    .orderBy(asc(accountListMembers.listId), asc(accountListMembers.position));

  for (const row of rows) {
    const bucket = grouped.get(row.listId);
    if (bucket) bucket.push(row.oxyUserId);
    else grouped.set(row.listId, [row.oxyUserId]);
  }
  return grouped;
}

/**
 * Rewrite a list's membership so it is exactly `memberIds`, in that order.
 *
 * DELETE-then-INSERT, two statements inside the caller's transaction. That is
 * not laziness about the incremental case: `(list_id, position)` is UNIQUE, so
 * any attempt to REORDER in place (`update … set position = …`) collides with a
 * row that still holds the target position — Postgres checks a unique constraint
 * per statement, not at commit, so even a single multi-row `UPDATE` fails. The
 * delete happens first, in its own statement, so the insert sees no old rows at
 * all and `position` runs 0…n-1 with nothing to collide with.
 *
 * The append-only cases (`POST /:id/members`) route through here too, and pay
 * only a rewrite of rows nothing references by id.
 */
async function replaceMembers(tx: Transaction, listId: string, memberIds: string[]): Promise<void> {
  await tx.delete(accountListMembers).where(eq(accountListMembers.listId, listId));
  if (memberIds.length === 0) return;
  await tx.insert(accountListMembers).values(
    memberIds.map((oxyUserId, position) => ({ listId, oxyUserId, position })),
  );
}

// Create list (accounts)
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { title, description, isPublic = true, memberOxyUserIds } = req.body || {};
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const members = normalizeMemberIds(memberOxyUserIds);
    const list = await getDb().transaction(async (tx) => {
      const [row] = await tx
        .insert(accountLists)
        .values({
          ownerOxyUserId: userId,
          title: String(title),
          // NULL, never `''` — an empty string is a VALUE, and the client's
          // `if (list.description)` would then render an empty field instead of
          // none. Mongoose stored `undefined` for exactly this.
          description: description ? String(description) : null,
          isPublic: !!isPublic,
        })
        .returning();
      await replaceMembers(tx, row.id, members);
      return row;
    });

    syncListEndorsements(list.id);
    res.status(201).json(serializeList(list, members));
  } catch (error) {
    logger.error('[Lists] Failed to create list', { userId: req.user?.id, error });
    res.status(500).json({ error: 'Failed to create list' });
  }
});

// List lists (mine/public), optionally filtered by a search term.
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const mine = queryString(req.query.mine);
    const publicOnly = queryString(req.query.publicOnly);
    // `userId` — ONE account's lists, which is what a profile's Lists tab asks.
    // Named `userId` because that is what `GET /feeds` and `GET /starter-packs`
    // already call the same parameter, and the three serve sibling tabs on one
    // screen; a fourth spelling here is how a client ends up sending the wrong
    // one, which is precisely what happened.
    //
    // Without it that tab fell through to the visibility gate below and answered a
    // different question entirely: the VIEWER's own lists plus every public list,
    // on somebody else's profile. It read as a rendering quirk and was a data
    // leak — you saw your own lists sitting under a stranger's name.
    const ownerId = queryString(req.query.userId)?.trim();

    // Visibility gate, applied UNCONDITIONALLY: the viewer sees their OWN lists
    // plus every public list. It used to be skipped whenever `mine` or
    // `publicOnly` was present but not the literal `'true'` — so `?mine=false`
    // (and `?mine[]=true`, which arrives as an array) produced an unfiltered
    // query that returned every private list in the database. `mine=true`,
    // `publicOnly=true` and `userId` still NARROW within the gate; nothing
    // widens it.
    //
    // Every clause is ANDed, which is what lets the owner filter stand on its
    // own here: Mongo needed the non-owner's `isPublic` written beside a
    // top-level `$or` that would otherwise have re-admitted everybody's public
    // lists, and there is no such disjunction to escape from.
    const conditions: Array<SQL | undefined> = [
      or(eq(accountLists.ownerOxyUserId, userId), eq(accountLists.isPublic, true)),
    ];
    if (mine === 'true') conditions.push(eq(accountLists.ownerOxyUserId, userId));
    if (publicOnly === 'true') conditions.push(eq(accountLists.isPublic, true));
    if (ownerId) {
      conditions.push(eq(accountLists.ownerOxyUserId, ownerId));
      // A non-owner gets that owner's PUBLIC lists only.
      if (ownerId !== userId) conditions.push(eq(accountLists.isPublic, true));
    }

    // Filter by `search` (title/description, case-insensitive). LIKE-ESCAPED so a
    // raw query can't be read as a wildcard and match everything.
    const search = queryString(req.query.search)?.trim();
    if (search) {
      const pattern = likeContains(search);
      conditions.push(
        or(ilike(accountLists.title, pattern), ilike(accountLists.description, pattern)) as SQL,
      );
    }
    const where = and(...conditions);

    // Opt-in pagination: `?limit` present ⇒ page (offset/limit, over-fetching one
    // row to detect `hasMore`); absent ⇒ the historical "return every accessible
    // list" the lists screen / add-to-list sheet depend on. `id` breaks
    // `updated_at` ties so the order is TOTAL and offsets never shuffle rows
    // between pages.
    const rawLimit = queryInt(req.query.limit);
    const offset = Math.max(0, queryInt(req.query.offset) ?? 0);
    const pageLimit =
      rawLimit === undefined ? undefined : Math.min(Math.max(1, rawLimit), MAX_LIST_PAGE_SIZE);

    const db = getDb();
    const baseQuery = db
      .select()
      .from(accountLists)
      .where(where)
      .orderBy(desc(accountLists.updatedAt), desc(accountLists.id));
    const fetched =
      pageLimit === undefined ? await baseQuery : await baseQuery.limit(pageLimit + 1).offset(offset);

    const hasMore = pageLimit !== undefined && fetched.length > pageLimit;
    const page = hasMore ? fetched.slice(0, pageLimit) : fetched;
    const membersByList = await loadMembersByList(db, page.map((row) => row.id));
    const serialized = page.map((row) => serializeList(row, membersByList.get(row.id) ?? []));

    let total = serialized.length;
    if (pageLimit !== undefined) {
      // `::int` so postgres.js hands back a NUMBER: a bare `count(*)` is a
      // bigint, which the driver returns as a STRING, and `total` would silently
      // change type on the wire.
      const [counted] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(accountLists)
        .where(where);
      total = counted.total;
    }

    res.json({
      items: serialized,
      total,
      pagination: { offset, limit: pageLimit ?? serialized.length, hasMore },
    });
  } catch (error) {
    logger.error('[Lists] Failed to list lists', { userId: req.user?.id, error });
    res.status(500).json({ error: 'Failed to list lists' });
  }
});

// Get list
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const db = getDb();
    const [list] = await db
      .select()
      .from(accountLists)
      .where(eq(accountLists.id, String(req.params.id)))
      .limit(1);
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (!canViewList(list, userId)) return res.status(403).json({ error: 'Not allowed' });
    const members = await loadMembersByList(db, [list.id]);
    res.json(serializeList(list, members.get(list.id) ?? []));
  } catch (error) {
    logger.error('[Lists] Failed to get list', { userId: req.user?.id, listId: String(req.params.id), error });
    res.status(500).json({ error: 'Failed to get list' });
  }
});

/**
 * The outcome of a write that first has to find the list and check its owner.
 *
 * Returned rather than thrown so the transaction is not used for control flow:
 * a `throw` here would roll back a transaction that had done nothing wrong and
 * arrive at the catch block as an indistinguishable 500.
 */
type ListWriteOutcome =
  | { kind: 'notFound' }
  | { kind: 'forbidden' }
  | { kind: 'ok'; list: typeof accountLists.$inferSelect; previousMemberIds: string[]; memberIds: string[] };

// Update list
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { title, description, isPublic, memberOxyUserIds } = req.body || {};
    const replacesMembers = Array.isArray(memberOxyUserIds);

    const outcome = await getDb().transaction<ListWriteOutcome>(async (tx) => {
      const [existing] = await tx
        .select()
        .from(accountLists)
        .where(eq(accountLists.id, String(req.params.id)))
        .limit(1);
      if (!existing) return { kind: 'notFound' };
      if (existing.ownerOxyUserId !== userId) return { kind: 'forbidden' };

      const members = await loadMembersByList(tx, [existing.id]);
      const previousMemberIds = members.get(existing.id) ?? [];
      const memberIds = replacesMembers ? normalizeMemberIds(memberOxyUserIds) : previousMemberIds;

      // Built from LITERAL keys only. Drizzle keys `set()` by column PROPERTY
      // name and silently ignores an unknown one — writing nothing and throwing
      // nothing — so an update object assembled from request keys would be a
      // dropped write nobody notices.
      await tx
        .update(accountLists)
        .set({
          ...(title === undefined ? {} : { title: String(title) }),
          ...(description === undefined ? {} : { description: description ? String(description) : null }),
          ...(isPublic === undefined ? {} : { isPublic: !!isPublic }),
          // Always stamped, matching Mongoose's `save()`: the previous route
          // bumped `updatedAt` on every PUT whether or not a field changed, and
          // `updated_at` is the sort key `GET /lists` pages on.
          updatedAt: new Date(),
        })
        .where(eq(accountLists.id, existing.id));

      if (replacesMembers) {
        await replaceMembers(tx, existing.id, memberIds);
      }

      const [list] = await tx
        .select()
        .from(accountLists)
        .where(eq(accountLists.id, existing.id))
        .limit(1);
      return { kind: 'ok', list, previousMemberIds, memberIds };
    });

    if (outcome.kind === 'notFound') return res.status(404).json({ error: 'List not found' });
    if (outcome.kind === 'forbidden') return res.status(403).json({ error: 'Not allowed' });

    if (replacesMembers) {
      syncListMembershipChange(
        outcome.list.id,
        outcome.list.ownerOxyUserId,
        outcome.previousMemberIds,
        outcome.memberIds,
      );
    } else {
      syncListEndorsements(outcome.list.id);
    }
    res.json(serializeList(outcome.list, outcome.memberIds));
  } catch (error) {
    logger.error('[Lists] Failed to update list', { userId: req.user?.id, listId: String(req.params.id), error });
    res.status(500).json({ error: 'Failed to update list' });
  }
});

// Delete list
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const outcome = await getDb().transaction<ListWriteOutcome>(async (tx) => {
      const [existing] = await tx
        .select()
        .from(accountLists)
        .where(eq(accountLists.id, String(req.params.id)))
        .limit(1);
      if (!existing) return { kind: 'notFound' };
      if (existing.ownerOxyUserId !== userId) return { kind: 'forbidden' };

      // Capture members BEFORE the delete so their endorsements can be retracted;
      // `account_list_members` cascades with the list and is gone afterwards.
      const members = await loadMembersByList(tx, [existing.id]);
      await tx.delete(accountLists).where(eq(accountLists.id, existing.id));
      const memberIds = members.get(existing.id) ?? [];
      return { kind: 'ok', list: existing, previousMemberIds: memberIds, memberIds };
    });

    if (outcome.kind === 'notFound') return res.status(404).json({ error: 'List not found' });
    if (outcome.kind === 'forbidden') return res.status(403).json({ error: 'Not allowed' });

    void endorsementSignalService
      .syncScopeRemoval('accountList', outcome.list.id, outcome.list.ownerOxyUserId, outcome.memberIds)
      .catch((error) => logger.warn('[Lists] endorsement retraction failed', error));
    res.json({ success: true });
  } catch (error) {
    logger.error('[Lists] Failed to delete list', { userId: req.user?.id, listId: String(req.params.id), error });
    res.status(500).json({ error: 'Failed to delete list' });
  }
});

// Add members
router.post('/:id/members', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { userIds } = req.body || {};

    const outcome = await getDb().transaction<ListWriteOutcome>(async (tx) => {
      const [existing] = await tx
        .select()
        .from(accountLists)
        .where(eq(accountLists.id, String(req.params.id)))
        .limit(1);
      if (!existing) return { kind: 'notFound' };
      if (existing.ownerOxyUserId !== userId) return { kind: 'forbidden' };

      const members = await loadMembersByList(tx, [existing.id]);
      const previousMemberIds = members.get(existing.id) ?? [];
      // Existing members keep their positions and the new ones are APPENDED —
      // the same result `new Set([...existing, ...incoming])` produced.
      const memberIds = Array.from(
        new Set([...previousMemberIds, ...normalizeMemberIds(userIds)]),
      );
      await replaceMembers(tx, existing.id, memberIds);
      return { kind: 'ok', list: existing, previousMemberIds, memberIds };
    });

    if (outcome.kind === 'notFound') return res.status(404).json({ error: 'List not found' });
    if (outcome.kind === 'forbidden') return res.status(403).json({ error: 'Not allowed' });

    syncListEndorsements(outcome.list.id);
    res.json(serializeList(outcome.list, outcome.memberIds));
  } catch (error) {
    logger.error('[Lists] Failed to add members', { userId: req.user?.id, listId: String(req.params.id), error });
    res.status(500).json({ error: 'Failed to add members' });
  }
});

// Remove members
router.delete('/:id/members', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { userIds } = req.body || {};

    const outcome = await getDb().transaction<ListWriteOutcome>(async (tx) => {
      const [existing] = await tx
        .select()
        .from(accountLists)
        .where(eq(accountLists.id, String(req.params.id)))
        .limit(1);
      if (!existing) return { kind: 'notFound' };
      if (existing.ownerOxyUserId !== userId) return { kind: 'forbidden' };

      const members = await loadMembersByList(tx, [existing.id]);
      const previousMemberIds = members.get(existing.id) ?? [];
      const toRemove = new Set(normalizeMemberIds(userIds));
      const memberIds = previousMemberIds.filter((id) => !toRemove.has(id));
      await replaceMembers(tx, existing.id, memberIds);
      return { kind: 'ok', list: existing, previousMemberIds, memberIds };
    });

    if (outcome.kind === 'notFound') return res.status(404).json({ error: 'List not found' });
    if (outcome.kind === 'forbidden') return res.status(403).json({ error: 'Not allowed' });

    syncListMembershipChange(
      outcome.list.id,
      outcome.list.ownerOxyUserId,
      outcome.previousMemberIds,
      outcome.memberIds,
    );
    res.json(serializeList(outcome.list, outcome.memberIds));
  } catch (error) {
    logger.error('[Lists] Failed to remove members', { userId: req.user?.id, listId: String(req.params.id), error });
    res.status(500).json({ error: 'Failed to remove members' });
  }
});

/**
 * Timeline of a list (chronological posts from members).
 *
 * Both halves are Postgres: the list and its membership, and the posts fed to
 * `feedController.transformPostsWithProfiles` → `PostHydrationService`.
 */
router.get('/:id/timeline', ...timelineRateLimiters, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const cursor = queryString(req.query.cursor);
    // Bounded positive integer: the page's last row is read by index below, so a
    // NaN / zero / negative limit would index outside the page.
    const limit = Math.min(Math.max(queryInt(req.query.limit) || DEFAULT_TIMELINE_PAGE_SIZE, 1), MAX_TIMELINE_PAGE_SIZE);
    const listId = String(req.params.id);
    const db = getDb();
    const [list] = await db
      .select({ isPublic: accountLists.isPublic, ownerOxyUserId: accountLists.ownerOxyUserId })
      .from(accountLists)
      .where(eq(accountLists.id, listId))
      .limit(1);
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (!canViewList(list, userId)) return res.status(403).json({ error: 'Not allowed' });

    const members = await loadMembersByList(db, [listId]);
    const memberIds = members.get(listId) ?? [];
    // Chronological keyset, matching the cursor it hands back. The `_id`-bound
    // page it replaces agreed with its `createdAt` sort only by accident — an
    // ObjectId encoded its creation time — and stopped agreeing the moment ids
    // became uuid v7.
    const keyset = await chronoCursorSql(cursor);
    const scope = and(
      inArray(posts.oxyUserId, memberIds),
      eq(posts.visibility, 'public'),
    ) as SQL;
    const docs = memberIds.length === 0
      ? []
      : await findPostRecords(keyset ? and(scope, keyset) : scope, {
        orderBy: chronoOrderBy(),
        limit: limit + 1,
      });
    const hasMore = docs.length > limit;
    const toReturn = hasMore ? docs.slice(0, limit) : docs;
    const anchor = hasMore ? toReturn[limit - 1] : undefined;
    const nextCursor = anchor ? ChronoCursor.build(anchor.id, anchor.createdAt) : undefined;
    const transformed = await feedController.transformPostsWithProfiles(toReturn, userId);
    // Date lives on the hydrated post's `metadata` (HydratedPost has no top-level
    // `date`); the previous `p.date` read was always undefined under the loose cast.
    res.json({ items: transformed.map((p) => ({ id: p.id, type: 'post', data: p, createdAt: p.metadata?.createdAt, updatedAt: p.metadata?.updatedAt })), hasMore, nextCursor, totalCount: transformed.length });
  } catch (error) {
    logger.error('[Lists] Failed to load list timeline', { userId: req.user?.id, listId: String(req.params.id), error });
    res.status(500).json({ error: 'Failed to load list timeline' });
  }
});

export default router;
