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
 * Which plan wins — the BitmapAnd, or a newest-first walk of the window — is the
 * planner's call and moves with statistics (see `hotPathIndexes.test.ts` on why
 * asserting a plan choice over `posts` is flaky). Both are correct. What is NOT
 * the planner's call, and what the fix is for, is how many renditions the
 * statement reads: bounded by the window, not by the archive. So the assertion
 * is on the actual rows read from `post_content_variants`, from EXPLAIN ANALYZE,
 * with the unbounded statement as the control.
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

async function measure(): Promise<{ windowed: number; unbounded: number; postsInWindow: number; matches: number }> {
  const rollback = new Error('roll back the window fixture');
  let outcome = { windowed: -1, unbounded: -1, postsInWindow: -1, matches: -1 };

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
    const explain = async (window: { from?: Date; until?: Date }): Promise<number> => {
      const { sql: text, params } = postSearchWindowQuery(tx, where, WORD, window, 21).toSQL();
      const rows = await tx.execute<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
        sql.raw(`explain (analyze, format json) ${inline(text, params)}`),
      );
      return renditionRowsRead(rows[0]['QUERY PLAN'][0].Plan);
    };

    const windowed = await explain(lastDay);
    const unbounded = await explain({});
    const [counts] = await tx.execute<{ posts_in_window: number; matches: number }>(sql`
      select
        (select count(*)::int from posts where created_at >= ${lastDay.from?.toISOString()}::timestamptz) as posts_in_window,
        (select count(*)::int from post_content_variants
          where search_vector @@ websearch_to_tsquery('english', ${WORD})) as matches
    `);
    outcome = { windowed, unbounded, postsInWindow: counts.posts_in_window, matches: counts.matches };
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
  it('reads the renditions inside the window, not the archive', async () => {
    const { windowed, unbounded, postsInWindow, matches } = await measure();

    // The fixture is what it claims: a day is a small slice of two weeks, and
    // the word is spread across all of it.
    expect(postsInWindow).toBeGreaterThan(0);
    expect(postsInWindow).toBeLessThan(SEEDED_POSTS / 10);
    expect(matches).toBeGreaterThan(150);

    // The fix: whichever plan wins inside the window — the BitmapAnd, or a scan
    // of the window's renditions — it reads no more than the window holds.
    expect(windowed).toBeLessThanOrEqual(postsInWindow);
    // The control: unbounded, the same statement reads past the window (every
    // match, or a newest-first walk long enough to find 21 of them).
    expect(unbounded).toBeGreaterThan(postsInWindow);
  }, 60_000);
});
