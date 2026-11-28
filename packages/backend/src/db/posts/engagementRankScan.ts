/**
 * The popular scans: public posts ordered by the engagement composite.
 *
 * Every popular/discovery lane that ORDERS BY {@link engagementRankSql} comes
 * through here (`runPopular` for `popular`, `popularVideos` and `popularMedia`;
 * the For You trending lane; `topReplies`). The caller states WHICH posts (a
 * predicate over `posts`, a `created_at` window, a keyset to continue after) and
 * this decides HOW they are read. There are two ways, and they return the same
 * rows in the same order.
 *
 * ## The single query (`FEED_ENGAGEMENT_RANKS` off, the default)
 *
 * The query every caller ran before: `posts` filtered and ordered by the
 * composite, which `posts_engagement_rank_idx` serves. That index covers the
 * four engagement counters, which is what makes every counter bump on `posts` a
 * non-HOT update of all 34 of its indexes (`post_engagement_ranks` in
 * `db/schema/posts.ts`).
 *
 * ## The banded read (`FEED_ENGAGEMENT_RANKS=on`)
 *
 * The order is `(rank desc, created_at desc, id desc)` (or `(rank desc, id
 * desc)` for `topReplies`), a total order because `id` is unique. Split the
 * posts by the sign of their rank and that order is three runs, one after the
 * other: every positive rank, then every rank of exactly 0, then every negative
 * one. So the first `limit` rows of the whole order are the first `limit` rows
 * of the three runs concatenated, read in that order and stopping as soon as
 * the page is full:
 *
 *  1. POSITIVE from `post_engagement_ranks` (its index is the old key), joined
 *     to `posts` for the caller's predicate.
 *  2. ZERO from `posts` itself, where every rank-0 post already sits in
 *     `(created_at desc, id desc)` order in `post_public_chrono_v1` /
 *     `posts_roots_chrono_idx` (rank-0 posts are not stored in the side table).
 *  3. NEGATIVE from `post_engagement_ranks` again. Counters are floored at 0 on
 *     write, so in production this run is empty; it is here so the result does
 *     not depend on that.
 *
 * Two things make the concatenation EXACTLY the old result rather than nearly:
 *
 *  - ONE SNAPSHOT. Whatever runs are read are read by ONE statement (see
 *    {@link selectBanded}), so a post whose rank changes while the page is read
 *    is seen at one rank by every run, as the single statement saw it. (A
 *    `REPEATABLE READ` transaction around separate statements would do the same
 *    at two extra round trips per page, about 1 ms; that is why it is not one.)
 *  - THE SIDE TABLE IS THE SET. The triggers write `post_engagement_ranks` in
 *    the transaction that writes `posts`, so in any snapshot it holds exactly
 *    the listed posts with a non-zero rank, at that rank and `created_at`. What
 *    can break that is a write that bypasses triggers (none in this codebase)
 *    and the unlocked backfill copying a post while it leaves the set, which is
 *    why the readers are switched on only after `backfillPostEngagementRanks`
 *    `MODE=verify` reports no mismatch (it repairs what it finds). The
 *    positive and negative runs still re-check the joined `posts` row is public
 *    and published (an equality the planner estimates correctly); they do NOT
 *    re-derive the rank from the counters, because an equality between the side
 *    rank and a computed expression is estimated at 0.5% of rows, and with that
 *    estimate the planner abandons the ordered index scan for a full sort
 *    (486 ms instead of 0.95 ms on the 4M-row replica).
 *
 * The `engagementScore` each row carries is computed from the `posts` counters
 * in both modes, so it is the same number either way.
 *
 * `popularEngagementBands.test.ts` runs every caller both ways over ties,
 * windows, cursors and the partial-set edges and compares the ids in order.
 */

import {
  and,
  arrayOverlaps,
  eq,
  getTableColumns,
  gt,
  gte,
  lt,
  lte,
  or,
  sql,
  type SQL,
  desc,
} from 'drizzle-orm';
import { type AnyPgColumn, unionAll } from 'drizzle-orm/pg-core';
import { isEngagementRankTableReadEnabled } from '../../config';
import { getDb } from '../postgres';
import { engagementRankSql, postEngagementRanks, posts } from '../schema/posts';
import { readableInLanguagesSql } from '../../mtn/feed/feedLanguage';

/** A position in the `(rank desc, created_at desc, id desc)` order. */
export interface EngagementRankKeyset {
  score: number;
  createdAt: Date;
  id: string;
}

/** An inclusive `created_at` window. */
export interface EngagementRankWindow {
  since?: Date;
  until?: Date;
}

export interface EngagementRankScan {
  /**
   * The caller's predicate over `posts`, WITHOUT the three conditions below
   * (pass those as {@link EngagementRankScan.window}, `isReply` and `languages`,
   * so the banded read can apply them inside the side table's index as well as
   * to `posts`). It must restrict the scan to public, published posts, as every
   * popular scan does; the banded read states that restriction again on its own.
   */
  where: SQL;
  window?: EngagementRankWindow;
  /** `posts.is_reply = isReply`, when the lane decides on it. */
  isReply?: boolean;
  /**
   * The reader-language predicate (`readableInLanguagesSql`) for this list, when
   * the lane applies one (`viewerLanguageFilter`).
   */
  languages?: readonly string[];
  /**
   * `'createdAt'`: `(rank desc, created_at desc, id desc)`, the popular order.
   * `'id'`: `(rank desc, id desc)`, `topReplies`'.
   */
  tiebreak: 'createdAt' | 'id';
  /** Continue strictly after this key. Only with the `'createdAt'` tiebreak. */
  after?: EngagementRankKeyset;
  limit: number;
}

/** A `posts` row plus the composite it was ordered by. */
export type EngagementRankedPost = typeof posts.$inferSelect & { engagementScore: number };

/** What a scan returns per row: the whole post, or only its id (`topReplies`). */
type Selection = 'post' | 'id';

function selectionFields(selection: Selection): Record<string, SQL | AnyPgColumn> {
  return selection === 'post'
    ? { ...getTableColumns(posts), engagementScore: postRankSql() }
    : { id: posts.id };
}

/** The composite over the `posts` row: the ORDER BY of the single query, the score of both. */
function postRankSql(): SQL<number> {
  return engagementRankSql(posts);
}

const listedSql = (): SQL =>
  and(eq(posts.visibility, 'public'), eq(posts.status, 'published')) as SQL;

/** The caller's predicate plus `isReply` and `languages`, over `posts`. */
function postsPredicates(scan: EngagementRankScan): SQL[] {
  const conditions: SQL[] = [scan.where];
  if (scan.isReply !== undefined) conditions.push(eq(posts.isReply, scan.isReply));
  if (scan.languages) conditions.push(readableInLanguagesSql(scan.languages));
  return conditions;
}

/**
 * `isReply` and `languages` over the side table's copies, which the triggers
 * keep equal to the `posts` columns (`languages && $list` holds exactly when
 * `readableInLanguagesSql` does). The side runs state them HERE INSTEAD of over
 * `posts`, for two reasons: the index-only scan rejects a candidate before it is
 * joined, and stating a condition on both copies makes the planner count its
 * selectivity twice — measured on the replica, a Spanish reader's estimate fell
 * to 12 rows for a LIMIT of 31 and the planner swapped the ordered index scan
 * for a sequential scan and a sort (68 ms instead of under 5).
 */
function sidePrefilters(scan: EngagementRankScan): SQL[] {
  const conditions: SQL[] = [];
  if (scan.isReply !== undefined) conditions.push(eq(postEngagementRanks.isReply, scan.isReply));
  if (scan.languages) {
    conditions.push(arrayOverlaps(postEngagementRanks.languages, [...scan.languages]));
  }
  return conditions;
}

/**
 * `(rank, created_at, id) < after`, over whichever columns hold the key.
 *
 * The `created_at` comparisons go through drizzle's OPERATORS rather than being
 * written into the template as `${after.createdAt}`: a JS `Date` interpolated
 * into a `sql` template reaches postgres.js unmapped and throws `TypeError: The
 * "string" argument must be of type string … Received an instance of Date`,
 * client-side. `lt`/`eq` map the Date through the column that knows its type.
 */
function keysetSql(
  rank: SQL | AnyPgColumn,
  createdAt: AnyPgColumn,
  id: AnyPgColumn,
  after: EngagementRankKeyset,
): SQL {
  return sql`(
    ${rank} < ${after.score}
    or (${rank} = ${after.score} and ${lt(createdAt, after.createdAt)})
    or (
      ${rank} = ${after.score}
      and ${eq(createdAt, after.createdAt)}
      and ${lt(id, after.id)}
    )
  )`;
}

function windowSql(createdAt: AnyPgColumn, window: EngagementRankWindow | undefined): SQL[] {
  const bounds: SQL[] = [];
  if (window?.since) bounds.push(gte(createdAt, window.since));
  if (window?.until) bounds.push(lte(createdAt, window.until));
  return bounds;
}

/**
 * Read the first `scan.limit` posts of the engagement order.
 *
 * @returns Rows in order, each with the `engagementScore` it sorted on.
 */
export function selectPostsByEngagementRank(
  scan: EngagementRankScan,
): Promise<EngagementRankedPost[]> {
  return selectByEngagementRank(scan, 'post') as Promise<EngagementRankedPost[]>;
}

/** {@link selectPostsByEngagementRank}, returning only the ids, in order. */
export function selectPostIdsByEngagementRank(scan: EngagementRankScan): Promise<{ id: string }[]> {
  return selectByEngagementRank(scan, 'id') as Promise<{ id: string }[]>;
}

async function selectByEngagementRank(
  scan: EngagementRankScan,
  selection: Selection,
): Promise<Record<string, unknown>[]> {
  if (scan.after && scan.tiebreak !== 'createdAt') {
    throw new Error('An engagement keyset needs the created_at tiebreak');
  }
  if (scan.limit <= 0) return [];
  if (!isEngagementRankTableReadEnabled()) return selectSingleQuery(scan, selection);
  return selectBanded(scan, selection);
}

/** The query as every popular scan ran it before the side table. */
function selectSingleQuery(
  scan: EngagementRankScan,
  selection: Selection,
): Promise<Record<string, unknown>[]> {
  const engagementScore = postRankSql();
  const conditions: SQL[] = [...postsPredicates(scan), ...windowSql(posts.createdAt, scan.window)];
  if (scan.after) {
    conditions.push(keysetSql(engagementScore, posts.createdAt, posts.id, scan.after));
  }
  const order =
    scan.tiebreak === 'createdAt'
      ? [sql`${engagementScore} desc`, sql`${posts.createdAt} desc`, sql`${posts.id} desc`]
      : [sql`${engagementScore} desc`, sql`${posts.id} desc`];
  return getDb()
    .select(selectionFields(selection))
    .from(posts)
    .where(and(...conditions))
    .orderBy(...order)
    .limit(scan.limit);
}

/** The CTE names of the three runs, in the order they are read. */
const RUNS = ['positive_run', 'zero_run', 'negative_run'] as const;
type RunName = (typeof RUNS)[number];

/** Rows of `run` already read, as SQL (inside the one statement). */
const countOf = (run: RunName): SQL => sql`(select count(*) from ${sql.identifier(run)})`;

/**
 * The banded read. Whatever it returns was read by ONE statement, so by one
 * snapshot, as the single query's result was.
 *
 * The common case is a page the positive run fills on its own (a 7-day window
 * holds tens of thousands of engaged public posts at production's volume). That
 * is one plain query, the side table joined to `posts`, no wider to plan than
 * the single query was.
 *
 * Otherwise (the positive run ran out, or the cursor is already past it) the
 * runs are read together in {@link selectRunsTogether}. Re-reading the positive
 * run there, rather than appending to the rows just read, is what keeps one
 * snapshot: a post whose rank crossed 0 between two statements would otherwise
 * be missed or served twice.
 */
async function selectBanded(
  scan: EngagementRankScan,
  selection: Selection,
): Promise<Record<string, unknown>[]> {
  const score = scan.after?.score;
  const included: RunName[] = [];
  // Positive ranks are all before the cursor when the cursor is at 0 or below,
  // and rank 0 is entirely before a negative cursor.
  if (score === undefined || score > 0) included.push('positive_run');
  if (score === undefined || score >= 0) included.push('zero_run');
  included.push('negative_run');

  if (included[0] === 'positive_run') {
    const rows = await sideRunQuery(scan, selectionFields(selection), 'positive', scan.limit);
    if (rows.length === scan.limit) return rows;
  }
  return selectRunsTogether(scan, selection, included);
}

/**
 * The runs as ONE statement:
 *
 *   with positive_run as (… limit $n),
 *        zero_run     as (… limit greatest(0, $n - count(positive_run))),
 *        negative_run as (… limit greatest(0, $n - count(both)))
 *   select posts.* from (positive_run union all zero_run union all negative_run) page
 *   join posts on posts.id = page.id
 *   order by run, rank desc, created_at desc, id desc limit $n
 *
 * A run's LIMIT is what the runs before it left of the page, so a later run is
 * not read at all once the page is full (a `LIMIT 0` node never starts its
 * scan). Each run returns only its sort key; the page's rows are read once at
 * the end, which keeps the statement narrow to plan. The final ORDER BY sorts at
 * most `limit` keys already in order; it is what makes the concatenation order a
 * guarantee rather than an accident of how `UNION ALL` is executed.
 */
function selectRunsTogether(
  scan: EngagementRankScan,
  selection: Selection,
  included: RunName[],
): Promise<Record<string, unknown>[]> {
  const db = getDb();
  const ctes = included.map((run, index) => {
    const earlier = included.slice(0, index);
    const limit =
      earlier.length === 0
        ? sql`${scan.limit}`
        : sql`greatest(0, ${scan.limit} - ${sql.join(earlier.map(countOf), sql` - `)})`;
    // Every run selects the same key columns (id, run, k1, k2); the side runs'
    // builder is typed by its looser field map, so it is narrowed to the zero
    // run's type for the union.
    const query =
      run === 'zero_run'
        ? zeroRunQuery(scan, limit)
        : (sideRunQuery(
            scan,
            runKeyFields(run === 'positive_run' ? 1 : 3),
            run === 'positive_run' ? 'positive' : 'negative',
            limit,
          ) as unknown as ReturnType<typeof zeroRunQuery>);
    return db.$with(run).as(query);
  });
  const [first, second, ...rest] = ctes.map((cte) => db.select().from(cte));
  const page = (second ? unionAll(first, second, ...rest) : first).as('page');

  const order =
    scan.tiebreak === 'createdAt'
      ? [page.run, desc(page.k1), desc(page.k2), desc(page.id)]
      : [page.run, desc(page.k1), desc(page.id)];
  if (selection === 'id') {
    return db
      .with(...ctes)
      .select({ id: page.id })
      .from(page)
      .orderBy(...order)
      .limit(scan.limit);
  }
  return db
    .with(...ctes)
    .select(selectionFields(selection))
    .from(page)
    .innerJoin(posts, eq(posts.id, page.id))
    .orderBy(...order)
    .limit(scan.limit);
}

/** A side run's sort key, as {@link selectRunsTogether} unions it. */
function runKeyFields(run: number) {
  return {
    // Named apart from every `posts` column: the page is joined back to `posts`.
    id: sql<string>`${postEngagementRanks.postId}`.as('page_post_id'),
    run: sql<number>`${run}::int`.as('page_run'),
    k1: sql<number>`${postEngagementRanks.engagementRank}`.as('page_rank'),
    k2: sql<Date>`${postEngagementRanks.createdAt}`.as('page_created_at'),
  };
}

/** A run read from `post_engagement_ranks`, in its index order. */
function sideRunQuery(
  scan: EngagementRankScan,
  fields: Record<string, SQL.Aliased | AnyPgColumn | SQL>,
  sign: 'positive' | 'negative',
  limit: number | SQL,
) {
  const ranks = postEngagementRanks;
  const conditions: SQL[] = [
    sign === 'positive' ? gt(ranks.engagementRank, 0) : lt(ranks.engagementRank, 0),
    ...windowSql(ranks.createdAt, scan.window),
    ...sidePrefilters(scan),
    listedSql(),
    scan.where,
  ];
  if (scan.after) {
    // Implied by the keyset; stated so the index scan STARTS at the cursor
    // instead of filtering its way down to it.
    conditions.push(lte(ranks.engagementRank, scan.after.score));
    conditions.push(keysetSql(ranks.engagementRank, ranks.createdAt, ranks.postId, scan.after));
  }
  // `nulls last` is the index's own spelling. Every key is NOT NULL, so it orders
  // nothing differently; without it the ORDER BY does not match the index and the
  // planner adds a sort.
  const order =
    scan.tiebreak === 'createdAt'
      ? [
          sql`${ranks.engagementRank} desc nulls last`,
          sql`${ranks.createdAt} desc nulls last`,
          sql`${ranks.postId} desc nulls last`,
        ]
      : [sql`${ranks.engagementRank} desc nulls last`, sql`${ranks.postId} desc nulls last`];
  return getDb()
    .select(fields)
    .from(ranks)
    .innerJoin(posts, eq(posts.id, ranks.postId))
    .where(and(...conditions))
    .orderBy(...order)
    .limit(limit as number);
}

/** The rank-0 run, read from `posts` in `(created_at desc, id desc)` order. */
function zeroRunQuery(scan: EngagementRankScan, limit: SQL) {
  const engagementScore = postRankSql();
  const conditions: SQL[] = [
    sql`${engagementScore} = 0`,
    ...windowSql(posts.createdAt, scan.window),
    listedSql(),
    ...postsPredicates(scan),
  ];
  // A cursor above 0 is before every rank-0 post; at 0 it continues by
  // (created_at, id). (Below 0 this run is not read at all.)
  if (scan.after && scan.after.score === 0) {
    // The first bound is implied by the second; stated so the chrono index scan
    // STARTS at the cursor. Without it a cursor two days deep filtered its way
    // past 212,801 newer rows on the replica (388 ms) before reaching the page.
    conditions.push(lte(posts.createdAt, scan.after.createdAt));
    conditions.push(
      or(
        lt(posts.createdAt, scan.after.createdAt),
        and(eq(posts.createdAt, scan.after.createdAt), lt(posts.id, scan.after.id)),
      ) as SQL,
    );
  }
  const order =
    scan.tiebreak === 'createdAt'
      ? [sql`${posts.createdAt} desc nulls last`, sql`${posts.id} desc nulls last`]
      : [sql`${posts.id} desc nulls last`];
  return getDb()
    .select({
      id: sql<string>`${posts.id}`.as('page_post_id'),
      run: sql<number>`2::int`.as('page_run'),
      k1: sql<number>`0::double precision`.as('page_rank'),
      k2: sql<Date>`${posts.createdAt}`.as('page_created_at'),
    })
    .from(posts)
    .where(and(...conditions))
    .orderBy(...order)
    .limit(limit as unknown as number);
}
