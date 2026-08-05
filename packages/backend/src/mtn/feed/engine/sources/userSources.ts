/**
 * User-oriented source modules — the Hashtag, Author, and Saved feed queries
 * plus the `accounts` (custom-feed author list) source and `mutuals`.
 */

import { isAuthorFeedFilter, PostType, PostVisibility } from '@mention/shared-types';
import { and, arrayOverlaps, desc, eq, inArray, isNull, lt, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../../../../db/postgres';
import {
  bookmarks,
  lanes,
  likes,
  postAttachments,
  postAuthorships,
  postContentVariants,
  postMedia,
  posts,
  trending,
  userSettings,
} from '../../../../db/schema';
import { union, type PgColumn } from 'drizzle-orm/pg-core';
import { assemblePostRecords, loadPostRecords } from '../../../../db/posts/postRepository';
import { ProfileVisibility, requiresAccessCheck } from '../../../../utils/privacyHelpers';
import { excludedDisplayModesForTab, loadExcludedLaneIds } from '../../../../services/laneVisibility';
import { ChronoCursor, chronoCursorSql, chronoOrderBy } from '../../CursorBuilder';
import { notABoostSql } from '../../../../utils/feedQueryBuilder';
import { trendTermMatchSql } from '../../../../services/trending/termSpace';
import { logger } from '../../../../utils/logger';
import type { AuthorFeedFilter } from '@mention/shared-types';
import type { CandidatePost, FeedEngineContext, SourceModule } from '../types';

/**
 * The profile feed, fetched down BOTH indexed routes to an author's posts and
 * merged.
 *
 * One predicate cannot do this. "Whose post is this?" is answered by
 * `post_authorships` (the authority) OR by the denormalized `posts.oxy_user_id`,
 * and the two are not redundant — each reaches rows the other cannot:
 *
 *  - the authorship row alone covers accepted COLLABORATORS, and any post whose
 *    denormalized owner is NULL or stale;
 *  - the owner column alone covers a post with NO authorship row at all, which
 *    `insertChildRows` produces whenever it is handed an empty authorship list.
 *
 * Written as `or(...)` in a single scan — the previous shape — both are served,
 * but only `posts_owner_chrono_idx` can be used for the ORDER, so the
 * authorship half degrades into a probe-per-candidate walk. Split into two
 * branches, each one is an index scan on its own axis:
 * `posts_owner_chrono_idx` for the owner branch and
 * `post_authorships_author_chrono_idx` for the authorship branch, the latter
 * being why `post_authorships.post_created_at` exists at all.
 *
 * `union`, NOT `union all`, and this is a correctness bound rather than tidiness:
 * an ordinary post appears in BOTH branches (it has an owner column and an
 * authorship row), so `union all` returns it twice and the outer `LIMIT cap`
 * spends the page on duplicates. Measured — a page of 21 came back with 12
 * distinct posts. `union` de-duplicates on `(id, created_at)`, and `id` is the
 * primary key, so the pair is exactly as unique as the id.
 *
 * Both branches take the SAME `cap`, which is what makes the merge correct: the
 * newest `cap` rows overall must be among the newest `cap` of each branch.
 *
 * Measured on 624k posts, page of 21 — flat across author size, where every
 * previous shape traded one size against the other:
 *
 *   ordinary account (2,003 posts)    5.0 ms  ->  0.81-0.95 ms
 *   prolific account (20,000 posts)   5.8 ms  ->  0.93-1.00 ms
 */
export async function fetchAuthored(
  authorId: string,
  scope: SQL[],
  cursor: string | undefined,
  cap: number,
): Promise<CandidatePost[]> {
  const keyset = await chronoCursorSql(cursor);
  const where = keyset ? [...scope, keyset] : scope;
  const db = getDb();

  const ownerBranch = db
    .select({ id: posts.id, createdAt: posts.createdAt })
    .from(posts)
    .where(and(eq(posts.oxyUserId, authorId), ...where))
    .orderBy(...chronoOrderBy())
    .limit(cap);

  // Ordered by the AUTHORSHIP row's copy of the timestamp, not the post's, so
  // the whole branch is served by `post_authorships_author_chrono_idx`. The two
  // are equal by construction (`0021_faithful_bloodstrike`), which
  // `__tests__/authorshipChronoSync.test.ts` asserts rather than assumes.
  const authorshipBranch = db
    .select({ id: posts.id, createdAt: posts.createdAt })
    .from(postAuthorships)
    .innerJoin(posts, eq(posts.id, postAuthorships.postId))
    .where(
      and(
        eq(postAuthorships.oxyUserId, authorId),
        eq(postAuthorships.status, 'accepted'),
        ...where,
      ),
    )
    .orderBy(
      sql`${postAuthorships.postCreatedAt} desc nulls last`,
      sql`${postAuthorships.postId} desc nulls last`,
    )
    .limit(cap);

  const merged = await union(ownerBranch, authorshipBranch)
    .orderBy(sql`created_at desc nulls last`, sql`id desc nulls last`)
    .limit(cap);

  // `loadPostRecords` returns them in the order asked for, which is the order
  // the merge just established — the ids carry it, the second read must not
  // re-derive it.
  return loadPostRecords(merged.map((row) => row.id), db);
}

/** Run a chronological post scan with the shared keyset + order. */
async function fetchChrono(
  conditions: SQL[],
  cursor: string | undefined,
  cap: number,
): Promise<CandidatePost[]> {
  const keyset = await chronoCursorSql(cursor);
  const where = keyset ? [...conditions, keyset] : conditions;

  const db = getDb();
  const rows = await db
    .select()
    .from(posts)
    .where(and(...where))
    .orderBy(...chronoOrderBy())
    .limit(cap);
  return assemblePostRecords(rows, db);
}

/** Escape a literal for embedding in a POSIX regular expression. */
function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `keywords`: posts matching hashtags (Hashtag feed) and/or content keywords (custom). */
export const keywordsSource: SourceModule = {
  id: 'keywords',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, params, cap) => {
    const hashtags = Array.isArray(params.hashtags)
      ? (params.hashtags as string[]).map((t) => t.toLowerCase())
      : [];
    const keywords = Array.isArray(params.keywords) ? (params.keywords as string[]) : [];

    if (hashtags.length === 0 && keywords.length === 0) return [];

    const conditions: SQL[] = [eq(posts.visibility, 'public'), eq(posts.status, 'published')];
    const alternatives: SQL[] = [];

    if (keywords.length > 0) {
      // One alternation matching any keyword, rather than N separate EXISTS
      // scans over the same child table. `~*` is the case-insensitive POSIX
      // regex — the direct analogue of the JS `RegExp(..., 'i')` this replaces.
      const pattern = keywords.map(escapeRegexLiteral).join('|');
      alternatives.push(
        sql`exists ${getDb()
          .select({ one: sql`1` })
          .from(postContentVariants)
          .where(
            and(
              eq(postContentVariants.postId, posts.id),
              sql`${postContentVariants.body} ~* ${pattern}`,
            ),
          )}`,
      );
      // `arrayOverlaps`, never a raw `${array}::text[]`: a JS array interpolated
      // into a `sql` template binds as a ROW CONSTRUCTOR (`($1, $2)`), which
      // Postgres refuses to cast to `text[]` — so the whole query THROWS at
      // runtime rather than matching nothing. `coalesce(…, false)` stays because
      // `hashtags` is nullable and `NULL && ARRAY[…]` is NULL.
      alternatives.push(
        sql`coalesce(${arrayOverlaps(posts.hashtags, keywords.map((k) => k.toLowerCase()))}, false)`,
      );
    }

    if (hashtags.length > 0) {
      alternatives.push(sql`coalesce(${arrayOverlaps(posts.hashtags, hashtags)}, false)`);
    }

    conditions.push(or(...alternatives) as SQL);

    return fetchChrono(conditions, ctx.cursor, cap);
  },
};

/**
 * `trendTerms`: the posts behind ONE trend — what a reader lands on after
 * pressing it.
 *
 * Matched with {@link trendTermMatchSql} — the SAME definition the detection
 * batch counts over, shared rather than restated. A feed that matched less than
 * detection counted would open a reported trend onto a screen missing exactly
 * the posts that made it trend, which is why the two must not be able to drift.
 *
 * That is also why the descriptor's term is not the end of it: a row may stand
 * for several terms after co-occurrence merged them, and those live on the trend
 * ROW rather than in the descriptor — a descriptor carrying the whole list would
 * go stale the moment the next batch reshaped the story.
 *
 * `fetchChrono` orders on the CURSOR's own keyset (`created_at`, then `id`) —
 * never `id` alone. `posts.id` holds pre-cutover ObjectId hex AND post-cutover
 * uuid v7, so it is not a chronological axis at all: an `id` sort behind a
 * `created_at` cursor does not merely misorder, it permanently SKIPS rows at
 * every page boundary. This feed is mostly federated posts, so it is the worst
 * possible place for that. (Same rule as the `authored` source; see AGENTS.md
 * § Profile feed.)
 */
/**
 * Every term the trend named `term` stands for — itself, plus anything merged
 * into it.
 *
 * Reads the most recent row for the name, served by
 * `trending_name_calculated_at_type_key` as an exact prefix on `name`. Fail-soft
 * to the bare term: a lookup that finds nothing is the ordinary case for an
 * unmerged trend, and a lookup that throws should cost the extra posts, never
 * the feed.
 *
 * `terms` is nullable — 90 days of rows predate clustering — and a NULL there
 * means the same thing an unmerged row means, so both fall back to `[term]`.
 */
async function resolveTrendTerms(term: string): Promise<string[]> {
  try {
    const [row] = await getDb()
      .select({ terms: trending.terms })
      .from(trending)
      .where(eq(trending.name, term))
      .orderBy(desc(trending.calculatedAt))
      .limit(1);
    const terms = row?.terms ?? [];
    return terms.length > 1 ? terms : [term];
  } catch (error) {
    logger.warn('[Feed] Trend term lookup failed; matching the bare term', { term, error });
    return [term];
  }
}

export const trendTermsSource: SourceModule = {
  id: 'trendTerms',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, params, cap) => {
    const term = typeof params.term === 'string' ? params.term.trim().toLowerCase() : '';
    if (!term) return [];

    return fetchChrono(
      [
        trendTermMatchSql(await resolveTrendTerms(term)),
        eq(posts.visibility, 'public'),
        eq(posts.status, 'published'),
      ],
      ctx.cursor,
      cap,
    );
  },
};

/** `accounts`: posts from an explicit author-id list (custom feeds). */
export const accountsSource: SourceModule = {
  id: 'accounts',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, params, cap) => {
    const authorIds = Array.isArray(params.authorIds) ? (params.authorIds as string[]) : [];
    if (authorIds.length === 0) return [];

    return fetchChrono(
      [
        inArray(posts.oxyUserId, authorIds),
        eq(posts.visibility, 'public'),
        eq(posts.status, 'published'),
      ],
      ctx.cursor,
      cap,
    );
  },
};

/** "This post carries media", in the three shapes `mediaOnlyFilter.keep` recognizes. */
function hasMediaSql(): SQL {
  const db = getDb();
  return or(
    inArray(posts.type, [PostType.IMAGE, PostType.VIDEO]),
    sql`exists ${db.select({ one: sql`1` }).from(postMedia).where(eq(postMedia.postId, posts.id))}`,
    sql`exists ${db
      .select({ one: sql`1` })
      .from(postAttachments)
      .where(and(eq(postAttachments.postId, posts.id), eq(postAttachments.type, 'media')))}`,
  ) as SQL;
}

/**
 * The profile feed's conditions APART from who wrote the post — visibility, the
 * author's own lane curation, and the tab's content filter.
 *
 * The author term used to lead this list and now does not, because it stopped
 * being a predicate: {@link fetchAuthored} reaches the author's posts down two
 * separately-indexed routes and needs to attach this scope to each of them
 * independently. Keeping it here would apply it twice and, worse, would tie the
 * shared scope to one of the two routes.
 */
function buildAuthoredConditions(
  filter: AuthorFeedFilter,
  excludedLaneIds: readonly string[],
): SQL[] {
  const conditions: SQL[] = [
    eq(posts.visibility, PostVisibility.PUBLIC),
    eq(posts.status, 'published'),
  ];

  // The author's own curation (see `services/laneVisibility` for which modes are
  // excluded from which tab).
  //
  // The `is null` branch is REQUIRED and is not what Mongo needed: `$nin`
  // matched a document with no `laneId` at all, but SQL's `lane_id not in (…)`
  // evaluates to NULL — not true — for a NULL column, so it would drop every
  // post outside every lane. That is nearly the whole profile, and it would fail
  // as an empty feed rather than as an error.
  //
  // A disjunction is safe here where it never was in Mongo: drizzle's `and()`
  // composes, so no cursor keyset can clobber it the way
  // `ChronoCursor.applyToQuery`'s ASSIGNED `$or` could.
  if (excludedLaneIds.length > 0) {
    conditions.push(
      or(isNull(posts.laneId), notInArray(posts.laneId, [...excludedLaneIds])) as SQL,
    );
  }

  switch (filter) {
    case 'posts':
      // Boosts are top-level posts, so they surface on the main tab too — the
      // definition hydrates at depth 1 so the boosted original renders.
      conditions.push(eq(posts.isReply, false));
      break;
    case 'replies':
      conditions.push(eq(posts.isReply, true));
      break;
    case 'boosts':
      conditions.push(sql`${posts.boostOf} is not null`);
      break;
    case 'media':
      conditions.push(hasMediaSql(), eq(posts.isReply, false), notABoostSql());
      break;
    case 'videos':
      // Deliberately NARROWER than `media`: the two video shapes
      // `videoOnlyFilter.keep` recognizes, and no attachment branch, because
      // that predicate has none — including it would fetch posts the filter then
      // drops, paying for a page that arrives short. It is also narrower than
      // the GLOBAL videos feed (`FeedQueryBuilder.buildVideosQuery`), which
      // additionally gates on duration and orientation: a profile grid shows the
      // author's videos, not a reel lane's selection of them.
      conditions.push(
        or(
          eq(posts.type, PostType.VIDEO),
          sql`exists ${getDb()
            .select({ one: sql`1` })
            .from(postMedia)
            .where(and(eq(postMedia.postId, posts.id), eq(postMedia.type, 'video')))}`,
        ) as SQL,
        eq(posts.isReply, false),
        notABoostSql(),
      );
      break;
    case 'likes':
      break;
  }

  return conditions;
}

/**
 * Whether the viewer may see the profile's feed at all.
 *
 * A private / followers-only profile is gated on the viewer following it — the
 * same check the profile screen enforces, applied here so it holds for EVERY tab
 * (posts, replies, media, boosts, likes) rather than the posts themselves
 * leaking through their own `visibility: public` flag. Returning `false` yields
 * an empty feed, which is exactly what a viewer without access must see.
 */
async function canViewAuthorFeed(ctx: FeedEngineContext, authorId: string): Promise<boolean> {
  if (ctx.currentUserId === authorId) return true;
  const [settings] = await getDb()
    .select({ profileVisibility: userSettings.privacyProfileVisibility })
    .from(userSettings)
    .where(eq(userSettings.oxyUserId, authorId))
    .limit(1);
  const profileVisibility = settings?.profileVisibility ?? ProfileVisibility.PUBLIC;
  if (!requiresAccessCheck(profileVisibility)) return true;
  if (!ctx.currentUserId) return false;
  return (ctx.followingIds ?? []).includes(authorId);
}

/** Which liked posts the viewer is allowed to see, by post visibility. */
function buildVisibleLikedPostSql(ctx: FeedEngineContext): SQL {
  const viewerId = ctx.currentUserId;
  if (!viewerId) return eq(posts.visibility, PostVisibility.PUBLIC);

  const followAuthorizedIds = Array.from(
    new Set([viewerId, ...(ctx.followingIds ?? [])].filter(Boolean)),
  );

  return or(
    eq(posts.visibility, PostVisibility.PUBLIC),
    and(
      inArray(posts.oxyUserId, followAuthorizedIds),
      eq(posts.visibility, PostVisibility.FOLLOWERS_ONLY),
    ),
    and(eq(posts.oxyUserId, viewerId), eq(posts.visibility, PostVisibility.PRIVATE)),
  ) as SQL;
}

/**
 * Keyset over a RELATIONSHIP table (likes, bookmarks) whose own
 * `(created_at, id)` is the feed's order.
 *
 * These sources page over the relationship, not the post, so their cursor
 * anchors a `likes`/`bookmarks` row. The Mongo original filtered `_id < cursor`
 * while SORTING by `createdAt` — two different axes, which only appeared to work
 * because an ObjectId encodes creation time. Neither half survives here (`id` is
 * `text`, see `chronoOrderBy`), so the port pages on the axis it actually sorts
 * by.
 */
function relationshipKeyset(
  createdAtColumn: PgColumn,
  idColumn: PgColumn,
  cursor: string | undefined,
): SQL | undefined {
  const parsed = ChronoCursor.parse(cursor);
  if (!parsed?.ts) return undefined;
  const boundaryAt = new Date(parsed.ts);
  return or(
    lt(createdAtColumn, boundaryAt),
    and(eq(createdAtColumn, boundaryAt), lt(idColumn, parsed.id)),
  ) as SQL;
}

/**
 * The descending order {@link relationshipKeyset} pages against — written so an
 * index can actually serve it.
 *
 * `nulls last` for the same reason `chronoOrderBy` spells it out: both columns
 * are NOT NULL so it changes no row, but drizzle emits `.desc()` in index DDL as
 * `DESC NULLS LAST` while a query's `desc()` means `DESC NULLS FIRST`, and
 * Postgres compares the NULLS placement when deciding whether an index can
 * satisfy an ORDER BY. `likes_user_id_created_at_idx` and
 * `bookmarks_user_id_created_at_idx` are both `(user_id, created_at DESC NULLS
 * LAST)`, and both queries below are a per-viewer keyset over them.
 *
 * Measured, 20,000 rows for one viewer, page of 31:
 *
 *   likes      Seq Scan + Sort, cost 1092.42  →  Index Scan, cost 4.31
 *   bookmarks  Seq Scan + Sort, cost 1073.42  →  Index Scan, cost 4.24
 *
 * Neither index carries `id`, so the good plan is an Incremental Sort with
 * `created_at` presorted — it streams and only ever sorts one tie group, and the
 * LIMIT stops it after 32 rows instead of reading the viewer's whole history.
 */
function relationshipOrder(createdAtColumn: PgColumn, idColumn: PgColumn): SQL[] {
  return [sql`${createdAtColumn} desc nulls last`, sql`${idColumn} desc nulls last`];
}

/** The viewer's liked posts, in like order, for the ORDERED Author-likes feed. */
async function gatherAuthorLikes(authorId: string, ctx: FeedEngineContext): Promise<CandidatePost[]> {
  const pageLimit = ctx.pageLimit ?? 30;
  const db = getDb();

  const keyset = relationshipKeyset(likes.createdAt, likes.id, ctx.cursor);
  const likeRows = await db
    .select({ id: likes.id, postId: likes.postId, createdAt: likes.createdAt })
    .from(likes)
    .where(
      and(
        ...[eq(likes.userId, authorId), eq(likes.value, 1), ...(keyset ? [keyset] : [])],
      ),
    )
    .orderBy(...relationshipOrder(likes.createdAt, likes.id))
    .limit(pageLimit + 1);

  if (likeRows.length === 0) return [];

  const hasMore = likeRows.length > pageLimit;
  const page = hasMore ? likeRows.slice(0, pageLimit) : likeRows;
  const likedPostIds = page.map((row) => row.postId);

  const rows = await db
    .select()
    .from(posts)
    .where(
      and(
        inArray(posts.id, likedPostIds),
        eq(posts.status, 'published'),
        buildVisibleLikedPostSql(ctx),
      ),
    );
  const loaded: CandidatePost[] = await assemblePostRecords(rows, db);

  const postMap = new Map(loaded.map((post) => [post.id, post]));
  const ordered = likedPostIds
    .map((id) => postMap.get(id))
    .filter((post): post is CandidatePost => Boolean(post));

  if (hasMore && ordered.length > 0) {
    const anchor = page[page.length - 1];
    ordered[ordered.length - 1]._feedCursor = ChronoCursor.build(anchor.id, anchor.createdAt);
  }
  return ordered;
}

/**
 * `authored`: a single author's posts/replies/media/boosts (chronological) or
 * likes (ordered) — the profile feed. Params `{ authorId, filter }`.
 */
export const authoredSource: SourceModule = {
  id: 'authored',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, params, cap) => {
    const authorId = typeof params.authorId === 'string' ? params.authorId : '';
    if (!authorId) return [];
    const filterParam = typeof params.filter === 'string' ? params.filter : undefined;
    const filter: AuthorFeedFilter = isAuthorFeedFilter(filterParam) ? filterParam : 'posts';

    if (!(await canViewAuthorFeed(ctx, authorId))) return [];

    if (filter === 'likes') {
      // The likes tab lists OTHER people's posts, so the profile owner's own
      // lane curation has no bearing on it.
      return gatherAuthorLikes(authorId, ctx);
    }

    const excludedLaneIds = await loadExcludedLaneIds(
      authorId,
      excludedDisplayModesForTab(filter),
    );
    // Sorted by `created_at` — never by id — to match the chronological keyset.
    // A federated post's import-time id bears no relation to its remote
    // `createdAt`, so an id sort behind a `createdAt` cursor permanently skips
    // backfilled posts at the page boundary (the "boost disappears from the
    // profile feed" bug).
    return fetchAuthored(
      authorId,
      buildAuthoredConditions(filter, excludedLaneIds),
      ctx.cursor,
      cap,
    );
  },
};

/**
 * `lane`: ONE lane's own tab. Param `{ laneId }` — one parameter, because a lane
 * already knows its publisher.
 *
 * TWO GATES, and the feed is a back door without either of them:
 *
 *  1. **The publisher's own visibility.** A private / followers-only profile
 *     answers an empty feed to a non-follower here exactly as it does on every
 *     other profile tab (`canViewAuthorFeed`). A lane must never become a side
 *     entrance to a publisher the reader cannot see.
 *  2. **`displayMode === 'tab'` and nothing else.** `mixed` has no tab of its own
 *     (its posts are on the main one) and `hidden` is off the showcase
 *     altogether — serving either would make this descriptor the way to read a
 *     lane its owner took down.
 *
 * The query is `lane_id = …` plus the publisher's scope, deliberately NOT
 * `authorFeedSql`: that correlated `EXISTS` over `post_authorships` would pull
 * the planner onto `post_author_chrono_v1` instead of `post_lane_chrono_v1`, and
 * the literal `lane_id` term is also what lets the PARTIAL index be used at all.
 * The scope is `oxy_user_id` — ONE term, because a publisher is always an Oxy
 * account now — and a lane's posts and its publisher's posts are the same set by
 * construction (`assertLaneAssignable` refuses any other pairing), so the scope
 * term is a narrowing, not a second source of truth.
 *
 * No root filter: replies and boosts are refused a lane at the write boundary,
 * so filtering them here would be code that can never match.
 */
export const laneSource: SourceModule = {
  id: 'lane',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, params, cap) => {
    const laneId = typeof params.laneId === 'string' ? params.laneId : '';
    // No id-SHAPE guard. Ids here are pre-cutover ObjectId hex AND post-cutover
    // uuid v7, so an `ObjectId.isValid` gate would answer `false` for every lane
    // created since — and `false` here means an empty tab, which fails toward
    // silence and is invisible until somebody reports a lane that shows nothing.
    // A `text` id that matches no row already returns no rows.
    if (!laneId) return [];

    const [lane] = await getDb()
      .select({ ownerId: lanes.ownerId, displayMode: lanes.displayMode })
      .from(lanes)
      .where(eq(lanes.id, laneId))
      .limit(1);
    if (!lane) return [];

    // Gate 2 first: it is free, and it is the one that makes an unlisted lane
    // unreadable through this descriptor.
    if (lane.displayMode !== 'tab') return [];

    // Gate 1. One publisher, one check: a channel is an Oxy account, so a
    // channel's lane tab answers to `canViewAuthorFeed` exactly as a person's
    // does.
    if (!(await canViewAuthorFeed(ctx, lane.ownerId))) return [];

    // Ordered on the CURSOR's axis — `(created_at, id)`, never `id` alone — the
    // same rule every source here follows and the same order
    // `post_lane_chrono_v1` stores.
    return fetchChrono(
      [
        eq(posts.laneId, laneId),
        eq(posts.oxyUserId, lane.ownerId),
        eq(posts.visibility, PostVisibility.PUBLIC),
        eq(posts.status, 'published'),
      ],
      ctx.cursor,
      cap,
    );
  },
};

/** `saved`: the viewer's bookmarks in bookmark order (ORDERED). Wraps `SavedFeed`. */
export const savedSource: SourceModule = {
  id: 'saved',
  kind: 'source',
  userComposable: false,
  gather: async (ctx) => {
    if (!ctx.currentUserId) return [];
    const pageLimit = ctx.pageLimit ?? 30;
    const db = getDb();

    const keyset = relationshipKeyset(bookmarks.createdAt, bookmarks.id, ctx.cursor);
    const bookmarkRows = await db
      .select({ id: bookmarks.id, postId: bookmarks.postId, createdAt: bookmarks.createdAt })
      .from(bookmarks)
      .where(and(...[eq(bookmarks.userId, ctx.currentUserId), ...(keyset ? [keyset] : [])]))
      .orderBy(...relationshipOrder(bookmarks.createdAt, bookmarks.id))
      .limit(pageLimit + 1);

    if (bookmarkRows.length === 0) return [];

    const hasMore = bookmarkRows.length > pageLimit;
    const page = hasMore ? bookmarkRows.slice(0, pageLimit) : bookmarkRows;
    const postIds = page.map((row) => row.postId);

    const rows = await db
      .select()
      .from(posts)
      .where(and(inArray(posts.id, postIds), eq(posts.status, 'published')));
    const loaded: CandidatePost[] = await assemblePostRecords(rows, db);

    const postMap = new Map(loaded.map((post) => [post.id, post]));
    const ordered = postIds
      .map((id) => postMap.get(id))
      .filter((post): post is CandidatePost => Boolean(post));

    if (hasMore && ordered.length > 0) {
      const anchor = page[page.length - 1];
      ordered[ordered.length - 1]._feedCursor = ChronoCursor.build(anchor.id, anchor.createdAt);
    }
    return ordered;
  },
};

/**
 * `mutuals`: the viewer's mutual-follow authors, chronological. `ctx.mutualIds`
 * is populated by the controller only for the Mutuals feed; returns `[]` when it
 * is empty. Mutuals may show PUBLIC + FOLLOWERS_ONLY posts (a mutual is, by
 * definition, a follower).
 */
export const mutualsSource: SourceModule = {
  id: 'mutuals',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) => {
    const mutualIds = ctx.mutualIds ?? [];
    if (mutualIds.length === 0) return [];

    return fetchChrono(
      [
        inArray(posts.oxyUserId, mutualIds),
        inArray(posts.visibility, [PostVisibility.PUBLIC, PostVisibility.FOLLOWERS_ONLY]),
        eq(posts.status, 'published'),
      ],
      ctx.cursor,
      cap,
    );
  },
};

export const userSourceModules: SourceModule[] = [
  keywordsSource,
  trendTermsSource,
  accountsSource,
  authoredSource,
  laneSource,
  savedSource,
  mutualsSource,
];
