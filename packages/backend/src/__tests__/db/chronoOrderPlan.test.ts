/**
 * The two shared chronological orders can actually be served by an index.
 *
 * `chronoOrderBy()` (the feed engine) and `CHRONO_DESC` (the repository) are the
 * sort behind roughly forty call sites, and both are paired with the
 * `created_at DESC, id DESC` indexes on `posts`. Whether an index can SERVE that
 * sort turns on something invisible in the result: Postgres matches an index to
 * an ORDER BY on the NULLS placement as well as the direction, drizzle emits
 * `.desc()` in index DDL as `DESC NULLS LAST`, and a plain `desc()` in a query
 * means `DESC NULLS FIRST`. Written the plain way, none of the thirteen
 * chronological indexes on `posts` is usable and the planner scans the match set
 * and sorts it — returning byte-identical rows either way.
 *
 * Measured on this schema at 20,000 posts, page of 31, before the fix:
 *
 *   following timeline (200 authors)  Hash Semi Join over TWO seq scans + Sort,
 *                                     cost 2788.92 → Index Scan + Nested Loop
 *                                     Semi Join touching 32 rows, cost 474.33
 *   chronological scan, no authorship Seq Scan + Sort, cost 1636.42 / 16.536 ms
 *                                     → Index Scan, cost 4.16 / 0.110 ms
 *
 * So the assertion is the PLAN, because nothing else distinguishes them.
 *
 * Deliberately NOT asserted here: that the author/profile feed improves. It does
 * not, and pretending otherwise would be the more expensive mistake. That feed
 * matches through a correlated `EXISTS` on `post_authorships`, so its plan is a
 * Nested Loop from the authorship index into `posts_pkey` with no chronological
 * index involved — measured identical (cost 903.53) with either spelling.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { CHRONO_DESC } from '../../db/posts/postRepository';
import { chronoOrderBy } from '../../mtn/feed/CursorBuilder';

let db: Database;

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/** One node of `EXPLAIN (FORMAT JSON)`, as much of it as this file reads. */
interface PlanNode {
  'Node Type': string;
  Plans?: PlanNode[];
}

/**
 * Every node type in the plan for one page of public published posts under
 * `order`.
 *
 * ## Why FORMAT JSON and an exact node type, not a substring
 *
 * The first version of this grepped the text plan for `Sort`, and it was flaky
 * in a way worth keeping written down: it passed alone and failed in the full
 * parallel run, because the other files sharing this database change `posts`'
 * statistics and the planner then chose the single-column
 * `posts_created_at_idx` over the composite `post_public_chrono_v1`. That plan
 * is an **Incremental Sort** with `Presorted Key: created_at` — it streams and
 * never sorts more than one tie group, so it is a GOOD plan, and the substring
 * `Sort` is in its name. A check that fails on a correct plan is worse than no
 * check: it is the one whoever hits it next will delete.
 *
 * The property that actually matters is that no FULL `Sort` node appears — that
 * node is the one that materialises the whole match set before the LIMIT can
 * cut it, and it is what the wrong NULLS placement forces. `Node Type` is an
 * exact string in the JSON plan, so `Sort` and `Incremental Sort` are
 * distinguishable without guessing at the text layout.
 *
 * ## Why the scan types are disabled
 *
 * Sequential and bitmap scans are OFF for the duration of the transaction, and
 * that is what makes this a measure of the INDEX rather than of how many rows
 * the shared database happens to hold. A bitmap scan reads an index but returns
 * rows in heap order, so it always needs a Sort; left on, the planner picks it
 * on a small table whatever the index can do, and the assertion fails for the
 * right and the wrong ORDER BY alike. With both off, an ordered index scan is
 * the only path left and the one remaining question is whether the index can
 * satisfy the ORDER BY.
 *
 * `SET LOCAL` confines both settings to this transaction, so the files running
 * in parallel against this database are unaffected.
 */
async function planNodeTypes(order: readonly ReturnType<typeof sql>[]): Promise<string[]> {
  const plan = await db.transaction(async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    await tx.execute(sql`set local enable_bitmapscan = off`);
    const rows = await tx.execute<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(sql`
      explain (format json) select ${posts.id} from ${posts}
      where ${eq(posts.visibility, 'public')} and ${eq(posts.status, 'published')}
      order by ${sql.join([...order], sql`, `)}
      limit 31
    `);
    const [first] = [...rows];
    return first['QUERY PLAN'][0].Plan;
  });

  const types: string[] = [];
  const walk = (node: PlanNode): void => {
    types.push(node['Node Type']);
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(plan);
  return types;
}

describe('the shared chronological orders are index-servable', () => {
  it('plans a page under chronoOrderBy() with no full Sort node', async () => {
    expect(await planNodeTypes(chronoOrderBy())).not.toContain('Sort');
  });

  it('plans a page under CHRONO_DESC with no full Sort node', async () => {
    expect(await planNodeTypes(CHRONO_DESC)).not.toContain('Sort');
  });

  it('still shows a Sort for the spelling that cannot use the index', async () => {
    /**
     * The counterpart that keeps the two above from passing vacuously. If
     * `enable_seqscan`/`enable_bitmapscan` stopped doing their job, or if
     * Postgres started ignoring the NULLS placement when matching pathkeys,
     * everything would come back Sort-free and the assertions would stop
     * distinguishing anything. This pins the negative case, so the pair is a
     * real discriminator rather than a check that always passes.
     */
    const types = await planNodeTypes([
      sql`${posts.createdAt} desc nulls first`,
      sql`${posts.id} desc nulls first`,
    ]);
    expect(types).toContain('Sort');
  });

  it('plans the ascending branch with no Sort either, via a backward scan', async () => {
    /**
     * This case is here because the obvious reasoning about it is WRONG, and it
     * was written down as a comment before this test refuted it: `asc()` already
     * means NULLS LAST, so the ascending branch looked like it needed no
     * spelling. But the two orders an index can serve are its declared one and
     * its EXACT REVERSE, and the reverse of `DESC NULLS LAST` is `ASC NULLS
     * FIRST` — so `asc()` matched neither and planned a full Sort (cost 2139.83
     * over 20,000 rows, against 0.41 for the Index Only Scan Backward).
     */
    expect(await planNodeTypes(chronoOrderBy('asc'))).not.toContain('Sort');
  });
});
