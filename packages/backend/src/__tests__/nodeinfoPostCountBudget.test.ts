/**
 * `GET /nodeinfo/2.0`'s post count is never one sequential scan per crawler.
 *
 * The endpoint is public, unauthenticated, and advertised through
 * `/.well-known/nodeinfo` — it exists so other fediverse instances discover this
 * one, so being polled by strangers is its PURPOSE, not an abuse case. It
 * reports `localPosts` over `posts`, the one table in the schema that only ever
 * grows, and no index can answer a full count.
 *
 * An exact `count(*)` cached for five minutes was still a scan of the whole
 * table every time the entry lapsed: ~3.8 s and ~70k buffers in production,
 * ~70 times a day (#1160). The value is now the planner's own row estimate,
 * `pg_class.reltuples`, served stale-while-revalidate for an hour, and an exact
 * count is paid for only on a table that has never been analyzed.
 *
 * ## What is asserted, and what this environment can prove
 *
 * `__tests__/setup.ts` mocks Redis with `isReady: false`, so the Redis half of
 * the cache always misses here and a test of "the second request reads Redis"
 * would measure the mock rather than the cache. What does NOT depend on Redis is
 * `getOrCompute`'s per-PROCESS single-flight, and the estimate itself: both are
 * measured here.
 *
 * Measured from `db_query_duration_ms`, the same series production scrapes, not
 * from a spy: a spy on the query builder would keep passing if the count moved
 * to another statement.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../config';
import { closePostgres, connectPostgres } from '../db/postgres';
import { metrics } from '../utils/metrics';
import { inArray, sql } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { nodeinfoStatisticsCached } from '../runtimeApp';
import { posts } from '../db/schema/posts';
import { measureNodeinfoStatistics } from '../services/nodeinfoStatistics';

/** Restored on teardown: the flag is process-global and workers are reused. */
let previousInstrumentationSetting = false;

beforeAll(async () => {
  previousInstrumentationSetting = config.postgres.queryMetricsEnabled;
  // Set BEFORE connecting: the client is patched once, at connect time.
  config.postgres.queryMetricsEnabled = true;
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
  config.postgres.queryMetricsEnabled = previousInstrumentationSetting;
});

beforeEach(() => {
  metrics.reset();
});

/** How many statements the registry recorded against one table. */
async function statementsAgainst(table: string): Promise<number> {
  return metrics
    .getSeries('db_query_duration_ms')
    .filter(({ labels }) => labels.table === table)
    .reduce((total, { count }) => total + count, 0);
}

describe('nodeinfo statistics — scan budget', () => {
  it('never scans posts: planner estimates plus one index-backed count', async () => {
    await getDb().execute(sql`analyze posts`);
    await getDb().execute(sql`analyze federated_actors`);
    metrics.reset();

    const stats = await measureNodeinfoStatistics();

    for (const n of [
      stats.posts.local,
      stats.posts.external,
      stats.posts.combined,
      stats.externalActors,
    ]) {
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }
    expect(stats.posts.local + stats.posts.external).toBe(stats.posts.combined);
    // Exactly one statement on `posts` (the federated count); the estimates are `other`.
    expect(await statementsAgainst('posts')).toBe(1);
    expect(await statementsAgainst('other')).toBe(2);
  });

  it('collapses a burst of concurrent pollers onto one computation', async () => {
    const answers = await Promise.all(Array.from({ length: 12 }, () => nodeinfoStatisticsCached()));
    expect(answers).toHaveLength(12);
    for (const answer of answers) expect(answer).toEqual(answers[0]);
    expect(await statementsAgainst('posts')).toBeLessThanOrEqual(2);
  });

  it('splits local and external posts exactly and never counts a repeated delivery twice', async () => {
    // `posts` is shared with every suite on this database: assert on DELTAS.
    const db = getDb();
    await db.execute(sql`analyze posts`);
    const before = await measureNodeinfoStatistics();
    const external = {
      oxyUserId: 'nodeinfo-ext',
      federationActorUri: 'https://remote.example/users/nodeinfo',
      federationActivityId: 'https://remote.example/nodeinfo/1',
    };
    const inserted = await db
      .insert(posts)
      .values([
        { oxyUserId: 'nodeinfo-a' },
        { oxyUserId: 'nodeinfo-b' },
        { oxyUserId: 'nodeinfo-a' },
        external,
      ])
      .returning({ id: posts.id });
    // The same activity delivered again hits the unique index: still one row.
    await db.insert(posts).values(external).onConflictDoNothing();
    await db.execute(sql`analyze posts`);
    const after = await measureNodeinfoStatistics();
    await db.delete(posts).where(
      inArray(
        posts.id,
        inserted.map((row) => row.id),
      ),
    );

    expect(after.posts.external - before.posts.external).toBe(1);
    expect(after.posts.local - before.posts.local).toBe(3);
    expect(after.posts.combined - before.posts.combined).toBe(4);
  });
});
