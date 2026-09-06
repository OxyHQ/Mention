/**
 * Detached work the shutdown drain has to wait for.
 *
 * A request handler that hands work to `void somePromise()` returns sooner, and
 * that is often the right trade: the socket broadcast after `POST /posts` costs a
 * full hydration — including the Oxy author batch and its 1500 ms deadline — and
 * contributes nothing to the author's own response. Detaching it is a real
 * latency win for the writer.
 *
 * What it silently gives up is the drain. `gracefulShutdown` closes in two
 * phases: producers and workers stop first, while Postgres and Redis are still
 * open, and only then do HTTP, sockets, Redis and Postgres close. Work started
 * with a bare `void` belongs to neither phase, so a SIGTERM arriving while it is
 * in flight takes its database connection (`closePostgres`) and its socket server
 * (`io.close`) out from under it. The visible effect is small and real: readers
 * miss the live update for posts created in the last second or so before a task
 * stops — every deploy, since a merge to `main` is a deploy here.
 *
 * The awaited version had this for free, because the HTTP drain waited for the
 * request that contained it. This module is what gives it back.
 *
 * ## Why a registry and not one field per caller
 *
 * `ModerationOutboxDispatcher` and `EngagementOutboxDispatcher` already solve the
 * same problem the same way — hold the in-flight promise, `await` it in `stop()`,
 * and let `gracefulShutdown` await that. This is that idiom with the one
 * difference their case does not have: a dispatcher runs a single tick at a time,
 * while detached request work is concurrent and arrives from more than one call
 * site. So the promise field becomes a set, and the `finally` that clears the
 * field becomes a delete.
 *
 * ## Bounded, and what happens at the bound
 *
 * The set drains itself as promises settle, so under any normal load it holds a
 * handful of entries. The cap exists for the case that is not normal — a
 * dependency wedged open with no timeout, arriving faster than it completes. Past
 * the cap the work still RUNS; it is simply not registered, so a pathological
 * backlog degrades to today's behaviour (undrained) instead of growing a set that
 * never shrinks and a shutdown that never finishes. That is the safer of the two
 * failure modes, and it is logged once so it is not silent.
 */

import { logger } from '../utils/logger';

/**
 * How many detached tasks may be tracked at once.
 *
 * Sized as an order of magnitude above what a healthy process holds: each entry
 * lives for one hydration-and-emit, so even a burst of concurrent posts settles
 * far below this. A process at the cap is not busy, it is stuck.
 */
const MAX_TRACKED_TASKS = 256;

/**
 * How long the drain waits before giving up on the work it is tracking.
 *
 * Strictly under `SHUTDOWN_DEADLINE_MS` (10 s) in `gracefulShutdown`, because
 * this drain runs in the FIRST phase and everything after it — stopping
 * dispatchers, closing HTTP, sockets, Redis and Postgres — still needs room
 * inside that ceiling. A detached task that has not finished in two seconds is
 * one whose dependency is already unhealthy; waiting longer trades a clean
 * shutdown for it.
 */
const DRAIN_TIMEOUT_MS = 2_000;

const tracked = new Set<Promise<unknown>>();
let capReported = false;

/**
 * Run detached work that the shutdown drain will wait for.
 *
 * The caller keeps its own error handling: this never inspects or reports the
 * task's outcome, because the sites that use it already log their own failures at
 * the severity they judge right (a missed broadcast is a `warn`, not an error).
 * A rejection is swallowed here ONLY so tracking cannot turn a handled failure
 * into an unhandled rejection.
 */
export function trackBackgroundWork(task: Promise<unknown>): void {
  if (tracked.size >= MAX_TRACKED_TASKS) {
    if (!capReported) {
      capReported = true;
      logger.warn('[BackgroundWork] tracking cap reached; further tasks run undrained', {
        cap: MAX_TRACKED_TASKS,
      });
    }
    return;
  }

  const entry = task
    .catch(() => undefined)
    .finally(() => {
      tracked.delete(entry);
    });
  tracked.add(entry);
}

/** How many detached tasks are currently tracked. For tests and diagnostics. */
export function trackedBackgroundWorkCount(): number {
  return tracked.size;
}

/**
 * Wait for tracked work to finish, bounded by {@link DRAIN_TIMEOUT_MS}.
 *
 * Resolves rather than rejects in every case, including the timeout: a shutdown
 * must not be blocked by the thing it is trying to be polite about. Returns
 * whether the set emptied, so the caller can say which happened.
 */
export async function drainBackgroundWork(
  timeoutMs: number = DRAIN_TIMEOUT_MS,
): Promise<boolean> {
  if (tracked.size === 0) return true;

  const pending = Array.from(tracked);
  logger.info('[BackgroundWork] draining detached tasks', { pending: pending.length });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });

  try {
    const drained = await Promise.race([
      Promise.allSettled(pending).then(() => true),
      timedOut,
    ]);
    if (!drained) {
      logger.warn('[BackgroundWork] drain timed out; abandoning detached tasks', {
        pending: tracked.size,
        timeoutMs,
      });
    }
    return drained;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Drop every tracked task without waiting. Tests only — never a shutdown path. */
export function resetBackgroundWorkForTests(): void {
  tracked.clear();
  capReported = false;
}
