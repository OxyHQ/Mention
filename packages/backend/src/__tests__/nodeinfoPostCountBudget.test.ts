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

describe('nodeinfo statistics', () => {
  it('never scans posts: every statement is an index-backed count', async () => {
    const db = getDb();
    await db.execute(sql`analyze posts`);
    await db.execute(sql`analyze federated_actors`);
    metrics.reset();

    const stats = await measureNodeinfoStatistics();

    for (const n of [stats.local.total, stats.external.total, stats.combined.total]) {
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }
    expect(stats.local.total + stats.external.total).toBe(stats.combined.total);
    // Three statements on `posts`: the local GROUP BY and the two external counts.
    expect(await statementsAgainst('posts')).toBe(3);

    // With sequential scans disabled the planner can only use indexes, so a plan
    // that still needs a scan proves no index serves the query. Which index it
    // picks depends on the rows other tests left behind (it may prefer one that
    // returns the grouping column already sorted), so the contract asserted is
    // "an index serves it", not a particular index. (A tiny test table would
    // otherwise legitimately prefer the scan.)
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      for (const query of [
        sql`select is_reply, count(*) from posts where federation_actor_uri is null and visibility = 'public' and status = 'published' group by is_reply`,
        sql`select count(*) from posts where federation_actor_uri is not null and is_reply`,
      ]) {
        const plan = JSON.stringify(await tx.execute(sql`explain (format json) ${query}`));
        expect(plan).not.toContain('Seq Scan');
        expect(plan).toMatch(/Index (Only )?Scan|Bitmap Index Scan/);
      }
    });
  });

  it('collapses a burst of concurrent pollers onto one computation', async () => {
    metrics.reset();
    const answers = await Promise.all(Array.from({ length: 12 }, () => nodeinfoStatisticsCached()));
    for (const answer of answers) expect(answer).toEqual(answers[0]);
    expect(await statementsAgainst('posts')).toBeLessThanOrEqual(3);
  });

  it('counts only public published local content and never counts a repeated delivery twice', async () => {
    // `posts` is shared with every suite on this database: assert on DELTAS.
    const db = getDb();
    const before = await measureNodeinfoStatistics();
    const remote = {
      federationActorUri: 'https://remote.example/users/nodeinfo',
    };
    const inserted = await db
      .insert(posts)
      .values([
        { oxyUserId: 'nodeinfo-a' },
        { oxyUserId: 'nodeinfo-a', isReply: true },
        { oxyUserId: 'nodeinfo-b', isReply: true },
        { oxyUserId: 'nodeinfo-draft', status: 'draft' },
        { oxyUserId: 'nodeinfo-private', visibility: 'private' },
        {
          oxyUserId: 'nodeinfo-ext',
          ...remote,
          federationActivityId: 'https://remote.example/nodeinfo/1',
        },
        {
          oxyUserId: 'nodeinfo-ext',
          ...remote,
          isReply: true,
          federationActivityId: 'https://remote.example/nodeinfo/2',
        },
      ])
      .returning({ id: posts.id });
    // The same activity delivered again hits the unique index: still one row.
    await db
      .insert(posts)
      .values({
        oxyUserId: 'nodeinfo-ext',
        ...remote,
        federationActivityId: 'https://remote.example/nodeinfo/1',
      })
      .onConflictDoNothing();
    const after = await measureNodeinfoStatistics();
    await db.delete(posts).where(
      inArray(
        posts.id,
        inserted.map((row) => row.id),
      ),
    );

    expect(after.local.posts - before.local.posts).toBe(1);
    expect(after.local.comments - before.local.comments).toBe(2);
    expect(after.external.posts - before.external.posts).toBe(1);
    expect(after.external.comments - before.external.comments).toBe(1);
    expect(after.combined.total - before.combined.total).toBe(5);
  });
});
