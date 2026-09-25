/**
 * The posts lane of search (`GET /search`): the text predicate, and the page
 * query run under the planner settings that keep it fast.
 *
 * ## Why this query needs its own planner settings (issue #1140)
 *
 * The right plan depends on how common the searched word is, and only the
 * word's own statistics can tell the planner which one it is:
 *
 * - a COMMON word is cheapest found by walking posts newest-first and checking
 *   each one's text — the 21st match is a few hundred posts in;
 * - a RARE word must be found through the `search_vector` GIN index — walking
 *   newest-first reads most of the table before the 21st match turns up.
 *
 * postgres.js PREPARES every statement, and after five executions on a
 * connection Postgres may switch a prepared statement to a GENERIC plan, one
 * built without looking at the parameter. The generic plan for this query is
 * the newest-first walk for every word. Measured on 1M seeded posts (warm
 * cache): "linux" (0.05% of posts) went 6.9ms → 1812ms once the connection had
 * switched; in production, on a larger and colder table, `/search` ran 3.2s,
 * 5.0s and 6.9s for "rust", "climate" and "linux", with the posts statement
 * 1.0–4.7s of each.
 *
 * `plan_cache_mode = force_custom_plan` plans every execution with the word in
 * hand. `max_parallel_workers_per_gather = 0` removes the other pathology the
 * same measurement found: a parallel newest-first walk under `LIMIT` has every
 * worker run far ahead of the rows the limit needs ("climate": 466ms parallel,
 * 32ms serial). And `statement_timeout` is `config.search.maxTimeMS`, which
 * was declared for exactly this query and bound nothing since the Mongo port;
 * the route already answers a timeout with 503.
 *
 * All three are `SET LOCAL`, on a transaction, so none of them can leak onto a
 * pooled connection another request picks up next.
 */

import { and, eq, exists, sql, type SQL } from 'drizzle-orm';

import { getDb, type DatabaseOrTransaction } from '../../db/postgres';
import { findPostRecords } from '../../db/posts/postRepository';
import type { PostRecord } from '../../db/posts/postRecord';
import { postContentVariants } from '../../db/schema/postContent';
import { posts } from '../../db/schema/posts';
import { chronoOrderBy } from '../../mtn/feed/CursorBuilder';
import { config } from '../../config';

/**
 * Whether any rendition of the post matches `textQuery`.
 *
 * `websearch_to_tsquery` is the parser whose input language matches what a
 * user types (quoted phrases, `or`, a leading `-`), and unlike `to_tsquery` it
 * cannot raise a syntax error on arbitrary input. The GIN-indexed
 * `search_vector` is what lets a rare word be found without a scan.
 */
export function postTextMatchSql(textQuery: string): SQL {
  return exists(
    getDb()
      .select({ one: sql`1` })
      .from(postContentVariants)
      .where(and(
        eq(postContentVariants.postId, posts.id),
        sql`${postContentVariants.searchVector} @@ websearch_to_tsquery('english', ${textQuery})`,
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

/** One newest-first page of the posts matching `where`, planned per search. */
export async function findPostSearchPage(where: SQL | undefined, limit: number): Promise<PostRecord[]> {
  return getDb().transaction(async (tx) => {
    await applyPostSearchPlanner(tx);
    return findPostRecords(where, { orderBy: chronoOrderBy(), limit }, tx);
  });
}
