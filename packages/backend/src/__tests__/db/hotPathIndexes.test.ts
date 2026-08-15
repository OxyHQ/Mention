/**
 * The named indexes a measured hot path depends on still exist, spelled the way
 * the query that reads them is spelled.
 *
 * ## Why an index needs a test of its own
 *
 * An index is the one thing a functional test can never detect the absence of.
 * Drop `post_authorships_author_chrono_idx` and every profile-feed test in this
 * repository still passes: the same rows come back in the same order, and the
 * only difference is that the planner walks a chronological index over the whole
 * of `posts` probing `post_authorships` per candidate row — 84–99 ms and 42,394
 * probes for a page of 21 on an ordinary account, versus under a millisecond
 * (measured on 624k posts; `drizzle/0021_faithful_bloodstrike.sql` carries the
 * numbers). Nothing errors, nothing is wrong, the feed is just slow, and nobody
 * attributes it to the index that went missing three months earlier.
 *
 * Two realistic ways one goes missing, neither of them a deletion anybody
 * reviewed as such:
 *
 *   * a GENERATED column's expression changes, and `drizzle-kit generate` emits
 *     `DROP COLUMN` + `ADD COLUMN` — which takes every index over that column
 *     with it and re-emits none of them;
 *   * an index is regenerated with drizzle's query-side default spelling, so it
 *     declares `DESC NULLS FIRST`. It exists, it is the right columns, and
 *     Postgres will not use it for the order the code asks for. That is the
 *     failure `chronoOrderPlan.test.ts` exists for, and this file is the half of
 *     it that names the index rather than iterating whatever happens to match.
 *
 * ## Why the whole `indexdef`, and why by NAME
 *
 * The definition, because "an index called X exists" is satisfied by an index on
 * the wrong columns in the wrong order with the wrong NULLS placement — which is
 * exactly the second failure above. By name, because
 * `chronoOrderPlan.test.ts` asserts a PROPERTY over every `posts` index matching
 * a pattern (`created_at desc`), and its vacuity floor is a count: an index that
 * disappears leaves that loop iterating nine instead of ten and green either
 * way. A property over a set and the membership of that set are two claims.
 *
 * ## What this file deliberately does not do
 *
 * It runs no `EXPLAIN`. Asserting a plan over `posts` asserts the planner's
 * CHOICE among a dozen candidate indexes, which moves with the statistics every
 * other file in a parallel run changes — `chronoOrderPlan.test.ts` shipped that
 * and it was flaky twice in eight runs. The property here is what the DDL
 * DECLARES; that the declaration is what makes an index usable is measured next
 * door, on a private single-index temp table where the planner has no choice.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';

/**
 * One index this repository has measured a hot path against, its exact
 * definition, and the path that pays when it is gone.
 *
 * The definition is the `pg_indexes.indexdef` a migrated database reports, minus
 * nothing — schema qualification and `USING btree` included, because a change to
 * either is a change worth reading.
 */
interface HotPathIndex {
  name: string;
  table: string;
  /** What breaks — slowly, silently — if this index stops existing. */
  serves: string;
  definition: string;
}

const HOT_PATH_INDEXES: readonly HotPathIndex[] = [
  {
    name: 'post_authorships_author_chrono_idx',
    table: 'post_authorships',
    serves:
      "the profile feed's authorship branch (`fetchAuthored`, mtn/feed/engine/sources/userSources.ts) — " +
      'author, accepted, newest first, in one index, which is why `post_created_at` is copied onto this table at all',
    definition:
      'CREATE INDEX post_authorships_author_chrono_idx ON public.post_authorships ' +
      'USING btree (oxy_user_id, status, post_created_at DESC NULLS LAST, post_id DESC NULLS LAST)',
  },
  {
    name: 'posts_owner_chrono_idx',
    table: 'posts',
    serves:
      "the profile feed's owner branch (`fetchAuthored`) — the denormalized owner reached chronologically, " +
      'the cheaper of the two routes the `union` merges',
    definition:
      'CREATE INDEX posts_owner_chrono_idx ON public.posts ' +
      'USING btree (oxy_user_id, visibility, status, created_at DESC NULLS LAST, id DESC NULLS LAST)',
  },
  {
    name: 'post_links_chrono_v1',
    table: 'posts',
    serves:
      'search `has:links` (routes/search.ts) — the only query this index exists for, and the one that ' +
      'made it 99 MB of pure write amplification for as long as the query was spelled `desc()`',
    definition:
      'CREATE INDEX post_links_chrono_v1 ON public.posts ' +
      'USING btree (has_links, visibility, status, created_at DESC NULLS LAST, id DESC NULLS LAST)',
  },
  {
    name: 'post_public_chrono_v1',
    table: 'posts',
    serves: 'every public chronological scan — the feed engine\'s `fetchChrono` and post search',
    definition:
      'CREATE INDEX post_public_chrono_v1 ON public.posts ' +
      'USING btree (visibility, status, created_at DESC NULLS LAST, id DESC NULLS LAST)',
  },
  {
    name: 'post_replies_chrono_v1',
    table: 'posts',
    serves: 'a post\'s replies, oldest- or newest-first (the index is read backwards for ascending)',
    definition:
      'CREATE INDEX post_replies_chrono_v1 ON public.posts ' +
      'USING btree (parent_post_id, visibility, status, created_at DESC NULLS LAST, id DESC NULLS LAST)',
  },
];

let db: Database;

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/** `pg_indexes.indexdef` for `name`, or null when no such index exists. */
async function indexDefinition(name: string): Promise<string | null> {
  const rows = await db.execute<{ indexdef: string }>(
    sql`select indexdef from pg_indexes where schemaname = 'public' and indexname = ${name}`
  );
  return [...rows][0]?.indexdef ?? null;
}

describe('the indexes the measured hot paths are built on', () => {
  it('can read index definitions at all — the vacuity floor', async () => {
    /**
     * Every assertion below compares against a value read out of `pg_indexes`,
     * and a query that matched nothing would report every index missing — which
     * is a legible failure — but a query that matched nothing while the SET was
     * also empty is how a renamed catalogue view reads. So: the tables carry
     * indexes, plainly, before any of them is named.
     */
    const rows = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_indexes
      where schemaname = 'public' and tablename in ('posts', 'post_authorships')
    `);
    expect([...rows][0]?.n ?? 0).toBeGreaterThanOrEqual(20);
  });

  it('reports an index that does not exist as absent — the negative control', async () => {
    // Without this, "the definition matched" is the only outcome the helper has
    // ever been observed to produce, and a helper that returned a definition for
    // every name would satisfy the whole file.
    await expect(indexDefinition('post_authorships_no_such_index')).resolves.toBeNull();
  });

  it.each(HOT_PATH_INDEXES)('$name exists, on $table', async ({ name, table }) => {
    const definition = await indexDefinition(name);
    expect(definition, `${name} is missing — it serves ${
      HOT_PATH_INDEXES.find((index) => index.name === name)?.serves
    }`).not.toBeNull();
    expect(definition).toContain(`ON public.${table} `);
  });

  it.each(HOT_PATH_INDEXES)('$name is declared exactly as the query reads it', async ({ name, definition }) => {
    /**
     * The NULLS placement is the load-bearing half and the one with no symptom.
     * Postgres matches an index to an ORDER BY on the NULLS placement as well as
     * the direction, so an index regenerated with drizzle's query-side default
     * (`DESC NULLS FIRST`) is present, correct, and unusable by the order every
     * one of these paths asks for.
     */
    await expect(indexDefinition(name)).resolves.toBe(definition);
  });
});
