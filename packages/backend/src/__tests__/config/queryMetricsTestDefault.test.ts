import { describe, expect, it } from 'vitest';

import { config } from '../../config';

/**
 * The slow-query line that `db/queryMetrics.ts` emits goes through the same
 * `logger.warn` the application uses. With instrumentation on by default under
 * test, any suite asserting "this path warns about nothing" becomes a function
 * of how fast the machine running it is: a fixture insert slower than
 * `DB_SLOW_QUERY_MS` produces a warn line the suite never asked for.
 *
 * That is not hypothetical. `listSubscriptionVisibility`'s multi-row insert into
 * `account_list_members` took 350 ms on a CI runner and stayed under the 200 ms
 * threshold on a developer machine, so the suite was green locally and red in
 * CI — the worst shape a failure can take.
 *
 * This pins the resolution so the default cannot drift back. It deliberately
 * asserts the RESOLVED config rather than re-deriving it from `process.env`:
 * re-deriving would restate the implementation and pass no matter what the
 * config actually did.
 */
describe('query instrumentation is off by default under test', () => {
  it('resolves DB_QUERY_METRICS_ENABLED to false when the environment does not set it', () => {
    // The guard is only meaningful for a run that has not been told otherwise.
    // Skipping rather than asserting keeps an explicit opt-in run honest.
    if (process.env.DB_QUERY_METRICS_ENABLED !== undefined) return;

    expect(process.env.NODE_ENV).toBe('test');
    expect(config.postgres.queryMetricsEnabled).toBe(false);
  });

  it('still carries a slow-query threshold, so enabling it needs no second setting', () => {
    expect(config.postgres.slowQueryMs).toBeGreaterThan(0);
  });
});
