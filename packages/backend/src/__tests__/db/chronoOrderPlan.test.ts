/**
 * The shared chronological orders are spelled so an index can serve them.
 *
 * `chronoOrderBy()` (the feed engine) and `CHRONO_DESC` (the repository) are the
 * sort behind roughly forty call sites. Whether an index can SERVE that sort
 * turns on something invisible in the result: Postgres matches an index to an
 * ORDER BY on the NULLS placement as well as the direction, and it will use an
 * index in its declared order or its EXACT REVERSE. Drizzle emits `.desc()` in
 * index DDL as `DESC NULLS LAST`, while in a QUERY `desc()` means `DESC NULLS
 * FIRST` and `asc()` means `ASC NULLS LAST` — so both of drizzle's query-side
 * defaults miss, and the rows come back identical either way.
 *
 * Measured on this schema at 20,000 posts, page of 31, before the fix:
 *
 *   following timeline (200 authors)  Hash Semi Join over TWO seq scans + Sort,
 *                                     cost 2788.92 → Index Scan + Nested Loop
 *                                     Semi Join touching 32 rows, cost 474.33
 *   chrono scan, no authorship join   Seq Scan + Sort, cost 1636.42 / 16.536 ms
 *                                     → Index Scan, cost 4.16 / 0.110 ms
 *   replies list, oldest-first        Sort of 20,000, cost 2139.83 → Index Only
 *                                     Scan BACKWARD, cost 0.41
 *
 * ## Why this does NOT EXPLAIN a query against `posts`
 *
 * It did, and that version was flaky — mine, caught here rather than by somebody
 * else, which is the only good thing about it. Asserting a plan over `posts`
 * asserts the planner's CHOICE among a dozen candidate indexes, and that choice
 * moves with statistics every other test file writing a post changes. Measured:
 * two failures in eight full-suite runs, plan `Limit → Sort → Index Only Scan` —
 * the planner had picked an index that cannot supply the order, which says
 * nothing whatever about `chronoOrderBy`.
 *
 * A gate that fails on a correct implementation is worse than no gate; it is the
 * one whoever hits it next deletes, taking the real assertion with it. So the
 * property is split into the two deterministic halves it was always made of:
 *
 *   1. the CODE's spelling equals the real indexes' DECLARED spelling — read out
 *      of `pg_indexes`, so it is the migration's own DDL rather than the schema
 *      file restating itself;
 *   2. that equality is what lets Postgres use an index at all — measured on a
 *      TEMP table with exactly one index, where the planner has no choice to make
 *      and the answer cannot depend on anybody else's rows.
 *
 * The temp table is `on commit drop` inside one transaction: invisible to the
 * files running in parallel, and it takes no lock on any shared object — unlike
 * a fixture table with a foreign key into `posts`, which takes SHARE ROW
 * EXCLUSIVE on it and has already turned unrelated files red.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

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

/** The ORDER BY text a shared order constant renders to, lowercased. */
function renderedOrder(order: readonly ReturnType<typeof sql>[]): string {
  return db
    .select({ id: posts.id })
    .from(posts)
    .orderBy(...order)
    .toSQL()
    .sql.toLowerCase()
    .split('order by')[1]
    .trim();
}

/** Every `posts` index whose DDL orders on `created_at` descending. */
async function descendingChronoIndexes(): Promise<{ name: string; def: string }[]> {
  const rows = await db.execute<{ indexname: string; indexdef: string }>(sql`
    select indexname, indexdef from pg_indexes
    where tablename = 'posts' and indexdef ilike '%created_at desc%'
    order by indexname
  `);
  return [...rows].map((row) => ({ name: row.indexname, def: row.indexdef.toLowerCase() }));
}

describe('the code spells its order the way the indexes declare theirs', () => {
  it('finds the chronological indexes at all', async () => {
    /**
     * The vacuity floor. Every assertion below iterates that list, and an empty
     * one satisfies all of them — a renamed table or a `pg_indexes` predicate
     * that stopped matching would leave this file green while checking nothing.
     */
    const indexes = await descendingChronoIndexes();
    expect(indexes.length).toBeGreaterThanOrEqual(10);
  });

  it('declares every descending chronological index NULLS LAST', async () => {
    // This is the fact the query-side spelling has to match. An index added later
    // as `DESC NULLS FIRST` would stop fitting the shared order, and this says so
    // at the index rather than as a slow feed nobody attributes to it.
    for (const index of await descendingChronoIndexes()) {
      expect(index.def, index.name).toContain('created_at desc nulls last');
    }
  });

  it('renders both shared descending orders as `desc nulls last`', () => {
    expect(renderedOrder(chronoOrderBy())).toBe(
      '"posts"."created_at" desc nulls last, "posts"."id" desc nulls last',
    );
    expect(renderedOrder(CHRONO_DESC)).toBe(
      '"posts"."created_at" desc nulls last, "posts"."id" desc nulls last',
    );
  });

  it('renders the ascending order as `asc nulls first`, the index read backwards', () => {
    /**
     * The case whose obvious reasoning is WRONG, and which was written into a
     * comment as "needs no spelling" before it was measured: `asc()` already
     * means NULLS LAST, which is true and irrelevant. An index is readable in its
     * declared order or its exact REVERSE, and the reverse of `DESC NULLS LAST`
     * is `ASC NULLS FIRST` — so `asc()` matches neither end.
     */
    expect(renderedOrder(chronoOrderBy('asc'))).toBe(
      '"posts"."created_at" asc nulls first, "posts"."id" asc nulls first',
    );
  });

  it("differs from drizzle's own defaults, which is the entire reason this exists", () => {
    /**
     * The negative control. If drizzle ever changed `desc()` to mean NULLS LAST,
     * every assertion above would still pass while the hazard they guard had
     * ceased to exist, and the explicit spellings would be noise rather than a
     * fix. This is what would notice.
     */
    const defaults = renderedOrder([sql`${posts.createdAt} desc`, sql`${posts.id} asc`]);
    expect(defaults).not.toContain('nulls');
  });
});

/** One node of `EXPLAIN (FORMAT JSON)`, as much of it as this file reads. */
interface PlanNode {
  'Node Type': string;
  Plans?: PlanNode[];
}

describe('the spelling is what makes an index usable — measured, not assumed', () => {
  /**
   * Plan `order` against a private table carrying ONE index shaped like the
   * chronological indexes on `posts`.
   *
   * `on commit drop` inside a single transaction: no other connection can see it,
   * nothing else can be waiting on it, and with exactly one index the planner has
   * no choice left to make — so the answer is about the ORDER BY rather than
   * about how many rows the shared corpus happens to hold today.
   */
  async function planNodeTypes(order: string): Promise<string[]> {
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`
        create temp table chrono_probe (
          id text primary key,
          created_at timestamptz not null
        ) on commit drop
      `);
      await tx.execute(sql`
        create index chrono_probe_idx
          on chrono_probe (created_at desc nulls last, id desc nulls last)
      `);
      await tx.execute(sql`
        insert into chrono_probe
        select lpad(g::text, 24, '0'), now() - (g || ' seconds')::interval
        from generate_series(1, 2000) g
      `);
      await tx.execute(sql`analyze chrono_probe`);
      const rows = await tx.execute<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
        sql`explain (format json) select id from chrono_probe order by ${sql.raw(order)} limit 31`,
      );
      return [...rows][0]['QUERY PLAN'][0].Plan;
    });

    const types: string[] = [];
    const walk = (node: PlanNode): void => {
      types.push(node['Node Type']);
      for (const child of node.Plans ?? []) walk(child);
    };
    walk(plan);
    return types;
  }

  it('serves the declared order with no Sort', async () => {
    expect(await planNodeTypes('created_at desc nulls last, id desc nulls last')).not.toContain('Sort');
  });

  it('serves the exact reverse with no Sort, by reading the index backwards', async () => {
    expect(await planNodeTypes('created_at asc nulls first, id asc nulls first')).not.toContain('Sort');
  });

  it("sorts for drizzle's `desc()` spelling, which is NULLS FIRST", async () => {
    expect(await planNodeTypes('created_at desc nulls first, id desc nulls first')).toContain('Sort');
  });

  it("sorts for drizzle's `asc()` spelling, which is NULLS LAST", async () => {
    // The half that reads as safe and is not: the reverse of NULLS LAST is NULLS
    // FIRST, so an ascending query spelled the default way matches neither end.
    expect(await planNodeTypes('created_at asc nulls last, id asc nulls last')).toContain('Sort');
  });
});
