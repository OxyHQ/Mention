/**
 * Hashtag aggregation over `posts`, owned by the service layer.
 *
 * Moved out of `routes/hashtags.ts` so `GET /search/overview` can run the same
 * hashtag search the dedicated tab runs, without a route importing another
 * route — `scripts/validate-architecture-boundaries.mjs` refuses a route
 * reaching into `db/`, and the corollary is that shared query logic belongs in
 * a service that both routes call rather than in whichever route happened to
 * define it first.
 *
 * The wire shapes stay in the route. This owns only the queries.
 */

import { and, asc, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';

import { getDb, type DatabaseOrTransaction } from '../../db/postgres';
import { hashtagsSearchTextSql, posts } from '../../db/schema/posts';
import { notCollapsedCrosspostSql } from '../../utils/feedQueryBuilder';
import { likeContains } from '@oxy.so/utils/sql';

/** Upper bound on the raw query we turn into a regex. */
export const HASHTAG_QUERY_MAX_LENGTH = 64;

export interface HashtagSearchResult {
  tag: string;
  count: number;
}

/** One page of hashtag matches plus whether a further page exists. */
export interface HashtagSearchPage {
  results: HashtagSearchResult[];
  hasMore: boolean;
}

/** The public posts a hashtag aggregation ranges over: public, with tags. */
export function taggedPublicPosts(extra?: SQL): SQL {
  return and(
    eq(posts.visibility, 'public'),
    // A cross-post carries its tags on both source objects, and counting both
    // gives the tag twice the volume one publication earned — the same argument
    // the bilingual-variant note below makes, one axis over. `trendDetection`
    // measures its term space the same way.
    notCollapsedCrosspostSql(),
    // `cardinality > 0` covers BOTH shapes Mongo needed two clauses for
    // (`$exists: true` and `$ne: []`); a NULL array is excluded by the
    // comparison being NULL, which is the same answer.
    sql`coalesce(cardinality(${posts.hashtags}), 0) > 0`,
    ...(extra ? [extra] : []),
  ) as SQL;
}

/**
 * `unnest(hashtags)` — the analogue of Mongo's `$unwind`, as a lateral join so
 * every tag of every matching post becomes its own row before grouping.
 */
export const UNNESTED_TAG = sql<string>`lower(tag.value)`;

/**
 * One page of matching public hashtags with the number of posts carrying each.
 *
 * The needle is a bound PARAMETER inside a `LIKE` pattern with the pattern's own
 * metacharacters escaped, not a regex: a raw user string interpreted as a pattern
 * was the injection / catastrophic-backtracking risk the Mongo version escaped
 * for, and `LIKE` has only three of them.
 *
 * Paging is a stable keyset: the `{ count desc, tag asc }` sort is fully
 * deterministic (the tag breaks count ties), so `OFFSET` never shuffles rows
 * between pages. One extra row is over-fetched purely to detect `hasMore`
 * without a second count query.
 *
 * `db` is the connection to run on. A caller bounding the search with
 * `withStatementTimeout` MUST pass the transaction it was handed: the timeout
 * is `SET LOCAL`, so a query issued on `getDb()` beside it runs unbounded.
 */
export async function searchHashtagsWithCounts(
  rawQuery: string,
  offset: number,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<HashtagSearchPage> {
  const rows = await hashtagSearchQuery(db, rawQuery, offset, limit);
  const hasMore = rows.length > limit;
  return { results: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

/**
 * The statement {@link searchHashtagsWithCounts} runs, unexecuted.
 *
 * Exported so `__tests__/db/searchIndexes.test.ts` can EXPLAIN the query the
 * service actually issues rather than a hand-written copy of it — a copy is
 * how the prefilter drifted off the index without any test noticing.
 */
export function hashtagSearchQuery(db: DatabaseOrTransaction, rawQuery: string, offset: number, limit: number) {
  // Lower-cased and length-capped BEFORE escaping, because the cap counts the
  // caller's characters and the escape adds its own — capping after would let a
  // term of backslashes produce a pattern twice the intended length.
  const needle = rawQuery.trim().toLowerCase().slice(0, HASHTAG_QUERY_MAX_LENGTH);
  const pattern = likeContains(needle);
  return db
    .select({ tag: UNNESTED_TAG, count: sql<number>`count(*)::int` })
    .from(posts)
    .innerJoin(sql`lateral unnest(${posts.hashtags}) as tag(value)`, sql`true`)
    .where(and(
      taggedPublicPosts(),
      // Redundant with the exact per-element check below on purpose: this one
      // is what lets Postgres use `posts_hashtags_trgm_gin` (a trigram index
      // over the CONCATENATED tags) to narrow candidate POSTS cheaply, instead
      // of unnesting and pattern-matching every tagged post's every tag. It can
      // only ever admit MORE rows than the real answer (a match spanning a
      // boundary between two tags), never fewer, so the exact check right
      // after it is what the result actually depends on — see the index's own
      // comment in `db/schema/posts.ts`. The expression is the index's own
      // (`hashtagsSearchTextSql`), never restated: spelled any other way the
      // planner cannot match it and the filter reads every tagged post.
      sql`${hashtagsSearchTextSql(posts.hashtags)} ilike ${pattern}`,
      sql`lower(tag.value) like ${pattern}`,
    ))
    .groupBy(UNNESTED_TAG)
    .orderBy(desc(sql`count(*)`), asc(UNNESTED_TAG))
    .offset(offset)
    .limit(limit + 1);
}

/** Per-tag post counts within one time window, keyed by lowercase tag. */
export async function countTagsInWindow(from: Date, until?: Date): Promise<Map<string, number>> {
  const bounds = until
    ? and(gte(posts.createdAt, from), lt(posts.createdAt, until)) as SQL
    : gte(posts.createdAt, from);
  const rows = await getDb()
    .select({ tag: UNNESTED_TAG, count: sql<number>`count(*)::int` })
    .from(posts)
    .innerJoin(sql`lateral unnest(${posts.hashtags}) as tag(value)`, sql`true`)
    .where(taggedPublicPosts(bounds))
    .groupBy(UNNESTED_TAG);
  return new Map(rows.map((row) => [row.tag, row.count]));
}
