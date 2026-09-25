/**
 * `GET /search/overview` answers within its lane budgets, however slow a lane's
 * query is.
 *
 * ## The regression this pins (issue #1140)
 *
 * Production overviews took 1.6s at the median and up to 10.4s, against a
 * designed per-lane budget of 1.5s with a 1s statement timeout. Neither budget
 * bounded anything:
 *
 * - every lane query called `getDb()` instead of using the transaction
 *   `withStatementTimeout` opened, so the `SET LOCAL statement_timeout` sat on
 *   an idle connection while the real query ran unbounded on another;
 * - the three cached lanes were awaited BEFORE the orchestrator started, so its
 *   wall-clock race was run against values that had already settled.
 *
 * Both are proved with a hashtag lane whose query sleeps well past every
 * budget, ON THE CONNECTION IT IS HANDED: the response must come back inside the
 * wall-clock budget with the lane marked `timeout`, and the sleep itself must be
 * cancelled by Postgres at the statement budget — which happens only if that
 * connection is the budgeted transaction. The call count pins that a timed-out
 * lane is not re-run.
 */

import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

import type { SearchOverviewResponse } from '@mention/shared-types';

/** Well past both budgets (1s statement, 1.5s wall clock). */
const SLEEP_SECONDS = 4;

/**
 * Every call of the slow lane, and how its query ended. `settled` resolves when
 * Postgres gives the connection back, which is the point: a lane whose RESPONSE
 * was cut off by the wall-clock race but whose query kept running still holds a
 * pooled connection for the whole sleep.
 */
const hashtagCalls = vi.hoisted(() => ({
  count: 0,
  settled: [] as Array<Promise<{ tookMs: number; cancelledByPostgres: boolean }>>,
}));

vi.mock('../../services/search/hashtagSearch', async () => {
  const actual = await vi.importActual<typeof import('../../services/search/hashtagSearch')>(
    '../../services/search/hashtagSearch',
  );
  const postgres = await vi.importActual<typeof import('../../db/postgres')>('../../db/postgres');
  const { isStatementTimeout } = await vi.importActual<typeof import('../../utils/withStatementTimeout')>(
    '../../utils/withStatementTimeout',
  );
  return {
    ...actual,
    // Sleeps on whichever connection the route hands it, falling back to the
    // pool exactly as the service's own default does — so a route that stops
    // passing the budgeted transaction gets an unbounded sleep, not an error.
    searchHashtagsWithCounts: vi.fn(async (
      _query: string,
      _offset: number,
      _limit: number,
      db: import('../../db/postgres').DatabaseOrTransaction = postgres.getDb(),
    ) => {
      hashtagCalls.count += 1;
      const started = Date.now();
      // Adopted into ONE promise: drizzle's query is a lazy thenable that
      // executes again on every `then`, and the second run would meet a
      // transaction the first one's cancellation had already aborted.
      const query = Promise.resolve(db.execute(sql`select pg_sleep(${SLEEP_SECONDS})`));
      hashtagCalls.settled.push(query.then(
        () => ({ tookMs: Date.now() - started, cancelledByPostgres: false }),
        (error: unknown) => ({ tookMs: Date.now() - started, cancelledByPostgres: isStatementTimeout(error) }),
      ));
      await query;
      return { results: [], hasMore: false };
    }),
  };
});

/** Owners resolve through Oxy; stubbed so no lane leaves the process. */
vi.mock('../../services/PostHydrationService', async () => {
  const actual = await vi.importActual<typeof import('../../services/PostHydrationService')>(
    '../../services/PostHydrationService',
  );
  return { ...actual, resolveUserSummaries: vi.fn(async () => new Map()) };
});

import { closePostgres, connectPostgres } from '../../db/postgres';
import { forgetSharedLanes } from '../../services/search/searchOverviewCache';
import { SEARCH_OVERVIEW_LANE_LIMIT } from '@mention/shared-types';

import searchOverviewRoutes from '../../routes/searchOverview';

const TERM = 'zbudgettermq';

let app: Express;

beforeAll(async () => {
  await connectPostgres();
  app = express();
  app.use('/search', searchOverviewRoutes);
});

afterEach(async () => {
  // Drain before the next case: an unbounded sleep left running would be
  // joined by the next request through the cache's single-flight.
  await Promise.all(hashtagCalls.settled);
  hashtagCalls.count = 0;
  hashtagCalls.settled = [];
  await forgetSharedLanes(TERM, SEARCH_OVERVIEW_LANE_LIMIT);
});

afterAll(async () => {
  await closePostgres();
});

describe('GET /search/overview lane budgets', () => {
  it('answers within budget when a lane query runs long, reporting it as a timeout', async () => {
    const started = Date.now();
    const res = await request(app).get('/search/overview').query({ q: TERM }).expect(200);
    const elapsedMs = Date.now() - started;
    const body = res.body as SearchOverviewResponse;

    // The statement timeout (1s) cancels the sleep. Unbounded, this is >= 4s.
    expect(elapsedMs).toBeLessThan(SLEEP_SECONDS * 1000 - 1000);
    expect(body.lanes.hashtags.status).toBe('timeout');
    expect(body.lanes.hashtags.items).toEqual([]);
    // The lane that does not share the slow group still answers.
    expect(body.lanes.lists.status).toBe('ok');
    expect(body.servedFromCache).toBe(false);
  }, 15_000);

  it('stops the slow query itself, not just the wait for it', async () => {
    await request(app).get('/search/overview').query({ q: TERM }).expect(200);

    // The wall-clock race alone would pass the case above while the sleep kept
    // its pooled connection for the full 4s. Only the statement timeout, on the
    // connection the query actually runs on, ends the work.
    expect(hashtagCalls.settled).toHaveLength(1);
    const [outcome] = await Promise.all(hashtagCalls.settled);
    expect(outcome.cancelledByPostgres).toBe(true);
    expect(outcome.tookMs).toBeLessThan(SLEEP_SECONDS * 1000 - 1000);
  }, 15_000);

  it('runs a timed-out lane once per request, never a second time', async () => {
    await request(app).get('/search/overview').query({ q: TERM }).expect(200);

    // The shared-lane cache used to catch the compute's own rejection and run it
    // again "uncached", so a lane over budget paid the budget twice.
    expect(hashtagCalls.count).toBe(1);
  }, 15_000);
});
