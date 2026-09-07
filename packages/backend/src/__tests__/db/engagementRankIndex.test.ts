/**
 * `posts_engagement_rank_idx` still MATCHES the query it exists for.
 *
 * `hotPathIndexes.test.ts` asserts the index exists and is spelled as declared.
 * That is not enough for this one, and the gap is the whole reason this file
 * exists: Postgres uses an expression index only when the query's `ORDER BY`
 * parses to the same expression the index stores. Retune a weight in
 * `MtnConfig.ranking.engagement` and the query starts asking for a different
 * composite — the index is still there, still valid, still exactly as its
 * catalogue entry describes, and no longer usable. Nothing errors. No row
 * changes. The popular scan quietly goes back to reading the whole table, which
 * is the 17.25s production request the index was added to remove.
 *
 * So the check that matters is not "does the index exist" but "does the planner
 * still CHOOSE it", and the only way to know that is to run the real query and
 * read the plan back. Both assertions below are needed and neither implies the
 * other:
 *
 *   1. the plan for the shipped query names this index — the property that
 *      actually pays, stated as an observation rather than an argument;
 *   2. the ordering the planner satisfied is the one `engagementScoreSql`
 *      renders — so a future formulation that happens to hit the index by a
 *      route that does NOT preserve the composite (a bitmap scan, say, which
 *      returns rows in physical order) cannot pass while ranking is wrong.
 *
 * The query is built from `engagementScoreSql` and `MtnConfig` rather than
 * pasted, because a pasted expression would keep agreeing with a pasted index
 * after both had drifted from the config the feed actually ranks by.
 *
 * SEQUENTIAL SCANS ARE DISABLED FOR THE PLAN, and that is what makes this
 * portable rather than what makes it lenient. A CI database holds a handful of
 * posts, and over a handful of rows reading the table and sorting it really is
 * cheaper than any index — so the planner declines, correctly, and the test
 * failed on an empty database while passing on a seeded one. What is under test
 * is whether the ORDER BY is index-SATISFIABLE, which is a property of the two
 * expressions and not of the row count. With the sequential scan taken away, an
 * index that does not match still cannot satisfy the ordering: the plan comes
 * back with a `Sort` node over an index scan, and the assertion below still
 * fails. Disabling the sort too would be the lenient version, and is not done.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { engagementScoreSql } from '../../mtn/feed/engine/sources/discoverySources';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';

const scope = postScope('engagement-rank-index');

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await clearPostScope(scope);
  await closePostgres();
});

beforeEach(async () => {
  await clearPostScope(scope);
});

/**
 * The popular scan's statement, exactly as `runPopular` orders it: the composite,
 * then `created_at`, then `id`. `explain` is asked for the PLAN only — no
 * `analyze` — because what is being read is the planner's choice, and executing
 * it would make this file's runtime depend on how many rows other suites left in
 * the table.
 */
async function popularScanPlan(): Promise<string> {
  const engagementScore = engagementScoreSql();
  const query = getDb()
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.visibility, 'public'), eq(posts.status, 'published')))
    .orderBy(
      sql`${engagementScore} desc`,
      sql`${posts.createdAt} desc nulls last`,
      sql`${posts.id} desc nulls last`,
    )
    .limit(60);

  // `EXPLAIN` takes no bind parameters, so the builder's `$n` placeholders are
  // inlined here. Quoting is done rather than assumed: an unquoted substitution
  // turns `visibility = $1` into `visibility = public`, which Postgres reads as a
  // COLUMN and rejects. Test-only, over values this file supplies.
  const { sql: text, params } = query.toSQL();
  const inlined = text.replace(/\$(\d+)/g, (_match, index: string) => {
    const value = params[Number(index) - 1];
    return typeof value === 'number'
      ? String(value)
      : `'${String(value).replace(/'/g, "''")}'`;
  });
  // `SET LOCAL` inside a transaction, so the setting cannot outlive this plan and
  // reach another suite through the pooled connection.
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    const rows = await tx.execute<Record<string, string>>(sql.raw(`explain ${inlined}`));
    return rows.map((row) => Object.values(row)[0]).join('\n');
  });
}

describe('posts_engagement_rank_idx', () => {
  it('is the index the popular scan plans onto', async () => {
    // A row so the table is never empty for the planner; the assertion is about
    // the plan, not the result. See the file comment for why the plan is taken
    // with sequential scans disabled.
    await seedPost(scope, { oxyUserId: scope.user('author') });

    const plan = await popularScanPlan();

    expect(plan).toContain('posts_engagement_rank_idx');
    // An INDEX SCAN, specifically. A bitmap scan over the same index would name
    // it here while returning rows in physical order, leaving the sort in the
    // plan and the whole candidate set read — the cost this index removes.
    expect(plan).toMatch(/Index Scan using posts_engagement_rank_idx/);
    expect(plan).not.toMatch(/\bSort\b/);
  });

  it('stores the expression the feed actually ranks by', async () => {
    /**
     * The negative control for the assertion above, and the one that catches a
     * retuned weight.
     *
     * `pg_get_indexdef` renders the STORED expression; `engagementScoreSql`
     * renders what the query asks for. Comparing them directly is not possible —
     * Postgres normalises casts and parenthesisation — so this compares the one
     * thing that survives normalisation on both sides and cannot survive a weight
     * change: the four weights, in order.
     */
    const [{ def }] = await getDb().execute<{ def: string }>(
      sql`select pg_get_indexdef('posts_engagement_rank_idx'::regclass) as def`,
    );

    const queryWeights = getDb()
      .select({ score: engagementScoreSql() })
      .from(posts)
      .toSQL()
      .sql.match(/([\d.]+)::double precision/g);

    expect(queryWeights).not.toBeNull();
    for (const weight of queryWeights ?? []) {
      const literal = weight.replace('::double precision', '');
      expect(def).toContain(`(${literal})::double precision`);
    }
  });
});
