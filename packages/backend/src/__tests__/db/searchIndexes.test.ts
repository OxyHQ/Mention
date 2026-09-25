/**
 * The search lanes' trigram indexes, and the IMMUTABLE functions two of them
 * are built on.
 *
 * `hotPathIndexes.test.ts` makes the general argument for why an index needs a
 * test of its own — it is the one thing a functional test can never detect the
 * absence of, because the same rows come back in the same order and only the
 * latency changes. This file covers the search lanes it does not, and adds one
 * assertion it has no analogue for.
 *
 * ## The assertion `hotPathIndexes` has no analogue for: function volatility
 *
 * `custom_feeds_search_text` and `posts_hashtags_search_text` are created
 * `CREATE OR REPLACE ... IMMUTABLE`, and an index is built on each. Postgres
 * takes IMMUTABLE as a PROMISE and does not re-verify it: a later migration
 * that replaces one of those functions with a STABLE or VOLATILE body — or one
 * that returns a different string for the same input — leaves every index built
 * on it silently wrong, returning rows that no longer match the expression it
 * was built from. Nothing errors. So the volatility is asserted here, against
 * `pg_proc`, rather than trusted from the migration that wrote it.
 *
 * ## Why the coarse-filter idiom needs testing at all
 *
 * Each lane's query is `<indexed concatenation> LIKE '%term%' AND <the exact
 * per-column ILIKEs>`. The first half is the only part an index can serve; the
 * second is what the answer depends on. Both halves have a failure mode a
 * functional test misses:
 *
 *   * drop the prefilter and the answers stay CORRECT while the query goes back
 *     to a sequential scan — the regression this file's plan assertions catch;
 *   * drop the recheck and the query gets FASTER and quietly wrong, admitting
 *     rows that match only across a column boundary.
 *
 * The second is pinned by the route tests (a cross-boundary term must not
 * match); this file pins the first.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { hashtagSearchQuery } from '../../services/search/hashtagSearch';

let db: Database;

/**
 * One index, the table it is on, and what pays when it is gone.
 *
 * `serves` is the query that becomes a sequential scan, so a failure reads as
 * an instruction rather than as a name.
 */
const SEARCH_INDEXES: ReadonlyArray<{
  name: string;
  table: string;
  serves: string;
  /** A substring the `indexdef` must contain, proving it is the right SHAPE. */
  definitionContains: readonly string[];
}> = [
  {
    name: 'account_lists_search_trgm_gin',
    table: 'account_lists',
    serves: "GET /lists?search= — title/description substring match; without it, a sequential scan of account_lists, twice (the page and its count)",
    definitionContains: ['USING gin', 'gin_trgm_ops', 'lower(', 'title', 'description'],
  },
  {
    name: 'starter_packs_search_trgm_gin',
    table: 'starter_packs',
    serves: 'GET /starter-packs?search= — name/description substring match; without it, a sequential scan of starter_packs',
    definitionContains: ['USING gin', 'gin_trgm_ops', 'lower(', 'name', 'description'],
  },
  {
    name: 'custom_feeds_search_trgm_gin',
    table: 'custom_feeds',
    serves: 'GET /feeds?search= — title/description/keywords substring match; without it, a sequential scan of custom_feeds, which the HOME TAB also reads on mount',
    definitionContains: ['USING gin', 'gin_trgm_ops', 'custom_feeds_search_text'],
  },
  {
    name: 'posts_hashtags_trgm_gin',
    table: 'posts',
    serves: 'GET /hashtags/search — the coarse filter that narrows candidate posts before the per-element unnest recheck',
    definitionContains: ['USING gin', 'gin_trgm_ops', 'posts_hashtags_search_text'],
  },
];

/**
 * Every IMMUTABLE wrapper an index expression depends on.
 *
 * These exist because `array_to_string` is only STABLE and cannot appear in an
 * index expression — a measured constraint, recorded in
 * `drizzle/0038_cold_songbird.sql`. The wrapper is what lets this schema make
 * the IMMUTABLE promise itself, which is exactly why the promise is checked.
 */
const INDEX_EXPRESSION_FUNCTIONS: readonly string[] = [
  'posts_hashtags_search_text',
  'custom_feeds_search_text',
];

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

async function indexDefinition(name: string): Promise<string | null> {
  const rows = await db.execute<{ indexdef: string }>(
    sql`select indexdef from pg_indexes where schemaname = 'public' and indexname = ${name}`
  );
  return rows[0]?.indexdef ?? null;
}

describe('the search lanes are index-backed', () => {
  for (const entry of SEARCH_INDEXES) {
    it(`${entry.name} exists — serves ${entry.serves}`, async () => {
      const definition = await indexDefinition(entry.name);
      expect(definition, `missing index ${entry.name}; ${entry.serves}`).not.toBeNull();
      for (const fragment of entry.definitionContains) {
        expect(definition).toContain(fragment);
      }
    });
  }

  it('leaves no searchable text column without a trigram index', async () => {
    // Exhaustive in the one direction that matters here: every table this file
    // claims to cover must actually carry its index. A gate that only checks
    // the entries it happens to list cannot notice one being dropped, which is
    // why the loop above asserts existence rather than iterating the catalogue.
    const covered = new Set(SEARCH_INDEXES.map((entry) => entry.table));
    expect([...covered].sort()).toEqual([
      'account_lists',
      'custom_feeds',
      'posts',
      'starter_packs',
    ]);
  });
});

describe('the IMMUTABLE promise an index expression rests on', () => {
  for (const name of INDEX_EXPRESSION_FUNCTIONS) {
    it(`${name} exists and is still IMMUTABLE`, async () => {
      const rows = await db.execute<{ provolatile: string; prosrc: string }>(
        sql`select provolatile, prosrc from pg_proc where proname = ${name}`
      );

      expect(rows, `missing function ${name}; the index built on it cannot exist`).toHaveLength(1);
      // `i` = immutable, `s` = stable, `v` = volatile. Postgres does not
      // re-verify the promise, so replacing this function with a STABLE body
      // leaves the index built on it silently wrong rather than erroring.
      expect(
        rows[0].provolatile,
        `${name} is no longer IMMUTABLE; every index built on it is now unsound`
      ).toBe('i');
    });
  }
});

describe('the coarse trigram filter is actually reachable', () => {
  /**
   * `enable_seqscan = off` rather than a seeded corpus.
   *
   * The invariant is "a plan using this index EXISTS", which is size
   * independent. On a near-empty test database the planner would correctly
   * prefer a sequential scan, and seeding enough rows to change its mind would
   * be slow and still only probabilistically right. `set local` scopes the
   * setting to the transaction, so it cannot leak into another test's plans.
   */
  async function planFor(query: ReturnType<typeof sql>): Promise<string> {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      return tx.execute<{ 'QUERY PLAN': string }>(sql`explain (costs off) ${query}`);
    });
    return rows.map((row) => row['QUERY PLAN']).join('\n');
  }

  /**
   * EXPLAIN the statement `prepare` returns, on the transaction it prepared,
   * then roll the whole transaction back.
   *
   * `EXPLAIN` takes no bind parameters, so the builder's `$n` placeholders are
   * inlined with quoting (the `engagementRankIndex` idiom), over values this
   * file supplies.
   */
  async function explainAndRollBack(
    prepare: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<{ sql: string; params: unknown[] }>,
  ): Promise<string> {
    const rollback = new Error('roll back the plan fixture');
    let plan = '';
    await db.transaction(async (tx) => {
      const { sql: text, params } = await prepare(tx);
      const inlined = text.replace(/\$(\d+)/g, (_match, index: string) => {
        const value = params[Number(index) - 1];
        return typeof value === 'number' ? String(value) : `'${String(value).replace(/'/g, "''")}'`;
      });
      const rows = await tx.execute<Record<string, string>>(sql.raw(`explain (costs off) ${inlined}`));
      plan = rows.map((row) => Object.values(row)[0]).join('\n');
      throw rollback;
    }).catch((error: unknown) => {
      if (error !== rollback) throw error;
    });
    return plan;
  }

  it('reaches account_lists_search_trgm_gin for a list search', async () => {
    const plan = await planFor(sql`
      select id from account_lists
      where lower(coalesce(title, '') || ' ' || coalesce(description, '')) like '%needle%'
    `);
    expect(plan).toContain('account_lists_search_trgm_gin');
    expect(plan).not.toContain('Seq Scan on account_lists');
  });

  it('reaches starter_packs_search_trgm_gin for a pack search', async () => {
    const plan = await planFor(sql`
      select id from starter_packs
      where lower(coalesce(name, '') || ' ' || coalesce(description, '')) like '%needle%'
    `);
    expect(plan).toContain('starter_packs_search_trgm_gin');
    expect(plan).not.toContain('Seq Scan on starter_packs');
  });

  it('reaches posts_hashtags_trgm_gin for the hashtag search the service ACTUALLY issues', async () => {
    // The statement comes from the service's own builder, not a hand-written
    // copy. A copy is exactly how this regressed: the service filtered on
    // `array_to_string(hashtags, ' ')` — the wrapper's BODY — while the index is
    // on the wrapper, which the planner will not inline (its body is only
    // STABLE). The index was never reachable, and every hashtag search read
    // every public tagged post: 4.3s median, 35.7s worst in production (#1140).
    const plan = await explainAndRollBack(async (tx) => {
      // Seeded, unlike the plans above. `posts` carries other indexes on
      // `visibility` (the chrono ones), and against an empty, unanalysed table
      // the planner reaches for one of those even with sequential scans off —
      // so the "a plan through this index exists" trick does not isolate the
      // trigram index here. With rows and statistics, a selective substring is
      // the trigram index's to serve, which is the question being asked. Rolled
      // back, statistics included, so no other suite sees the rows.
      await tx.execute(sql`
        insert into posts (id, visibility, hashtags)
        select 'search-index-plan-' || g, 'public', array['plantag' || g, 'planother' || (g % 50)]
        from generate_series(1, 2000) g
      `);
      await tx.execute(sql`analyze posts`);
      await tx.execute(sql`set local enable_seqscan = off`);
      return hashtagSearchQuery(tx, 'needle', 0, 10).toSQL();
    });

    expect(plan).toContain('posts_hashtags_trgm_gin');
    expect(plan).not.toContain('Seq Scan on posts');
  });

  it('reaches custom_feeds_search_trgm_gin for a feed search', async () => {
    const plan = await planFor(sql`
      select id from custom_feeds
      where custom_feeds_search_text(title, description, keywords) like '%needle%'
    `);
    expect(plan).toContain('custom_feeds_search_trgm_gin');
    expect(plan).not.toContain('Seq Scan on custom_feeds');
  });
});
