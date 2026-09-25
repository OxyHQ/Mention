/**
 * A posts search reads only the matches inside its time window (#1158).
 *
 * ## The regression this pins
 *
 * The GIN index finds the renditions matching a word but cannot order them, so
 * an unbounded "newest 21 matches" fetched EVERY match and every one of its
 * posts before keeping 21 — in production, 3,910 renditions for "climate" and
 * 9,209 buffers read, 6.0 s cold, when 85 of those matches were from the last
 * week. `postSearchWindowQuery` bounds the match by time on the rendition's own
 * copy of `created_at`, so the text index and that column's index can meet as a
 * bitmap AND.
 *
 * ## What is asserted, and why not the plan's shape
 *
 * Which plan wins — the BitmapAnd, or a scan of the window's renditions — is
 * the planner's call and moves with statistics (see `hotPathIndexes.test.ts` on
 * why asserting a plan choice is flaky), and this database is shared with every
 * other suite. Two things hold whatever it picks, and they are the fix:
 *
 *  - the time bound reaches the READ OF THE RENDITIONS (`post_created_at`
 *    appears in the plan; only the rendition side has that column — the posts
 *    side is `created_at`). Drop the bound from `postTextMatchSql` and the
 *    statement still returns the right page, via a posts walk, while reading
 *    every rendition of every post it passes: this is what fails then;
 *  - the renditions it reads, from EXPLAIN ANALYZE, are no more than the window
 *    holds — counted as renditions, not posts, because another suite's post in
 *    the window may carry several.
 *
 * Seeded and measured inside one transaction that is rolled back, so the rows
 * and their statistics reach no other suite.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb, type Transaction } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import {
  applyPostSearchPlanner,
  postSearchWindowQuery,
  postSearchWindows,
} from '../../services/search/postSearch';

/** Two weeks of posts, one a minute. */
const SEEDED_POSTS = 20_000;
/** In every 97th post's body (`g % 97`), so ~206 matches spread over the two weeks. */
const WORD = 'windowprobe42';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

interface PlanNode {
  'Relation Name'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  Plans?: PlanNode[];
}

/**
 * Rows read from `post_content_variants` by every node of the plan: the rows a
 * node returned plus the ones it read and discarded (EXPLAIN reports both per
 * loop).
 */
function renditionRowsRead(node: PlanNode): number {
  const own = node['Relation Name'] === 'post_content_variants'
    ? ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)
      + (node['Rows Removed by Index Recheck'] ?? 0)) * (node['Actual Loops'] ?? 1)
    : 0;
  return own + (node.Plans ?? []).reduce((sum, child) => sum + renditionRowsRead(child), 0);
}

async function measure(): Promise<{ plan: string; windowed: number; renditionsInWindow: number; matches: number }> {
  const rollback = new Error('roll back the window fixture');
  let outcome = { plan: '', windowed: -1, renditionsInWindow: -1, matches: -1 };

  await getDb().transaction(async (tx: Transaction) => {
    await tx.execute(sql`
      insert into posts (id, oxy_user_id, visibility, status, created_at)
      select 'post-search-window-' || g, 'post-search-window-author', 'public', 'published',
             date_trunc('milliseconds', now() - g * interval '1 minute')
      from generate_series(1, ${SEEDED_POSTS}) g
    `);
    await tx.execute(sql`
      insert into post_content_variants (id, post_id, position, source, body, post_created_at)
      select 'post-search-window-v' || g, p.id, 0, 'author',
             'common chatter about everyday things ' || case when g % 97 = 0 then ${WORD} else 'filler' end,
             p.created_at
      from generate_series(1, ${SEEDED_POSTS}) g
      join posts p on p.id = 'post-search-window-' || g
    `);
    await tx.execute(sql`analyze posts`);
    await tx.execute(sql`analyze post_content_variants`);
    await applyPostSearchPlanner(tx);

    const where = and(eq(posts.visibility, 'public'), eq(posts.status, 'published'));
    const [lastDay] = postSearchWindows(new Date());
    const { sql: text, params } = postSearchWindowQuery(tx, where, WORD, lastDay, 21).toSQL();
    const rows = await tx.execute<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
      sql.raw(`explain (analyze, format json) ${inline(text, params)}`),
    );
    const plan = rows[0]['QUERY PLAN'][0].Plan;

    const [counts] = await tx.execute<{ renditions_in_window: number; matches: number }>(sql`
      select
        (select count(*)::int from post_content_variants
          where post_created_at >= ${lastDay.from?.toISOString()}::timestamptz) as renditions_in_window,
        (select count(*)::int from post_content_variants
          where search_vector @@ websearch_to_tsquery('english', ${WORD})) as matches
    `);
    outcome = {
      plan: JSON.stringify(plan),
      windowed: renditionRowsRead(plan),
      renditionsInWindow: counts.renditions_in_window,
      matches: counts.matches,
    };
    throw rollback;
  }).catch((error: unknown) => {
    if (error !== rollback) throw error;
  });

  return outcome;
}

/** Inline bind parameters, so EXPLAIN plans the statement with the values in hand. */
function inline(text: string, params: unknown[]): string {
  return text.replace(/\$(\d+)/g, (_, index: string) => {
    const value = params[Number(index) - 1];
    if (typeof value === 'number') return String(value);
    if (value instanceof Date) return `'${value.toISOString()}'::timestamptz`;
    return `'${String(value).replace(/'/g, "''")}'`;
  });
}

describe('posts search time windows', () => {
  it('bounds the read of the renditions by the window', async () => {
    const { plan, windowed, renditionsInWindow, matches } = await measure();

    // The fixture is what it claims: a day is a small slice of two weeks, and
    // the word is spread across all of it.
    expect(renditionsInWindow).toBeGreaterThan(0);
    expect(matches).toBeGreaterThan(150);

    // The bound reaches the renditions, whichever plan reads them.
    expect(plan).toContain('post_created_at');
    // And they read no more than the window holds.
    expect(windowed).toBeGreaterThan(0);
    expect(windowed).toBeLessThanOrEqual(renditionsInWindow);
  }, 60_000);
});
