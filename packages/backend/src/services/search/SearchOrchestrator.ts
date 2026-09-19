/**
 * The server-side search fan-out behind `GET /search/overview`.
 *
 * ## What it replaces
 *
 * The search screen issued SEVEN requests across THREE hosts and awaited all of
 * them, so the overview rendered at the speed of the slowest lane and each lane
 * paid its own TLS, its own auth preflight and its own viewer-context
 * resolution. One request replaces that, and — because the lanes now share a
 * process — the viewer context is resolved once for all of them instead of once
 * per lane.
 *
 * ## One slow lane must not hold the response
 *
 * That is the whole reason this is an orchestrator rather than a handler with
 * seven `await`s. Each lane runs under TWO bounds, and both are needed:
 *
 * - a Postgres `statement_timeout`, which is what actually stops the work
 *   (`utils/withStatementTimeout.ts` explains why a `Promise.race` alone
 *   abandons the promise while the query keeps running and keeps its pooled
 *   connection — a slow lane then exhausts the pool while every request
 *   "returns fast");
 * - a wall-clock race, for the parts of a lane that are not Postgres: the posts
 *   lane reaches Oxy for the viewer's profile and Clarity for link previews,
 *   and no database setting bounds those.
 *
 * A lane that exceeds either is reported as `timeout` with no items. It is NOT
 * reported as empty — see the contract in `@mention/shared-types`: an absent or
 * empty lane and a failed one are different answers, and collapsing them makes
 * the client render a confident "no results" for an outage.
 *
 * ## Failure is per lane, except where it must not be
 *
 * A lane that throws becomes `status: 'error'` and the others still render.
 * The exception is the viewer's privacy context, which is resolved ONCE before
 * any lane starts and whose failure fails the whole request:
 * `getBlockedUserIds` / `getRestrictedUserIds` throw rather than returning
 * empty when Oxy cannot answer, and degrading to an empty set would read as
 * "this viewer blocks nobody" and show them posts from accounts they blocked.
 */

import {
  SEARCH_LANE_NAMES,
  type SearchLane,
  type SearchLaneName,
  type SearchOverviewResponse,
} from '@mention/shared-types';

import { logger } from '../../utils/logger';
import { isStatementTimeout } from '../../utils/withStatementTimeout';

/** What a lane implementation returns when it succeeds. */
export interface LaneResult<T = unknown> {
  items: T[];
  hasMore: boolean;
  nextCursor?: string;
}

/** A lane the orchestrator can run. */
export interface LaneDefinition {
  name: SearchLaneName;
  /**
   * Wall-clock budget. Bounds the non-Postgres half; the lane is expected to
   * apply its own `statement_timeout` for the query half.
   */
  budgetMs: number;
  run: () => Promise<LaneResult>;
}

/** A lane that is deliberately not run, and why the client should say so. */
export interface SkippedLane {
  name: SearchLaneName;
  status: 'skipped' | 'unavailable';
}

/** The statuses that mean the viewer is missing something they should have. */
const DEGRADED_STATUSES = new Set<SearchLane<unknown>['status']>(['timeout', 'error', 'unavailable']);

function emptyLane(status: SearchLane<unknown>['status'], tookMs: number): SearchLane<unknown> {
  return { status, items: [], hasMore: false, tookMs };
}

/**
 * Race `work` against `budgetMs`.
 *
 * The timer is `unref`'d and always cleared, so a lane that finishes early
 * cannot hold the process open — the shape `PostHydrationService`'s own
 * deadline race uses. The sentinel is a unique symbol rather than `undefined`
 * so a lane legitimately resolving to a falsy value is not mistaken for a
 * timeout.
 */
const TIMED_OUT = Symbol('lane-timeout');

async function withinBudget<T>(budgetMs: number, work: Promise<T>): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), budgetMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run every lane concurrently and assemble the response.
 *
 * `Promise.all` over per-lane wrappers that never reject, rather than
 * `allSettled` over the raw lanes: the wrapper is where a rejection becomes a
 * STATUS, and doing it there means the status can distinguish a timeout from a
 * failure, which `allSettled`'s `rejected` cannot.
 */
export async function runSearchOverview(
  query: string,
  lanes: readonly LaneDefinition[],
  skipped: readonly SkippedLane[],
): Promise<SearchOverviewResponse> {
  const results = new Map<SearchLaneName, SearchLane<unknown>>();

  for (const lane of skipped) {
    results.set(lane.name, emptyLane(lane.status, 0));
  }

  await Promise.all(
    lanes.map(async (lane) => {
      const started = Date.now();
      try {
        const outcome = await withinBudget(lane.budgetMs, lane.run());
        const tookMs = Date.now() - started;
        if (outcome === TIMED_OUT) {
          logger.warn('[SearchOverview] lane exceeded its budget', {
            lane: lane.name,
            budgetMs: lane.budgetMs,
          });
          results.set(lane.name, emptyLane('timeout', tookMs));
          return;
        }
        results.set(lane.name, {
          status: 'ok',
          items: outcome.items,
          hasMore: outcome.hasMore,
          nextCursor: outcome.nextCursor,
          tookMs,
        });
      } catch (error) {
        const tookMs = Date.now() - started;
        // A Postgres statement timeout is a TIMEOUT, not a failure. It arrives
        // as a rejection, so without this check the lane most likely to be slow
        // would be the one reported as broken.
        const status = isStatementTimeout(error) ? 'timeout' : 'error';
        logger.warn('[SearchOverview] lane did not complete', { lane: lane.name, status, error });
        results.set(lane.name, emptyLane(status, tookMs));
      }
    }),
  );

  // A TOTAL map, built from the shared name list so a lane added to the
  // contract but forgotten here is `unavailable` rather than absent — the
  // client can always read every key.
  const assembled = {} as Record<SearchLaneName, SearchLane<unknown>>;
  for (const name of SEARCH_LANE_NAMES) {
    assembled[name] = results.get(name) ?? emptyLane('unavailable', 0);
  }

  return {
    query,
    lanes: assembled,
    // `skipped` is NOT degraded. It is a deliberate choice for this request —
    // an anonymous viewer has no saved posts, and `profiles` is served by Oxy
    // and not folded in yet — so counting it would mark every anonymous search
    // degraded and every search at all while `profiles` stays out, which would
    // make the flag mean nothing. Degraded means "something that should be here
    // is missing".
    degraded: SEARCH_LANE_NAMES.some((name) =>
      DEGRADED_STATUSES.has(assembled[name].status),
    ),
    servedFromCache: false,
  };
}
