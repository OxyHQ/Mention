import { Router, type Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { qualified } from '../db/casing';
import { getDb, type DatabaseOrTransaction } from '../db/postgres';
import {
  customFeedDefinitionModules,
  customFeedMembers,
  customFeedSourceLists,
  customFeedTopics,
  customFeeds,
  FEED_CATEGORIES,
  feedGenerators,
  feedLikes,
  feedReviews,
} from '../db/schema/feeds';
import { validateBody, validateObjectId, schemas } from '../middleware/validate';
import { buildCustomFeedCreatePayload, buildCustomFeedUpdatePatch } from './customFeedWrite';
import { buildCustomFeedDefinition } from '../mtn/feed/definitions/customFeedDefinition';
import type { StoredFeedDefinition } from '../models/CustomFeed';
import type { ModuleRef } from '../mtn/feed/engine/types';
import { loadViewerFeedContext } from '../mtn/feed/feedContext';
import { feedEngine } from '../mtn/feed/engine/FeedEngine';
import { resolveUserSummaries, degradedActorSummary } from '../services/PostHydrationService';
import { createScopedOxyClient, getServiceOxyClient } from '../utils/oxyHelpers';
import type { CachedUserSummary } from '../services/userSummaryCache';
import type { PostUser } from '@mention/shared-types';
import { logger } from '../utils/logger';
import { queryInt, queryString } from '../utils/queryParams';

const router = Router();

/** Page size for the paginated custom-feed listings (marketplace, reviews, members). */
const DEFAULT_FEED_PAGE_SIZE = 20;
const MAX_FEED_PAGE_SIZE = 100;

/** Member avatars shown on a feed card in the discovery list. */
const LIST_MEMBER_AVATARS = 3;
/** Member avatars shown on the feed detail screen. */
const DETAIL_MEMBER_AVATARS = 4;
/** Member profiles resolved for the feed detail screen. */
const DETAIL_MEMBER_PROFILES = 50;

/**
 * The public owner/member/reviewer profile this route embeds — the canonical Oxy
 * {@link PostUser} (Oxy owns identity, same shape as `post.user` / Who-to-follow).
 */
type UserProfile = PostUser;

/**
 * Escape the characters `LIKE` treats as wildcards.
 *
 * The Mongo version built `new RegExp(escapeRegex(term), 'i')`, which is an
 * UNANCHORED substring match — hence the surrounding `%`. Escaping the REGEX
 * metacharacters here instead of the LIKE ones would leave `%` and `_` live and
 * turn a user's search box into a way to match every feed in the table.
 */
function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * A case-insensitive substring match against ANY element of a `text[]` column.
 *
 * Mongo's `{ keywords: /term/i }` matched a document when any element of the
 * array matched, which `ilike` on the column itself cannot express.
 * `unnest(NULL)` yields no rows, so a feed with no keywords simply does not
 * match — exactly what a missing field did.
 *
 * Takes an already-{@link qualified} column. See the note on the
 * `excludeSubscribed` predicate below for what that buys and what it does not.
 */
function arrayElementMatches(column: SQL, pattern: string): SQL {
  return sql`exists (select 1 from unnest(${column}) as element where element ilike ${pattern})`;
}

/**
 * Map a resolved {@link CachedUserSummary} to the embedded Oxy {@link PostUser}.
 * Passthrough — Oxy owns the shape (`name.displayName`, `avatar` file id,
 * `username`). Falls back to the degraded user (EMPTY username, so the client
 * suppresses the handle instead of rendering the raw id — the ghost-handle rule).
 */
function profileFromSummary(oxyUserId: string, cached: CachedUserSummary | undefined): UserProfile {
  return cached?.user ?? degradedActorSummary(oxyUserId);
}

/**
 * Resolve many Oxy user ids to {@link UserProfile}s in ONE batched, Redis-backed
 * pass via {@link resolveUserSummaries} — the same resolver feed hydration and
 * starter-pack enrichment use. This collapses what was a per-id `oxy.getUserById`
 * HTTP fan-out (the classic N+1, served only by the SDK's separate 5-minute
 * in-process cache) into a single bulk service call for the cache misses, sharing
 * the one 10-minute `usersummary:v1:` cache. Best-effort: a whole-batch failure
 * resolves every id to its id-only fallback profile rather than failing the
 * response.
 */
async function resolveUserProfiles(oxyUserIds: string[]): Promise<Map<string, UserProfile>> {
  const result = new Map<string, UserProfile>();
  const uniqueIds = Array.from(new Set(oxyUserIds.filter((id): id is string => typeof id === 'string' && id.length > 0)));
  if (uniqueIds.length === 0) return result;

  let summaries = new Map<string, CachedUserSummary>();
  try {
    summaries = await resolveUserSummaries(uniqueIds);
  } catch (error) {
    logger.warn('[CustomFeeds] Failed to resolve user profiles', {
      count: uniqueIds.length,
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }

  for (const id of uniqueIds) {
    result.set(id, profileFromSummary(id, summaries.get(id)));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Reassembling a feed document out of its five tables
// ---------------------------------------------------------------------------

type FeedRow = typeof customFeeds.$inferSelect;

/**
 * The child rows a feed needs before it can be serialized.
 *
 * Mongo carried all four of these INSIDE the document (`definition.sources` /
 * `.signals` / `.filters`, `memberOxyUserIds`, `sourceListIds`, `topicIds`), and
 * the API published every one of them. They are separate tables now, so every
 * read that serializes a feed has to gather them back — the wire format is the
 * contract, not the storage shape.
 */
interface FeedRelations {
  /** `sources` / `signals` / `filters`, each already in `position` order. */
  sources: ModuleRef[];
  signals: ModuleRef[];
  filters: ModuleRef[];
  memberOxyUserIds: string[];
  sourceListIds: string[];
  topicIds: string[];
}

function emptyRelations(): FeedRelations {
  return { sources: [], signals: [], filters: [], memberOxyUserIds: [], sourceListIds: [], topicIds: [] };
}

/** A module's `params` is `jsonb` and therefore `unknown`; only an object is one. */
function isParamsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Load the child rows for a page of feeds.
 *
 * Four queries rather than four-per-feed, and each is ordered so the arrays come
 * back the way the document held them. **Module order is EVALUATION order** —
 * the engine runs sources, then signals, then filters, in list order — so
 * `position` is not cosmetic and every read has to honour it.
 *
 * `custom_feed_source_lists` and `custom_feed_topics` carry no `position`
 * column, so their original array order is not recoverable; they are ordered by
 * `id` to be at least deterministic. Neither is order-sensitive (a source list
 * is a set union, a topic id is a set membership test).
 */
async function loadFeedRelations(
  db: DatabaseOrTransaction,
  feedIds: string[],
): Promise<Map<string, FeedRelations>> {
  const byFeed = new Map<string, FeedRelations>(feedIds.map((id) => [id, emptyRelations()]));
  if (feedIds.length === 0) return byFeed;

  // `inArray`, never a hand-built `= any(${ids})`: a raw JS array interpolated
  // into `sql` binds as a ROW constructor and Postgres rejects it at runtime.
  const [modules, members, sourceLists, topics] = await Promise.all([
    db
      .select()
      .from(customFeedDefinitionModules)
      .where(inArray(customFeedDefinitionModules.feedId, feedIds))
      .orderBy(asc(customFeedDefinitionModules.position)),
    db
      .select({ feedId: customFeedMembers.feedId, oxyUserId: customFeedMembers.oxyUserId })
      .from(customFeedMembers)
      .where(inArray(customFeedMembers.feedId, feedIds))
      .orderBy(asc(customFeedMembers.position)),
    db
      .select({ feedId: customFeedSourceLists.feedId, listId: customFeedSourceLists.listId })
      .from(customFeedSourceLists)
      .where(inArray(customFeedSourceLists.feedId, feedIds))
      .orderBy(asc(customFeedSourceLists.id)),
    db
      .select({ feedId: customFeedTopics.feedId, topicId: customFeedTopics.topicId })
      .from(customFeedTopics)
      .where(inArray(customFeedTopics.feedId, feedIds))
      .orderBy(asc(customFeedTopics.id)),
  ]);

  for (const row of modules) {
    const relations = byFeed.get(row.feedId);
    if (!relations) continue;
    const ref: ModuleRef = {
      module: row.module,
      enabled: row.enabled,
      ...(isParamsObject(row.params) ? { params: row.params } : {}),
      ...(row.weight === null ? {} : { weight: row.weight }),
    };
    if (row.kind === 'source') relations.sources.push(ref);
    else if (row.kind === 'signal') relations.signals.push(ref);
    else relations.filters.push(ref);
  }
  for (const row of members) byFeed.get(row.feedId)?.memberOxyUserIds.push(row.oxyUserId);
  for (const row of sourceLists) byFeed.get(row.feedId)?.sourceListIds.push(row.listId);
  for (const row of topics) byFeed.get(row.feedId)?.topicIds.push(row.topicId);

  return byFeed;
}

/**
 * The composable definition, or `undefined` for a feed that predates Phase 3.
 *
 * `definition_mode IS NULL` is exactly Mongoose's absent `definition`
 * subdocument, and the request-time fallback in `customFeedDefinition.ts`
 * depends on telling the two apart — a feed given an empty definition instead of
 * no definition would render empty rather than falling back to its legacy
 * filters.
 */
function definitionOf(row: FeedRow, relations: FeedRelations): StoredFeedDefinition | undefined {
  if (row.definitionMode === null) return undefined;
  return {
    mode: row.definitionMode,
    sources: relations.sources,
    signals: relations.signals,
    filters: relations.filters,
  };
}

/**
 * A feed exactly as it goes on the wire.
 *
 * The Mongo handlers spread a `.lean()` document and added `id`, so the response
 * carried `_id` AND `id` plus every persisted field — including the seven LEGACY
 * filter fields, which `db/schema/feeds.ts` keeps precisely because the running
 * code still reads them (`legacyCustomFeedToDefinition` derives a runnable
 * definition from them for any feed the backfill has not reached).
 *
 * Two rules, both from the batch-0 `LabelService` port:
 *  - an absent optional is OMITTED, not `null` — Mongoose left it `undefined`,
 *    which `JSON.stringify` drops, and drizzle's `null` would not;
 *  - an array whose Mongoose default was `[]` stays `[]`, never `null`.
 *
 * `__v` is the one Mongoose artefact not reproduced (`schema/CONVENTIONS.md`
 * forbids carrying it), and nothing has ever read it.
 */
function serializeFeed(row: FeedRow, relations: FeedRelations) {
  const definition = definitionOf(row, relations);
  return {
    _id: row.id,
    id: row.id,
    ownerOxyUserId: row.ownerOxyUserId,
    title: row.title,
    ...(row.description === null ? {} : { description: row.description }),
    isPublic: row.isPublic,
    ...(definition === undefined ? {} : { definition }),
    ...(row.icon === null ? {} : { icon: row.icon }),
    memberOxyUserIds: relations.memberOxyUserIds,
    sourceListIds: relations.sourceListIds,
    keywords: row.keywords ?? [],
    topicIds: relations.topicIds,
    includeReplies: row.includeReplies,
    includeBoosts: row.includeBoosts,
    includeMedia: row.includeMedia,
    ...(row.language === null ? {} : { language: row.language }),
    ...(row.category === null ? {} : { category: row.category }),
    tags: row.tags ?? [],
    ...(row.coverImage === null ? {} : { coverImage: row.coverImage }),
    subscriberCount: row.subscriberCount,
    averageRating: row.averageRating,
    ratingsCount: row.ratingsCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The `topicCount` the feed cards render — it counts KEYWORDS, not `topicIds`. */
function topicCountOf(row: FeedRow): number {
  return (row.keywords ?? []).length;
}

/** Load one feed with its child rows, or `null`. */
async function loadFeed(
  db: DatabaseOrTransaction,
  feedId: string,
): Promise<{ row: FeedRow; relations: FeedRelations } | null> {
  const [row] = await db.select().from(customFeeds).where(eq(customFeeds.id, feedId)).limit(1);
  if (!row) return null;
  const relations = await loadFeedRelations(db, [row.id]);
  return { row, relations: relations.get(row.id) ?? emptyRelations() };
}

/**
 * Replace a feed's module lists.
 *
 * DELETE-then-INSERT inside one transaction, which is what keeps
 * `custom_feed_definition_modules_feed_kind_position_key` from firing halfway
 * through: every old `(kind, position)` is released before any new one is
 * claimed, so a reorder that reuses the same positions cannot collide with
 * itself.
 */
async function replaceDefinitionModules(
  tx: DatabaseOrTransaction,
  feedId: string,
  definition: StoredFeedDefinition,
): Promise<void> {
  await tx
    .delete(customFeedDefinitionModules)
    .where(eq(customFeedDefinitionModules.feedId, feedId));

  const rows = (
    [
      ['source', definition.sources],
      ['signal', definition.signals],
      ['filter', definition.filters],
    ] as const
  ).flatMap(([kind, refs]) =>
    (refs ?? []).map((ref, position) => ({
      feedId,
      kind,
      position,
      module: ref.module,
      enabled: ref.enabled,
      params: ref.params ?? null,
      weight: ref.weight ?? null,
    })),
  );
  if (rows.length > 0) await tx.insert(customFeedDefinitionModules).values(rows);
}

/** Like counts for a page of feeds, keyed by feed id. Absent means zero. */
async function loadLikeCounts(feedIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (feedIds.length === 0) return counts;
  const rows = await getDb()
    .select({ feedId: feedLikes.feedId, total: count() })
    .from(feedLikes)
    .where(inArray(feedLikes.feedId, feedIds))
    .groupBy(feedLikes.feedId);
  for (const row of rows) counts.set(row.feedId, row.total);
  return counts;
}

/** Which of `feedIds` this viewer has liked (i.e. subscribed to). */
async function loadLikedFeedIds(userId: string, feedIds: string[]): Promise<Set<string>> {
  if (feedIds.length === 0) return new Set();
  const rows = await getDb()
    .select({ feedId: feedLikes.feedId })
    .from(feedLikes)
    .where(and(eq(feedLikes.userId, userId), inArray(feedLikes.feedId, feedIds)));
  return new Set(rows.map((row) => row.feedId));
}

// Create a new custom feed (composable definition)
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    // Whitelist + validate the body into a persist-ready payload. The owner is set
    // from the session below — never from the body — and no field is spread from
    // `req.body` (no mass-assignment of subscriberCount / ratings / owner).
    const built = buildCustomFeedCreatePayload(req.body);
    if (!built.ok) return res.status(400).json({ error: built.error });

    // The feed and its modules land together: a feed whose modules failed to
    // insert would run as an empty definition and quietly return no posts.
    const created = await getDb().transaction(async (tx) => {
      const [row] = await tx
        .insert(customFeeds)
        .values({
          ownerOxyUserId: userId,
          title: built.payload.title,
          description: built.payload.description ?? null,
          isPublic: built.payload.isPublic,
          icon: built.payload.icon ?? null,
          definitionMode: built.payload.definition.mode,
        })
        .returning();
      await replaceDefinitionModules(tx, row.id, built.payload.definition);
      const relations = await loadFeedRelations(tx, [row.id]);
      return { row, relations: relations.get(row.id) ?? emptyRelations() };
    });

    res.status(201).json(serializeFeed(created.row, created.relations));
  } catch (error) {
    logger.error('[CustomFeeds] Create custom feed error:', { userId: req.user?.id, error });
    res.status(500).json({ error: 'Failed to create feed' });
  }
});

// List feeds accessible to current user
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { mine, publicOnly, search } = req.query;
    // The owner filter used to be a Mongo query VALUE, so `?userId[$ne]=<viewer>`
    // could reach the query as an operator. A bound parameter cannot be an
    // operator, but the reader stays: a non-string must still be treated as
    // absent rather than coerced into a plausible-looking value.
    const queryUserId = queryString(req.query.userId);
    const conditions: Array<SQL | undefined> = [];

    if (queryUserId) {
      // Fetch feeds by a specific user — public only unless it's the current user
      conditions.push(eq(customFeeds.ownerOxyUserId, queryUserId));
      if (!userId || queryUserId !== userId) {
        conditions.push(eq(customFeeds.isPublic, true));
      }
    } else if (mine === 'true') {
      if (!userId) return res.status(401).json({ error: 'Authentication required' });
      conditions.push(eq(customFeeds.ownerOxyUserId, userId));
    } else if (publicOnly === 'true') {
      conditions.push(eq(customFeeds.isPublic, true));
    } else if (!userId) {
      conditions.push(eq(customFeeds.isPublic, true));
    } else {
      // default: mine + public
      conditions.push(or(eq(customFeeds.ownerOxyUserId, userId), eq(customFeeds.isPublic, true)));
    }

    // Add search functionality. Mongo wrapped this in `$and` alongside the
    // mine-or-public `$or`; `and(...)` of the two disjunctions is the same thing.
    if (search && typeof search === 'string' && search.trim()) {
      const pattern = likeContains(search.trim());
      conditions.push(
        or(
          ilike(customFeeds.title, pattern),
          ilike(customFeeds.description, pattern),
          arrayElementMatches(qualified(customFeeds.keywords), pattern),
        ),
      );
    }

    const where = and(...conditions);

    // Opt-in pagination: with `?limit` present, page the results (offset/limit,
    // over-fetching one row to detect `hasMore`); without it, keep the historical
    // "return every accessible feed" behaviour the feeds screen / profile tabs
    // rely on. `id` breaks `updatedAt` ties so offsets never shuffle rows.
    const rawLimit = queryInt(req.query.limit);
    const offset = Math.max(0, queryInt(req.query.offset) ?? 0);
    const listQuery = getDb()
      .select()
      .from(customFeeds)
      .where(where)
      .orderBy(desc(customFeeds.updatedAt), desc(customFeeds.id));
    let pageLimit: number | undefined;
    if (rawLimit !== undefined) {
      pageLimit = Math.min(Math.max(1, rawLimit), MAX_FEED_PAGE_SIZE);
    }
    const fetched =
      pageLimit === undefined
        ? await listQuery
        : await listQuery.limit(pageLimit + 1).offset(offset);
    const hasMore = pageLimit !== undefined && fetched.length > pageLimit;
    const items = hasMore ? fetched.slice(0, pageLimit) : fetched;

    const feedIds = items.map((item) => item.id);
    const [relationsByFeed, likeCountsMap, likedFeedsSet] = await Promise.all([
      loadFeedRelations(getDb(), feedIds),
      // Always fetched, even without a viewer.
      loadLikeCounts(feedIds),
      userId ? loadLikedFeedIds(userId, feedIds) : Promise.resolve(new Set<string>()),
    ]);

    // Resolve owner profiles AND member avatars (first 3 per feed) in ONE batched,
    // Redis-backed pass over the union of all ids — no per-id HTTP fan-out.
    const ownerIds = items.map((item) => item.ownerOxyUserId);
    const allMemberIds = new Set<string>();
    for (const item of items) {
      const relations = relationsByFeed.get(item.id) ?? emptyRelations();
      for (const id of relations.memberOxyUserIds.slice(0, LIST_MEMBER_AVATARS)) {
        allMemberIds.add(id);
      }
    }

    const profilesById = await resolveUserProfiles([...ownerIds, ...allMemberIds]);

    const normalizedItems = items.map((item) => {
      const relations = relationsByFeed.get(item.id) ?? emptyRelations();
      const memberAvatars = relations.memberOxyUserIds
        .slice(0, LIST_MEMBER_AVATARS)
        .map((id) => profilesById.get(id)?.avatar)
        .filter(Boolean);
      return {
        ...serializeFeed(item, relations),
        likeCount: likeCountsMap.get(item.id) || 0,
        isLiked: userId ? likedFeedsSet.has(item.id) : false,
        owner: profilesById.get(item.ownerOxyUserId),
        memberAvatars,
        memberCount: relations.memberOxyUserIds.length,
        topicCount: topicCountOf(item),
      };
    });

    // When paging, `total` is the full match count — its OWN query, deliberately.
    // Collapsing it into the page query as `count(*) OVER ()` is the classic
    // wrong move here: a window aggregate is carried BY the returned rows, so a
    // page past the end of the result set returns no rows, carries no total, and
    // the client reads "0 results" for a set with thousands in it. Unbounded, the
    // page IS the whole set and there is nothing to count.
    const total =
      pageLimit === undefined
        ? normalizedItems.length
        : (await getDb().select({ value: count() }).from(customFeeds).where(where))[0].value;

    res.json({
      items: normalizedItems,
      total,
      pagination: { offset, limit: pageLimit ?? normalizedItems.length, hasMore },
    });
  } catch (error) {
    logger.error('[CustomFeeds] List custom feeds error:', { userId: req.user?.id, error, query: req.query });
    res.status(500).json({ error: 'Failed to list feeds' });
  }
});

// Marketplace: get feeds by category counts
router.get('/marketplace/categories', async (_req: AuthRequest, res: Response) => {
  try {
    const results = await getDb()
      .select({ category: customFeeds.category, total: count() })
      .from(customFeeds)
      .where(and(eq(customFeeds.isPublic, true), isNotNull(customFeeds.category)))
      .groupBy(customFeeds.category)
      // Mongo sorted on the count alone, which left equal counts in plan order.
      .orderBy(desc(count()), asc(customFeeds.category));
    const categories = results
      .filter((row): row is { category: (typeof FEED_CATEGORIES)[number]; total: number } =>
        row.category !== null,
      )
      .map((row) => ({ category: row.category, count: row.total }));
    res.json({ categories });
  } catch (error) {
    logger.error('[CustomFeeds] Marketplace categories error:', { error });
    res.status(500).json({ error: 'Failed to load categories' });
  }
});

// Marketplace: browse public feeds with filtering, search, and sorting
router.get('/marketplace', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { search, sortBy = 'trending' } = req.query;
    const category = queryString(req.query.category);

    const page = Math.max(1, queryInt(req.query.page) || 1);
    const limit = Math.min(Math.max(1, queryInt(req.query.limit) || DEFAULT_FEED_PAGE_SIZE), MAX_FEED_PAGE_SIZE);
    const skip = (page - 1) * limit;

    const conditions: Array<SQL | undefined> = [eq(customFeeds.isPublic, true)];

    // `excludeSubscribed=true` — recommendation surfaces (the feed interstitial)
    // must never suggest a feed the viewer already has. "Subscribed" is a
    // `FeedLike` (the mechanism that maintains `CustomFeed.subscriberCount`), so
    // the viewer's own feeds and their liked feeds drop out of the page AND out
    // of `total`. Ignored for anonymous viewers — they subscribe to nothing.
    //
    // As a junction this is a NOT EXISTS, and it drops the 500-row cap the `$nin`
    // needed: the old query loaded at most 500 of the viewer's likes and any
    // subscription past that was silently re-recommended.
    //
    // `qualified()` on the correlated reference is DEFENSIVE, and the difference
    // is worth stating because the migration contract calls the bare rendering a
    // data-losing trap. Measured against drizzle's own output, `${customFeeds.id}`
    // interpolated into a WHERE fragment already renders `"custom_feeds"."id"`
    // here, so the two spellings compile identically today. The trap is real in a
    // DIFFERENT rendering shape — a `sql` subquery in the SELECT list of a
    // single-table, join-free statement renders every column bare, so
    // `where "post_id" = "id"` resolves both names against the subquery's own
    // table and matches nothing with no error. Qualifying unconditionally costs
    // nothing and survives a future edit that changes this statement's shape;
    // it is NOT what the exclusion test below is proving.
    if (userId && String(req.query.excludeSubscribed) === 'true') {
      conditions.push(ne(customFeeds.ownerOxyUserId, userId));
      conditions.push(sql`not exists (
        select 1 from ${feedLikes}
        where ${feedLikes.feedId} = ${qualified(customFeeds.id)}
          and ${feedLikes.userId} = ${userId}
      )`);
    }

    if (category !== undefined) {
      // A category outside the closed set matched no document in Mongo; the
      // column's CHECK means no row can carry one, so say so directly rather
      // than handing drizzle a value its enum type does not admit.
      const known = FEED_CATEGORIES.find((value) => value === category);
      conditions.push(known ? eq(customFeeds.category, known) : sql`false`);
    }

    if (search && typeof search === 'string' && search.trim()) {
      const pattern = likeContains(search.trim());
      conditions.push(
        or(
          ilike(customFeeds.title, pattern),
          ilike(customFeeds.description, pattern),
          arrayElementMatches(qualified(customFeeds.tags), pattern),
          arrayElementMatches(qualified(customFeeds.keywords), pattern),
        ),
      );
    }

    const where = and(...conditions);

    // Every branch ends in `id` so the order is TOTAL. This is offset
    // pagination: two rows that tie on every sort key are free to swap places
    // between page requests, which drops or duplicates a row at the boundary.
    // The trailing `createdAt` already makes a tie unlikely (it would take two
    // feeds created in the same microsecond, and nothing bulk-inserts them), so
    // this is pre-emptive rather than a fix for observed breakage — but the
    // failure is silent when it does happen, and `id` makes the order provably
    // total instead of probably total.
    let orderBy: SQL[];
    if (sortBy === 'rating' || sortBy === 'top_rated') {
      orderBy = [
        desc(customFeeds.averageRating),
        desc(customFeeds.ratingsCount),
        desc(customFeeds.createdAt),
        desc(customFeeds.id),
      ];
    } else if (sortBy === 'newest') {
      orderBy = [desc(customFeeds.createdAt), desc(customFeeds.id)];
    } else {
      // trending (default): sort by subscriberCount desc
      orderBy = [
        desc(customFeeds.subscriberCount),
        desc(customFeeds.createdAt),
        desc(customFeeds.id),
      ];
    }

    // TWO queries, page and count. See `GET /` for why a window count is wrong
    // for a total that has to survive a page past the end of the result set.
    const [items, totals] = await Promise.all([
      getDb().select().from(customFeeds).where(where).orderBy(...orderBy).limit(limit).offset(skip),
      getDb().select({ value: count() }).from(customFeeds).where(where),
    ]);
    const total = totals[0].value;

    // Resolve isLiked + owner profiles in parallel (subscriberCount already on feed rows)
    const feedIds = items.map((item) => item.id);
    const ownerIds = items.map((item) => item.ownerOxyUserId);

    const [relationsByFeed, likedFeedsSet, ownersMap] = await Promise.all([
      loadFeedRelations(getDb(), feedIds),
      userId ? loadLikedFeedIds(userId, feedIds) : Promise.resolve(new Set<string>()),
      resolveUserProfiles(ownerIds),
    ]);

    const normalizedItems = items.map((item) => {
      const relations = relationsByFeed.get(item.id) ?? emptyRelations();
      return {
        ...serializeFeed(item, relations),
        likeCount: item.subscriberCount || 0,
        isLiked: userId ? likedFeedsSet.has(item.id) : false,
        owner: ownersMap.get(item.ownerOxyUserId),
        memberCount: relations.memberOxyUserIds.length,
        topicCount: topicCountOf(item),
      };
    });

    res.json({
      items: normalizedItems,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    logger.error('[CustomFeeds] Marketplace list error:', { error, query: req.query });
    res.status(500).json({ error: 'Failed to load marketplace' });
  }
});

/**
 * List a user's FEED GENERATORS — third-party/algorithmic feeds keyed on `createdBy`.
 *
 * Today these are Bluesky feed generators mirrored into native `feed_generators`
 * rows (`source_network = 'atproto'`). Each is served by the feed engine via the
 * `feedgen|<uri>` descriptor returned as `descriptor` — opening one imports the
 * remote algorithm's output as NATIVE posts. This is the per-owner "native feeds
 * list keyed on createdBy" that surfaces a federated profile's synced Bluesky feeds
 * on its Feeds tab, alongside the account's native custom feeds. They are read-only
 * (owned upstream — the `source_*` columns mark them federated), so there is no
 * write route to guard here. Declared BEFORE `/:id` so `generators` never matches
 * the id param route.
 */
router.get('/generators', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const queryUserId = queryString(req.query.userId);
    const ownerId = queryUserId || (String(req.query.mine) === 'true' ? userId : undefined);
    if (!ownerId) {
      return res.status(400).json({ error: 'A userId or mine=true is required' });
    }

    // No `id` tie-break needed here, unlike the paginated listings above: this
    // is a single bounded page (a fixed `.limit()`, no `.offset()`, no `offset`
    // param, and the client wrapper's params are `{userId, mine}` only), so
    // there is no second page for tied rows to shuffle across.
    const items = await getDb()
      .select()
      .from(feedGenerators)
      .where(
        and(eq(feedGenerators.createdBy, ownerId), eq(feedGenerators.sourceNetwork, 'atproto')),
      )
      .orderBy(desc(feedGenerators.likeCount), desc(feedGenerators.updatedAt))
      .limit(MAX_FEED_PAGE_SIZE);

    const owner = (await resolveUserProfiles([ownerId])).get(ownerId);

    const normalizedItems = items.map((item) => ({
      id: item.id,
      uri: item.uri,
      descriptor: `feedgen|${item.uri}`,
      title: item.name,
      ...(item.description === null ? {} : { description: item.description }),
      ...(item.avatar === null ? {} : { avatar: item.avatar }),
      likeCount: item.likeCount || 0,
      owner,
    }));

    res.json({ items: normalizedItems, total: normalizedItems.length });
  } catch (error) {
    logger.error('[CustomFeeds] List feed generators error:', { userId: req.user?.id, error, query: req.query });
    res.status(500).json({ error: 'Failed to list feed generators' });
  }
});

// Get a feed by id
router.get('/:id', validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const feedId = String(req.params.id);
    const loaded = await loadFeed(getDb(), feedId);
    if (!loaded) return res.status(404).json({ error: 'Feed not found' });
    if (!loaded.row.isPublic && loaded.row.ownerOxyUserId !== userId) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const [likeCounts, likedFeedsSet] = await Promise.all([
      loadLikeCounts([feedId]),
      userId ? loadLikedFeedIds(userId, [feedId]) : Promise.resolve(new Set<string>()),
    ]);

    // Resolve owner + member profiles in ONE batched, Redis-backed pass.
    const memberIds = loaded.relations.memberOxyUserIds.slice(0, DETAIL_MEMBER_PROFILES);
    const profilesById = await resolveUserProfiles([loaded.row.ownerOxyUserId, ...memberIds]);

    const owner = profilesById.get(loaded.row.ownerOxyUserId) ?? null;
    // Preserve member ORDER (the map is keyed by id; rebuild the ordered list).
    const members = memberIds.map((id) => profilesById.get(id) ?? profileFromSummary(id, undefined));
    const memberAvatars = members.slice(0, DETAIL_MEMBER_AVATARS).map((m) => m.avatar).filter(Boolean);

    res.json({
      ...serializeFeed(loaded.row, loaded.relations),
      likeCount: likeCounts.get(feedId) ?? 0,
      isLiked: likedFeedsSet.has(feedId),
      owner,
      members,
      memberAvatars,
      memberCount: loaded.relations.memberOxyUserIds.length,
      topicCount: topicCountOf(loaded.row),
    });
  } catch (error) {
    logger.error('[CustomFeeds] Get feed error:', { userId: req.user?.id, feedId: req.params.id, error });
    res.status(500).json({ error: 'Failed to get feed' });
  }
});

// Update a feed (owner only)
router.put('/:id', validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const feedId = String(req.params.id);
    const [existing] = await getDb()
      .select({ id: customFeeds.id, ownerOxyUserId: customFeeds.ownerOxyUserId })
      .from(customFeeds)
      .where(eq(customFeeds.id, feedId))
      .limit(1);
    if (!existing) return res.status(404).json({ error: 'Feed not found' });
    if (existing.ownerOxyUserId !== userId) return res.status(403).json({ error: 'Not allowed' });

    // Whitelist + validate; only the returned patch keys are applied (no spread of
    // req.body, so owner/aggregate fields can never be reassigned).
    const built = buildCustomFeedUpdatePatch(req.body);
    if (!built.ok) return res.status(400).json({ error: built.error });

    const updated = await getDb().transaction(async (tx) => {
      // Built key by key, never from the request body: `set()` is keyed by
      // column PROPERTY name and silently IGNORES an unknown key, so an object
      // assembled from user input writes nothing and throws nothing.
      const patch: Partial<typeof customFeeds.$inferInsert> = {};
      if (built.payload.title !== undefined) patch.title = built.payload.title;
      if (built.payload.description !== undefined) patch.description = built.payload.description;
      if (built.payload.isPublic !== undefined) patch.isPublic = built.payload.isPublic;
      if (built.payload.icon !== undefined) patch.icon = built.payload.icon;
      if (built.payload.definition !== undefined) {
        patch.definitionMode = built.payload.definition.mode;
      }

      // `updated_at` is maintained by the application (`$onUpdate`), and it
      // orders the discovery list — so the row is touched even when the patch
      // only replaces modules, which is what `feed.save()` did.
      await tx
        .update(customFeeds)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(customFeeds.id, feedId));

      if (built.payload.definition !== undefined) {
        await replaceDefinitionModules(tx, feedId, built.payload.definition);
      }

      const reloaded = await loadFeed(tx, feedId);
      if (!reloaded) throw new Error(`Feed ${feedId} vanished inside its own transaction`);
      return reloaded;
    });

    res.json(serializeFeed(updated.row, updated.relations));
  } catch (error) {
    logger.error('[CustomFeeds] Update custom feed error:', { userId: req.user?.id, feedId: req.params.id, error });
    res.status(500).json({ error: 'Failed to update feed' });
  }
});

// Delete a feed (owner only)
router.delete('/:id', validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const feedId = String(req.params.id);
    const [feed] = await getDb()
      .select({ id: customFeeds.id, ownerOxyUserId: customFeeds.ownerOxyUserId })
      .from(customFeeds)
      .where(eq(customFeeds.id, feedId))
      .limit(1);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });
    if (feed.ownerOxyUserId !== userId) return res.status(403).json({ error: 'Not allowed' });
    // Modules, members, source lists, topics, likes and reviews all cascade.
    await getDb().delete(customFeeds).where(eq(customFeeds.id, feedId));
    res.json({ success: true });
  } catch (error) {
    logger.error('[CustomFeeds] Delete custom feed error:', { userId: req.user?.id, feedId: req.params.id, error });
    res.status(500).json({ error: 'Failed to delete feed' });
  }
});

// Add members (owner only)
router.post('/:id/members', validateObjectId('id'), validateBody(schemas.manageFeedMembers), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { userIds } = req.body || {};
    const feedId = String(req.params.id);
    const toAdd: string[] = Array.isArray(userIds) ? userIds : [];

    const result = await getDb().transaction(async (tx) => {
      // The row lock is what replaces the atomicity of rewriting one array:
      // `(feed_id, position)` is UNIQUE, so two concurrent adds computing the
      // same next position would make one of them fail on the constraint.
      const [feed] = await tx
        .select({ id: customFeeds.id, ownerOxyUserId: customFeeds.ownerOxyUserId })
        .from(customFeeds)
        .where(eq(customFeeds.id, feedId))
        .limit(1)
        .for('update');
      if (!feed) return { status: 404 as const, body: { error: 'Feed not found' } };
      if (feed.ownerOxyUserId !== userId) {
        return { status: 403 as const, body: { error: 'Not allowed' } };
      }

      const current = await tx
        .select({ oxyUserId: customFeedMembers.oxyUserId, position: customFeedMembers.position })
        .from(customFeedMembers)
        .where(eq(customFeedMembers.feedId, feedId))
        .orderBy(asc(customFeedMembers.position));

      // `new Set([...existing, ...toAdd])` kept existing order and appended the
      // genuinely new ids, deduped. Appending after the highest position is the
      // same thing without rewriting rows that did not change.
      const known = new Set(current.map((row) => row.oxyUserId));
      let nextPosition = current.reduce((max, row) => Math.max(max, row.position + 1), 0);
      const rows = [];
      for (const oxyUserId of toAdd) {
        if (known.has(oxyUserId)) continue;
        known.add(oxyUserId);
        rows.push({ feedId, oxyUserId, position: nextPosition });
        nextPosition += 1;
      }
      if (rows.length > 0) {
        await tx.insert(customFeedMembers).values(rows);
        await tx.update(customFeeds).set({ updatedAt: new Date() }).where(eq(customFeeds.id, feedId));
      }

      const reloaded = await loadFeed(tx, feedId);
      if (!reloaded) throw new Error(`Feed ${feedId} vanished inside its own transaction`);
      return { status: 200 as const, feed: reloaded };
    });

    if (result.status !== 200) return res.status(result.status).json(result.body);
    res.json(serializeFeed(result.feed.row, result.feed.relations));
  } catch (error) {
    logger.error('[CustomFeeds] Add feed members error:', { userId: req.user?.id, feedId: req.params.id, error });
    res.status(500).json({ error: 'Failed to add members' });
  }
});

// Remove members (owner only)
router.delete('/:id/members', validateObjectId('id'), validateBody(schemas.manageFeedMembers), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { userIds } = req.body || {};
    const feedId = String(req.params.id);
    const toRemove: string[] = Array.isArray(userIds) ? userIds : [];

    const result = await getDb().transaction(async (tx) => {
      const [feed] = await tx
        .select({ id: customFeeds.id, ownerOxyUserId: customFeeds.ownerOxyUserId })
        .from(customFeeds)
        .where(eq(customFeeds.id, feedId))
        .limit(1);
      if (!feed) return { status: 404 as const, body: { error: 'Feed not found' } };
      if (feed.ownerOxyUserId !== userId) {
        return { status: 403 as const, body: { error: 'Not allowed' } };
      }

      if (toRemove.length > 0) {
        // The surviving members keep their positions, so the remaining order is
        // untouched and gaps are harmless — `position` orders, it does not index.
        const removed = await tx
          .delete(customFeedMembers)
          .where(
            and(
              eq(customFeedMembers.feedId, feedId),
              inArray(customFeedMembers.oxyUserId, toRemove),
            ),
          )
          .returning({ id: customFeedMembers.id });
        if (removed.length > 0) {
          await tx.update(customFeeds).set({ updatedAt: new Date() }).where(eq(customFeeds.id, feedId));
        }
      }

      const reloaded = await loadFeed(tx, feedId);
      if (!reloaded) throw new Error(`Feed ${feedId} vanished inside its own transaction`);
      return { status: 200 as const, feed: reloaded };
    });

    if (result.status !== 200) return res.status(result.status).json(result.body);
    res.json(serializeFeed(result.feed.row, result.feed.relations));
  } catch (error) {
    logger.error('[CustomFeeds] Remove feed members error:', { userId: req.user?.id, feedId: req.params.id, error });
    res.status(500).json({ error: 'Failed to remove members' });
  }
});

// Timeline for a custom feed — runs the stored composable definition through the
// FeedEngine (the same engine that serves every descriptor feed).
router.get('/:id/timeline', validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const limit = Math.min(Math.max(queryInt(req.query.limit) || DEFAULT_FEED_PAGE_SIZE, 1), MAX_FEED_PAGE_SIZE);
    const cursor = queryString(req.query.cursor)?.trim();

    const loaded = await loadFeed(getDb(), String(req.params.id));
    if (!loaded) return res.status(404).json({ error: 'Feed not found' });
    if (!loaded.row.isPublic && loaded.row.ownerOxyUserId !== userId) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    // Resolve the runnable definition (stored, or derived from legacy fields for
    // feeds not yet backfilled) and run it against the viewer's feed context.
    // `buildCustomFeedDefinition` is pure and storage-agnostic — it reads the
    // document SHAPE, which `serializeFeed` reassembles — so the legacy fallback
    // keeps working unchanged.
    const stored = definitionOf(loaded.row, loaded.relations);
    const definition = buildCustomFeedDefinition({
      _id: loaded.row.id,
      title: loaded.row.title,
      isPublic: loaded.row.isPublic,
      ownerOxyUserId: loaded.row.ownerOxyUserId,
      memberOxyUserIds: loaded.relations.memberOxyUserIds,
      keywords: loaded.row.keywords ?? [],
      ...(loaded.row.language === null ? {} : { language: loaded.row.language }),
      includeReplies: loaded.row.includeReplies,
      includeBoosts: loaded.row.includeBoosts,
      includeMedia: loaded.row.includeMedia,
      ...(stored === undefined ? {} : { definition: stored }),
    });
    const requestOxyClient = createScopedOxyClient(req);
    const context = await loadViewerFeedContext(
      userId,
      requestOxyClient ?? getServiceOxyClient(),
    );
    context.privacyOxyClient = requestOxyClient;
    const response = await feedEngine.run(definition, context, { cursor, limit });

    // The frontend Feed component expects `items` to be posts directly.
    res.json({
      items: response.items,
      hasMore: response.hasMore,
      nextCursor: response.nextCursor,
      totalCount: response.totalCount,
    });
  } catch (error) {
    logger.error('[CustomFeeds] Custom feed timeline error:', { userId: req.user?.id, feedId: req.params.id, error });
    res.status(500).json({ error: 'Failed to load timeline' });
  }
});

// Like a feed
router.post('/:id/like', validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const feedId = String(req.params.id);

    // The like row and the counter move in ONE transaction, so a failure between
    // them cannot leave `subscriber_count` disagreeing with the rows that are
    // its authority.
    const result = await getDb().transaction(async (tx) => {
      const [feed] = await tx
        .select({ id: customFeeds.id, subscriberCount: customFeeds.subscriberCount })
        .from(customFeeds)
        .where(eq(customFeeds.id, feedId))
        .limit(1);
      if (!feed) return { status: 404 as const };

      // `onConflictDoNothing` + `returning` IS the dedup guard: a duplicate like
      // returns zero rows, so the increment below simply never runs. This is
      // what keeps a double-click from moving the counter twice.
      const inserted = await tx
        .insert(feedLikes)
        .values({ userId, feedId })
        .onConflictDoNothing({ target: [feedLikes.userId, feedLikes.feedId] })
        .returning({ id: feedLikes.id });

      if (inserted.length === 0) {
        return { status: 200 as const, likeCount: feed.subscriberCount, alreadyLiked: true };
      }

      const [updated] = await tx
        .update(customFeeds)
        .set({ subscriberCount: sql`${customFeeds.subscriberCount} + 1`, updatedAt: new Date() })
        .where(eq(customFeeds.id, feedId))
        .returning({ subscriberCount: customFeeds.subscriberCount });
      return { status: 200 as const, likeCount: updated.subscriberCount, alreadyLiked: false };
    });

    if (result.status === 404) return res.status(404).json({ error: 'Feed not found' });

    res.json({
      success: true,
      liked: true,
      likeCount: result.likeCount,
      message: result.alreadyLiked ? 'Feed already liked' : 'Feed liked successfully',
    });
  } catch (error) {
    logger.error('[CustomFeeds] Like feed error:', { userId: req.user?.id, feedId: req.params.id, error });
    res.status(500).json({ error: 'Failed to like feed' });
  }
});

// Unlike a feed
router.delete('/:id/like', validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const feedId = String(req.params.id);

    const result = await getDb().transaction(async (tx) => {
      const [feed] = await tx
        .select({ id: customFeeds.id, subscriberCount: customFeeds.subscriberCount })
        .from(customFeeds)
        .where(eq(customFeeds.id, feedId))
        .limit(1);
      if (!feed) return { status: 404 as const };

      const removed = await tx
        .delete(feedLikes)
        .where(and(eq(feedLikes.userId, userId), eq(feedLikes.feedId, feedId)))
        .returning({ id: feedLikes.id });

      if (removed.length === 0) {
        return { status: 200 as const, likeCount: feed.subscriberCount, wasLiked: false };
      }

      // `greatest(… - 1, 0)`, not a bare decrement: `custom_feeds_counts_check`
      // forbids a negative count, so a legacy row whose counter had already
      // drifted below its real subscriber set would turn an unlike into a 500.
      // Mongo went to -1 and the handler hid it with `Math.max` on the way out;
      // clamping in SQL keeps the column itself honest.
      const [updated] = await tx
        .update(customFeeds)
        .set({
          subscriberCount: sql`greatest(${customFeeds.subscriberCount} - 1, 0)`,
          updatedAt: new Date(),
        })
        .where(eq(customFeeds.id, feedId))
        .returning({ subscriberCount: customFeeds.subscriberCount });
      return { status: 200 as const, likeCount: updated.subscriberCount, wasLiked: true };
    });

    if (result.status === 404) return res.status(404).json({ error: 'Feed not found' });

    res.json({
      success: true,
      liked: false,
      likeCount: result.likeCount,
      message: result.wasLiked ? 'Feed unliked successfully' : 'Feed not liked',
    });
  } catch (error) {
    logger.error('[CustomFeeds] Unlike feed error:', { userId: req.user?.id, feedId: req.params.id, error });
    res.status(500).json({ error: 'Failed to unlike feed' });
  }
});

// Get reviews for a feed
router.get('/:id/reviews', validateObjectId('id'), async (req: AuthRequest, res: Response) => {
  try {
    const page = Math.max(1, queryInt(req.query.page) || 1);
    const limit = Math.min(Math.max(1, queryInt(req.query.limit) || DEFAULT_FEED_PAGE_SIZE), MAX_FEED_PAGE_SIZE);
    const skip = (page - 1) * limit;

    const feedId = String(req.params.id);

    // The page and its total are two queries, for the reason spelled out on
    // `GET /` — a `count(*) OVER ()` vanishes with the rows on a page past the
    // end and the client would render "no reviews" for a feed with hundreds.
    const [reviews, totals] = await Promise.all([
      // `id` keeps the order TOTAL across offset pages — see the marketplace
      // sort above for why. Pre-emptive: two reviews on one feed sharing a
      // microsecond is unlikely, and the drift it would cause is silent.
      getDb()
        .select()
        .from(feedReviews)
        .where(eq(feedReviews.feedId, feedId))
        .orderBy(desc(feedReviews.createdAt), desc(feedReviews.id))
        .limit(limit)
        .offset(skip),
      getDb().select({ value: count() }).from(feedReviews).where(eq(feedReviews.feedId, feedId)),
    ]);
    const total = totals[0].value;

    // Resolve reviewer profiles
    const reviewersMap = await resolveUserProfiles(reviews.map((review) => review.reviewerId));

    const normalizedReviews = reviews.map((review) => ({
      _id: review.id,
      id: review.id,
      feedId: review.feedId,
      reviewerId: review.reviewerId,
      rating: review.rating,
      ...(review.reviewText === null ? {} : { reviewText: review.reviewText }),
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
      reviewer: reviewersMap.get(review.reviewerId) || profileFromSummary(review.reviewerId, undefined),
    }));

    res.json({
      reviews: normalizedReviews,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    logger.error('[CustomFeeds] Get reviews error:', { feedId: req.params.id, error });
    res.status(500).json({ error: 'Failed to get reviews' });
  }
});

// Create or update a review for a feed
router.post('/:id/reviews', validateObjectId('id'), validateBody(schemas.createFeedReview), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const feedId = String(req.params.id);
    const { rating, reviewText } = req.body;
    // Mongoose stripped an `undefined` from the update document, so submitting a
    // review with no text NEVER cleared the text a previous submission had left.
    // An omitted `set` key does the same thing; writing `null` unconditionally
    // would not.
    const text: string | null =
      typeof reviewText === 'string' && reviewText.length > 0 ? reviewText : null;

    const result = await getDb().transaction(async (tx) => {
      const [feed] = await tx
        .select({ id: customFeeds.id })
        .from(customFeeds)
        .where(eq(customFeeds.id, feedId))
        .limit(1);
      if (!feed) return { status: 404 as const };

      const [review] = await tx
        .insert(feedReviews)
        .values({ feedId, reviewerId: userId, rating, reviewText: text })
        .onConflictDoUpdate({
          target: [feedReviews.feedId, feedReviews.reviewerId],
          set: {
            rating,
            updatedAt: new Date(),
            ...(text === null ? {} : { reviewText: text }),
          },
        })
        .returning();

      // Recomputed FROM THE ROWS on every review write, never nudged by
      // arithmetic: an incremental average drifts, and
      // `custom_feeds_average_rating_check` (0..5) is what a drifted one would
      // eventually collide with. `avg(integer)` is `numeric`, which postgres.js
      // hands back as a STRING — hence `mapWith(Number)`.
      const [stats] = await tx
        .select({
          average: sql<number>`coalesce(avg(${feedReviews.rating}), 0)`.mapWith(Number),
          total: count(),
        })
        .from(feedReviews)
        .where(eq(feedReviews.feedId, feedId));

      await tx
        .update(customFeeds)
        .set({
          averageRating: Math.round(stats.average * 10) / 10,
          ratingsCount: stats.total,
          updatedAt: new Date(),
        })
        .where(eq(customFeeds.id, feedId));

      return { status: 200 as const, review };
    });

    if (result.status === 404) return res.status(404).json({ error: 'Feed not found' });

    const { review } = result;
    res.json({
      _id: review.id,
      id: review.id,
      feedId: review.feedId,
      reviewerId: review.reviewerId,
      rating: review.rating,
      ...(review.reviewText === null ? {} : { reviewText: review.reviewText }),
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
    });
  } catch (error) {
    logger.error('[CustomFeeds] Create/update review error:', { userId: req.user?.id, feedId: req.params.id, error });
    res.status(500).json({ error: 'Failed to submit review' });
  }
});

export default router;
