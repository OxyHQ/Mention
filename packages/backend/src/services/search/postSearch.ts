/**
 * The posts lane of search (`GET /search`): the text predicate, and the page
 * query run under the planner settings and time windows that keep it fast.
 *
 * ## Why the text match is bounded by time (issue #1158)
 *
 * The GIN index on `post_content_variants.search_vector` finds the renditions
 * matching a word, but it cannot order them, and "newest first" is what the
 * page asks for. Unbounded, the only ways to the newest 21 matches are to fetch
 * EVERY match and every one of its posts, then sort (a common-ish word: "climate"
 * matched 3,910 renditions in production, 9,209 buffers read, 6.0 s cold), or to
 * walk posts newest-first checking each one's text (fine for "news", hopeless for
 * a rare word). Both grow with the whole archive.
 *
 * So the page is assembled from time WINDOWS, newest first — the last day, then
 * the week before it, then the month, then everything older — and stops as soon
 * as it has enough rows. Inside a window the text index and the btree on
 * `post_content_variants.post_created_at` (a copy of `posts.created_at`) meet as
 * a BitmapAnd, so only the matches inside the window are fetched: 85 for
 * "climate" in the last week, instead of 3,910. The windows partition time, so
 * concatenating them newest-first IS the newest-first order; nothing is skipped
 * and nothing is re-sorted across windows.
 *
 * Each window bounds `posts.created_at` as well as the rendition's copy. Without
 * the posts-side bound the planner may walk `posts` newest-first from NOW and
 * step over everything newer than the window before reaching it — measured on
 * 1.2M synthetic posts, an older window went from 1.9M buffers to 7k with it.
 *
 * ## Why this query needs its own planner settings (issue #1140)
 *
 * postgres.js PREPARES every statement, and after five executions on a
 * connection Postgres may switch a prepared statement to a GENERIC plan, one
 * built without looking at the parameters. A generic plan cannot tell a rare
 * word from a common one, or a one-day window from an unbounded one.
 * `plan_cache_mode = force_custom_plan` plans every window with its word and its
 * bounds in hand. `max_parallel_workers_per_gather = 0` removes the other
 * pathology the #1140 measurement found: a parallel newest-first walk under
 * `LIMIT` has every worker run far ahead of the rows the limit needs. And
 * `statement_timeout` is `config.search.maxTimeMS`; the route answers a timeout
 * with 503.
 *
 * All three are `SET LOCAL`, on a transaction, so none of them can leak onto a
 * pooled connection another request picks up next.
 */

import { and, eq, exists, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';

import { getDb, type DatabaseOrTransaction } from '../../db/postgres';
import { findPostRecords } from '../../db/posts/postRepository';
import type { PostRecord } from '../../db/posts/postRecord';
import { postContentVariants } from '../../db/schema/postContent';
import { posts } from '../../db/schema/posts';
import { chronoOrderBy } from '../../mtn/feed/CursorBuilder';
import { config } from '../../config';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far back each window reaches from the newest bound, newest first. After
 * the last one comes a final window with no lower bound. Sized from production
 * (2026-09-25): ~2k posts a day, ~39k a week, ~350k a month, 1.46M in all.
 */
export const POST_SEARCH_WINDOWS_MS: readonly number[] = [DAY_MS, 7 * DAY_MS, 30 * DAY_MS];

/** A `[from, until)` span of `created_at`; an absent end is unbounded. */
export interface PostSearchWindow {
  from?: Date;
  until?: Date;
}

/**
 * The windows, newest first, reaching back from `newest` — the search cursor's
 * `created_at`, or now. They partition time: each window's `from` is the next
 * one's `until`.
 */
export function postSearchWindows(newest: Date): PostSearchWindow[] {
  const bounds = POST_SEARCH_WINDOWS_MS.map((span) => new Date(newest.getTime() - span));
  return [
    { from: bounds[0] },
    ...bounds.slice(1).map((from, index) => ({ from, until: bounds[index] })),
    { until: bounds[bounds.length - 1] },
  ];
}

function withinWindow(column: typeof posts.createdAt | typeof postContentVariants.postCreatedAt, window: PostSearchWindow): SQL[] {
  return [
    ...(window.from ? [gte(column, window.from)] : []),
    ...(window.until ? [lt(column, window.until)] : []),
  ];
}

/**
 * Whether any rendition of the post matches `textQuery`, optionally inside a
 * time window.
 *
 * `websearch_to_tsquery` is the parser whose input language matches what a
 * user types (quoted phrases, `or`, a leading `-`), and unlike `to_tsquery` it
 * cannot raise a syntax error on arbitrary input. The GIN-indexed
 * `search_vector` is what lets a rare word be found without a scan.
 */
export function postTextMatchSql(textQuery: string, window: PostSearchWindow = {}): SQL {
  return exists(
    getDb()
      .select({ one: sql`1` })
      .from(postContentVariants)
      .where(and(
        eq(postContentVariants.postId, posts.id),
        sql`${postContentVariants.searchVector} @@ websearch_to_tsquery('english', ${textQuery})`,
        ...withinWindow(postContentVariants.postCreatedAt, window),
      )),
  ) as SQL;
}

/** Apply the planner settings above to `tx`. Exported for the plan test. */
export async function applyPostSearchPlanner(tx: DatabaseOrTransaction): Promise<void> {
  await tx.execute(sql`select
    set_config('plan_cache_mode', 'force_custom_plan', true),
    set_config('max_parallel_workers_per_gather', '0', true),
    set_config('statement_timeout', ${String(config.search.maxTimeMS)}, true)`);
}

/**
 * The ids of one window's page: posts matching `where` and the text, inside the
 * window on BOTH sides — the rendition's copy of `created_at`, which is what
 * the BitmapAnd uses, and `posts.created_at`, which keeps a newest-first walk
 * from starting above the window. Exported for the plan test.
 */
export function postSearchWindowQuery(
  db: DatabaseOrTransaction,
  where: SQL | undefined,
  textQuery: string,
  window: PostSearchWindow,
  limit: number,
) {
  return db
    .select({ id: posts.id })
    .from(posts)
    .where(and(where, ...withinWindow(posts.createdAt, window), postTextMatchSql(textQuery, window)))
    .orderBy(...chronoOrderBy())
    .limit(limit);
}

/** The text half of a posts search. */
export interface PostSearchText {
  query: string;
  /**
   * The newest `created_at` the page may contain — the cursor's, when paging.
   * The windows reach back from here, so page two starts at page one's end
   * rather than re-walking the day before it. Defaults to now.
   */
  newest?: Date;
}

/**
 * One newest-first page of the posts matching `where` (and `text`, when there
 * is one), planned per search.
 *
 * `where` must already carry the cursor's keyset bound when paging; the windows
 * only narrow it.
 */
export async function findPostSearchPage(
  where: SQL | undefined,
  limit: number,
  text?: PostSearchText,
): Promise<PostRecord[]> {
  return getDb().transaction(async (tx) => {
    await applyPostSearchPlanner(tx);
    if (!text) {
      return findPostRecords(where, { orderBy: chronoOrderBy(), limit }, tx);
    }

    const ids: string[] = [];
    for (const window of postSearchWindows(text.newest ?? new Date())) {
      const page = await postSearchWindowQuery(tx, where, text.query, window, limit - ids.length);
      ids.push(...page.map((row) => row.id));
      if (ids.length >= limit) break;
    }
    if (ids.length === 0) return [];
    return findPostRecords(inArray(posts.id, ids), { orderBy: chronoOrderBy() }, tx);
  });
}
