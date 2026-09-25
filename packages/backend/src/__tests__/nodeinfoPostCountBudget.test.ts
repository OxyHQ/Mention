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
import { sql } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { countLocalPostsCached, estimatePostCount } from '../runtimeApp';

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
  const exposition = await metrics.getPrometheusFormat();
  const pattern = new RegExp(
    `^db_query_duration_ms_count\\{operation="[a-z]+",table="${table}"\\} (\\d+)$`,
    'gm',
  );
  let total = 0;
  let match = pattern.exec(exposition);
  while (match) {
    total += Number(match[1]);
    match = pattern.exec(exposition);
  }
  return total;
}

describe('nodeinfo localPosts — scan budget', () => {
  it('reads the planner estimate and never scans an analyzed posts table', async () => {
    await getDb().execute(sql`analyze posts`);
    metrics.reset();

    const total = await estimatePostCount();

    // Vacuity guard: the estimate is a real non-negative integer, not a
    // placeholder. `posts` is shared with every suite running against this
    // database, so the assertion is on the SHAPE rather than on an exact figure.
    expect(Number.isInteger(total)).toBe(true);
    expect(total).toBeGreaterThanOrEqual(0);
    expect(await statementsAgainst('posts')).toBe(0);
    // The catalog read is not a schema table, so it is labelled `other`.
    expect(await statementsAgainst('other')).toBe(1);
  });

  it('collapses a burst of concurrent pollers onto one computation', async () => {
    // Twelve simultaneous crawlers, which before any cache meant twelve
    // concurrent sequential scans of `posts`.
    const answers = await Promise.all(
      Array.from({ length: 12 }, () => countLocalPostsCached()),
    );

    // Every caller must have been served, and served the SAME answer — a
    // single-flight that handed different callers different values would meet
    // the budget while being broken.
    expect(answers).toHaveLength(12);
    for (const answer of answers) {
      expect(typeof answer).toBe('number');
      expect(answer).toBe(answers[0]);
    }

    // One computation: one catalog read, plus at most one exact count if this
    // database's `posts` has never been analyzed.
    expect(await statementsAgainst('other')).toBe(1);
    expect(await statementsAgainst('posts')).toBeLessThanOrEqual(1);
  });
});
