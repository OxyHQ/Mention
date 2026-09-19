import express, { Response } from 'express';
import { z } from 'zod';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import { and, asc, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { config } from '../config';
import { getDb, type DatabaseOrTransaction, type Transaction } from '../db/postgres';
import {
  ACCOUNT_LIST_MAX_MEMBERS,
  ACCOUNT_LIST_MAX_MEMBER_ID_LENGTH,
  accountListMembers,
  accountLists,
} from '../db/schema/lists';
import { accountListSearchPredicate } from '../utils/searchPredicates';
import { posts } from '../db/schema/posts';
import { findPostRecords } from '../db/posts/postRepository';
import { ChronoCursor, chronoCursorSql, chronoOrderBy } from '../mtn/feed/CursorBuilder';
import { feedController } from '../controllers/feed.controller';
import { endorsementSignalService } from '../services/EndorsementSignalService';
import { canViewList } from '../services/listAccess';
import { logger } from '../utils/logger';
import { queryInt, queryString } from '../utils/queryParams';
import { resolvePageLimit, resolvePageOffset } from '../utils/pageLimits';
import { notCollapsedCrosspostSql } from '../utils/feedQueryBuilder';
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

/**
 * `GET /lists` page bounds. `?limit` narrows within them and can never escape
 * them: an ABSENT limit is `DEFAULT_LIST_PAGE_SIZE`, not "every accessible
 * list", which is what it used to mean.
 */
const DEFAULT_LIST_PAGE_SIZE = 20;
const MAX_LIST_PAGE_SIZE = 100;

/**
 * What a list's own two text fields may be.
 *
 * `title` was tested for TRUTHINESS and then written through `String(title)`, so
 * `{}` became the literal `"[object Object]"` and `[1,2]` became `"1,2"` — a 201
 * and a persisted row, with nothing to tell anyone it had happened. The PUT was
 * worse: it branched on `title === undefined`, so `title: null` wrote the
 * four-character string `"null"` over a real title, and `title: ''` wrote an
 * empty one the POST refuses.
 *
 * NO length cap is imposed. The columns are unbounded `text` and always have
 * been; capping them here would refuse rows that already exist, which is a
 * different decision from refusing a value that was never a title.
 *
 * `isPublic` is a real `z.boolean()`, not `z.unknown()` plus `!!isPublic` at the
 * write site: truthiness is total over any JSON value, which is exactly the
 * problem — `"false"` (a non-empty string), `[]` and `{}` are all truthy, so a
 * client that sent the STRING `"false"` meaning to keep a list private wrote
 * `true`. `z.coerce.boolean()` would not fix this either; it coerces by the same
 * truthiness rule. A real JSON `false` and `true` still parse as themselves, and
 * anything else is now a 400 rather than a silent reinterpretation.
 *
 * `memberOxyUserIds` stays `z.unknown()`: `normalizeMemberIds` is already total
 * over any JSON value and, unlike a boolean, there is no truthy/falsy value it
 * could silently misread the same way.
 */
const createListSchema = z.object({
  title: z.string('Title is required').min(1, 'Title is required'),
  description: z.string('description must be a string').nullish(),
  isPublic: z.boolean('isPublic must be a boolean').optional(),
  memberOxyUserIds: z.unknown().optional(),
});

/** The same fields, all optional: an absent one leaves the stored value alone. */
const updateListSchema = z.object({
  title: z.string('title must be a non-empty string').min(1, 'title must be a non-empty string').optional(),
  description: z.string('description must be a string').nullish(),
  isPublic: z.boolean('isPublic must be a boolean').optional(),
  memberOxyUserIds: z.unknown().optional(),
});


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
 * The member ids a client sent, in the order they sent them: non-empty
 * strings within a real id's length, deduplicated.
 *
 * Mongo stored the raw array, so a repeated id simply sat there twice. The
 * junction's `(list_id, oxy_user_id)` unique constraint refuses that outright,
 * so the duplicate is collapsed HERE — keeping the first occurrence, which is
 * what preserves the arrangement the owner chose. A non-string could never name
 * an Oxy account, and Mongoose's cast would have turned an object into
 * `"[object Object]"` rather than rejecting it, so those are dropped too.
 *
 * The length bound is the same kind of drop, not a new category of rejection:
 * nothing this table has ever held is anywhere near
 * {@link ACCOUNT_LIST_MAX_MEMBER_ID_LENGTH} long, so a string past it could not
 * have named a real Oxy account either — it is silently invalid the same way
 * an object or a number is, not a client-visible validation error.
 */
function normalizeMemberIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const value of input) {
    if (typeof value === 'string' && value.length > 0 && value.length <= ACCOUNT_LIST_MAX_MEMBER_ID_LENGTH) {
      seen.add(value);
    }
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

/**
 * The position an APPENDED member should take — one past the highest position
 * currently in the table, never a count of rows.
 *
 * A remove leaves gaps (`account_list_members_list_id_position_key` is on the
 * pair, not on a contiguous range), so `COUNT(*)` after a remove UNDER-states
 * the highest position still in use. Appending at `count` would then collide
 * with a row the earlier remove left behind — the exact "reassign positions
 * and hit the unique constraint" failure this function exists to avoid.
 */
async function nextMemberPosition(tx: Transaction, listId: string): Promise<number> {
  const [row] = await tx
    .select({ maxPosition: sql<number | null>`max(${accountListMembers.position})` })
    .from(accountListMembers)
    .where(eq(accountListMembers.listId, listId));
  return (row?.maxPosition ?? -1) + 1;
}

// Create list (accounts)
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const parsed = createListSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((issue) => issue.message).join('; ') });
    }
    const { title, description, isPublic = true, memberOxyUserIds } = parsed.data;

    const members = normalizeMemberIds(memberOxyUserIds);
    if (members.length > ACCOUNT_LIST_MAX_MEMBERS) {
      return res.status(400).json({ error: `Maximum ${ACCOUNT_LIST_MAX_MEMBERS} members allowed` });
    }
    const list = await getDb().transaction(async (tx) => {
      const [row] = await tx
        .insert(accountLists)
        .values({
          ownerOxyUserId: userId,
          title,
          // NULL, never `''` — an empty string is a VALUE, and the client's
          // `if (list.description)` would then render an empty field instead of
          // none. Mongoose stored `undefined` for exactly this.
          description: description ? description : null,
          isPublic,
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
      // Coarse index-servable prefilter AND the exact match, from the one
      // definition in `db/search/searchPredicates.ts` — shared with
      // `GET /search/overview`, because a predicate written twice is two places
      // for the prefilter (the index) or the recheck (the correctness) to go
      // missing from one of them.
      conditions.push(accountListSearchPredicate(search));
    }
    const where = and(...conditions);

    // ALWAYS paginated. An absent `?limit` is a page size, never "every
    // accessible list" — which is what it used to mean, and what let the search
    // screen's overview pull the whole table and then load members for all of
    // it. `id` breaks `updated_at` ties so the order is TOTAL and offsets never
    // shuffle rows between pages; one row is over-fetched to detect `hasMore`.
    const pageLimit = resolvePageLimit(req.query.limit, {
      fallback: DEFAULT_LIST_PAGE_SIZE,
      max: MAX_LIST_PAGE_SIZE,
    });
    const offset = resolvePageOffset(req.query.offset);

    const db = getDb();
    // `total` stays EXACT, including for a search — but it no longer runs
    // SERIALLY after the page query.
    //
    // Dropping it for searches was considered and measured, then rejected. The
    // count used to be expensive for the same reason the page query was: an
    // `ILIKE '%…%'` with no index that could serve it. But
    // `account_lists_search_trgm_gin` fixes the CAUSE — measured on 120k rows,
    // the same count went from 54ms (sequential scan) to 0.21ms for a selective
    // term — so removing `total` would have been a contract change buying
    // something the index already bought.
    //
    // It now shares a round trip with the page, so it adds wall clock only if
    // it is slower than the page query itself. Serially, its cost was added to
    // every request that asked for a page.
    //
    // `::int` so postgres.js hands back a NUMBER: a bare `count(*)` is a
    // bigint, which the driver returns as a STRING, and `total` would silently
    // change type on the wire.
    const [fetched, [counted]] = await Promise.all([
      db
        .select()
        .from(accountLists)
        .where(where)
        .orderBy(desc(accountLists.updatedAt), desc(accountLists.id))
        .limit(pageLimit + 1)
        .offset(offset),
      db.select({ total: sql<number>`count(*)::int` }).from(accountLists).where(where),
    ]);
    const total = counted.total;

    const hasMore = fetched.length > pageLimit;
    const page = hasMore ? fetched.slice(0, pageLimit) : fetched;
    const membersByList = await loadMembersByList(db, page.map((row) => row.id));
    const serialized = page.map((row) => serializeList(row, membersByList.get(row.id) ?? []));

    res.json({
      items: serialized,
      total,
      pagination: { offset, limit: pageLimit, hasMore },
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
  | { kind: 'tooManyMembers' }
  | { kind: 'ok'; list: typeof accountLists.$inferSelect; previousMemberIds: string[]; memberIds: string[] };

/**
 * The three non-`ok` outcomes every write handler below answers the same way.
 * A type predicate, not a plain boolean: `if (respondToFailure(res, outcome))
 * return;` needs the compiler to narrow `outcome` to `{ kind: 'ok' }` in the
 * code that follows, which a bare `boolean` return cannot do.
 */
function respondToFailure(
  res: Response,
  outcome: ListWriteOutcome,
): outcome is Exclude<ListWriteOutcome, { kind: 'ok' }> {
  if (outcome.kind === 'notFound') {
    res.status(404).json({ error: 'List not found' });
    return true;
  }
  if (outcome.kind === 'forbidden') {
    res.status(403).json({ error: 'Not allowed' });
    return true;
  }
  if (outcome.kind === 'tooManyMembers') {
    res.status(400).json({ error: `Maximum ${ACCOUNT_LIST_MAX_MEMBERS} members allowed` });
    return true;
  }
  return false;
}

// Update list
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const parsed = updateListSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((issue) => issue.message).join('; ') });
    }
    const { title, description, isPublic, memberOxyUserIds } = parsed.data;
    const replacesMembers = Array.isArray(memberOxyUserIds);

    const outcome = await getDb().transaction<ListWriteOutcome>(async (tx) => {
      // `FOR UPDATE`: this handler reads the list's current membership, computes
      // the next state in application memory, then writes it — the exact
      // read-compute-write shape where READ COMMITTED lets two concurrent
      // writers both read the SAME prior state and one's result silently
      // overwrite the other's. Locking the row here, before that read, means a
      // second writer's own `FOR UPDATE` blocks until this transaction commits
      // and then reads what THIS one actually wrote, not what it read.
      const [existing] = await tx
        .select()
        .from(accountLists)
        .where(eq(accountLists.id, String(req.params.id)))
        .limit(1)
        .for('update');
      if (!existing) return { kind: 'notFound' };
      if (existing.ownerOxyUserId !== userId) return { kind: 'forbidden' };

      const members = await loadMembersByList(tx, [existing.id]);
      const previousMemberIds = members.get(existing.id) ?? [];
      const memberIds = replacesMembers ? normalizeMemberIds(memberOxyUserIds) : previousMemberIds;
      if (memberIds.length > ACCOUNT_LIST_MAX_MEMBERS) return { kind: 'tooManyMembers' };

      // Built from LITERAL keys only. Drizzle keys `set()` by column PROPERTY
      // name and silently ignores an unknown one — writing nothing and throwing
      // nothing — so an update object assembled from request keys would be a
      // dropped write nobody notices.
      await tx
        .update(accountLists)
        .set({
          ...(title === undefined ? {} : { title }),
          ...(description === undefined ? {} : { description: description ? description : null }),
          ...(isPublic === undefined ? {} : { isPublic }),
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

    if (respondToFailure(res, outcome)) return;

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
      // Locked for the same reason every member-write below is: a concurrent
      // `POST /:id/members` (or any other writer) must either finish first and
      // have its result deleted, or block until this delete commits and find
      // the list already gone — never interleave with this read.
      const [existing] = await tx
        .select()
        .from(accountLists)
        .where(eq(accountLists.id, String(req.params.id)))
        .limit(1)
        .for('update');
      if (!existing) return { kind: 'notFound' };
      if (existing.ownerOxyUserId !== userId) return { kind: 'forbidden' };

      // Capture members BEFORE the delete so their endorsements can be retracted;
      // `account_list_members` cascades with the list and is gone afterwards.
      const members = await loadMembersByList(tx, [existing.id]);
      await tx.delete(accountLists).where(eq(accountLists.id, existing.id));
      const memberIds = members.get(existing.id) ?? [];
      return { kind: 'ok', list: existing, previousMemberIds: memberIds, memberIds };
    });

    if (respondToFailure(res, outcome)) return;

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
        .limit(1)
        .for('update');
      if (!existing) return { kind: 'notFound' };
      if (existing.ownerOxyUserId !== userId) return { kind: 'forbidden' };

      const members = await loadMembersByList(tx, [existing.id]);
      const previousMemberIds = members.get(existing.id) ?? [];
      const existingIds = new Set(previousMemberIds);
      // Existing members keep their positions and ROW. Only the ones actually
      // NEW are appended — a small add no longer rewrites the whole membership
      // the way `replaceMembers`'s delete-then-insert did.
      const toAdd = normalizeMemberIds(userIds).filter((id) => !existingIds.has(id));
      const memberIds = [...previousMemberIds, ...toAdd];
      if (memberIds.length > ACCOUNT_LIST_MAX_MEMBERS) return { kind: 'tooManyMembers' };

      if (toAdd.length > 0) {
        const startPosition = await nextMemberPosition(tx, existing.id);
        await tx.insert(accountListMembers).values(
          toAdd.map((oxyUserId, i) => ({ listId: existing.id, oxyUserId, position: startPosition + i })),
        );
      }
      return { kind: 'ok', list: existing, previousMemberIds, memberIds };
    });

    if (respondToFailure(res, outcome)) return;

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
        .limit(1)
        .for('update');
      if (!existing) return { kind: 'notFound' };
      if (existing.ownerOxyUserId !== userId) return { kind: 'forbidden' };

      const members = await loadMembersByList(tx, [existing.id]);
      const previousMemberIds = members.get(existing.id) ?? [];
      const toRemove = new Set(normalizeMemberIds(userIds));
      const memberIds = previousMemberIds.filter((id) => !toRemove.has(id));

      // A targeted delete of only the removed rows — never the full
      // rewrite `replaceMembers` does. It leaves gaps in `position`, which is
      // fine: every reader orders BY position, none of them assume it is
      // contiguous, and `nextMemberPosition` (not a row count) is what a later
      // append relies on instead.
      if (toRemove.size > 0) {
        await tx
          .delete(accountListMembers)
          .where(
            and(eq(accountListMembers.listId, existing.id), inArray(accountListMembers.oxyUserId, [...toRemove])),
          );
      }
      return { kind: 'ok', list: existing, previousMemberIds, memberIds };
    });

    if (respondToFailure(res, outcome)) return;

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
      notCollapsedCrosspostSql(),
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
