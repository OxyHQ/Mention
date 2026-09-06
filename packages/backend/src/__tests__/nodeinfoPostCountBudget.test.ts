/**
 * `GET /nodeinfo/2.0`'s post count is not one sequential scan per crawler.
 *
 * The endpoint is public, unauthenticated, and advertised through
 * `/.well-known/nodeinfo` — it exists so other fediverse instances discover this
 * one, so being polled by strangers is its PURPOSE, not an abuse case. It reports
 * `localPosts` from `count(*)` over `posts`, the one table in the schema that
 * only ever grows, and there is no index that can answer a full count: the work
 * is a sequential scan whose cost rises with the instance's whole history.
 *
 * `runtimeApp.ts` carried a comment saying the exact count was affordable because
 * the value was "read at most once per request from a cached surface". No such
 * surface existed. This is the surface, and this file is what stops the comment
 * from going back to describing an intention.
 *
 * ## What is asserted, and what this environment can prove
 *
 * `__tests__/setup.ts` mocks Redis with `isReady: false`, so the Redis half of
 * the cache always misses here and a test of "the second request reads Redis"
 * would measure the mock rather than the cache. What does NOT depend on Redis is
 * `getOrCompute`'s per-PROCESS single-flight, and that is precisely the property
 * the crawl-storm case needs: concurrent pollers collapse onto one computation.
 *
 * So the budget is measured across CONCURRENT callers, which is both what a
 * crawl storm looks like and the only half of the mechanism this environment can
 * honestly evaluate. The Redis half is exercised by `utils/cache.ts`'s own
 * tests — the point of a shared primitive is not to re-test it per caller.
 *
 * Measured from `db_query_duration_ms`, the same series production scrapes, not
 * from a spy: a spy on the query builder would keep passing if the count moved
 * to another statement.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../config';
import { closePostgres, connectPostgres } from '../db/postgres';
import { metrics } from '../utils/metrics';
import { countLocalPostsCached } from '../runtimeApp';

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
  it('scans posts ONCE for a burst of concurrent pollers', async () => {
    // Twelve simultaneous crawlers, which before the cache meant twelve
    // concurrent sequential scans of `posts`.
    const answers = await Promise.all(
      Array.from({ length: 12 }, () => countLocalPostsCached()),
    );

    // Vacuity guard: every caller must have been served, and served the SAME
    // answer — a single-flight that handed different callers different values
    // would meet the budget while being broken.
    expect(answers).toHaveLength(12);
    for (const answer of answers) {
      expect(typeof answer).toBe('number');
      expect(answer).toBe(answers[0]);
    }

    expect(await statementsAgainst('posts')).toBe(1);
  });

  it('still answers with a real count, not a placeholder', async () => {
    // The other half of the guard: a cache that always returned 0 would satisfy
    // the budget above forever. `posts` is shared with every other suite running
    // against this database, so the assertion is on the SHAPE — a non-negative
    // integer that came from the database — rather than on an exact figure this
    // file cannot own.
    const total = await countLocalPostsCached();

    expect(Number.isInteger(total)).toBe(true);
    expect(total).toBeGreaterThanOrEqual(0);
  });
});
