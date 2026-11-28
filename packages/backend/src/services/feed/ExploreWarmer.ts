// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { exploreSource } from '../../mtn/feed/engine/sources/discoverySources';
import type { FeedEngineContext } from '../../mtn/feed/engine/types';
import { logger } from '../../utils/logger';
import { createRedisLock, type DistributedLock } from '../../utils/redisLock';

/**
 * Keeps the posts Explore reads in the database's cache.
 *
 * Explore scores one day of public originals (about 43,000 heap blocks). Those
 * blocks are the same for every reader; only the language filter differs. Read
 * recently they cost a few seconds, left alone for a few minutes the shared
 * instance evicts them for Clarity's and oxyadmin's traffic, and the next build
 * pays the whole disk read (17 to 25 s on 2026-11-26, with the database healthy).
 * The anonymous-feed cache cannot hide that for a key nobody asked for in the last
 * 15 minutes: no copy is kept, so that reader waits for the build.
 *
 * The warm-up is the real candidate read, not a separate query. It goes through
 * {@link exploreSource}, so what it keeps hot and what a build reads cannot drift
 * apart, and it runs on the one task that holds the scheduler leadership, behind
 * a cluster-wide lock like the trending recalculation.
 */

/** Short enough that a block stays resident, long enough that it adds almost no load of its own. */
const WARM_INTERVAL_MS = 4 * 60 * 1000;

/** The cluster-wide mutex of one warm-up (see {@link ExploreWarmer.runOnce}). */
const WARM_LOCK_KEY = 'explore:warm';

/**
 * Above the candidate statement's own budget, below the interval, so a task that
 * dies holding it delays the next warm-up by less than one cadence.
 */
const WARM_LOCK_TTL_MS = 3 * 60 * 1000;

/**
 * How long the warm-up rests after a failed read. A read that fails is a read
 * that ran out its whole statement budget (45 s of disk reads) against a database
 * that is already starved: repeating it every cadence would be the extra load
 * that keeps it starved. On 2026-11-26 every run timed out for hours.
 */
const REST_AFTER_FAILURE_MS = 30 * 60 * 1000;

/** What the warm-up asks for. Only the scan matters, so a small page is enough. */
const WARM_CAP = 20;

/** The anonymous reader: no account, so no exclusions and nothing personal to keep out of a shared read. */
const ANONYMOUS_CONTEXT: FeedEngineContext = { currentUserId: undefined };

export class ExploreWarmer {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The warm-up in flight on this task, so a second trigger joins it instead of scanning again. */
  private inFlight: Promise<void> | null = null;
  /** Until when a failed read keeps the warm-up from trying again. */
  private restUntil = Number.NEGATIVE_INFINITY;

  constructor(private readonly lock: DistributedLock = createRedisLock()) {}

  /** Leader-gated by design: called only from `startSchedulers()`. */
  public start(): void {
    this.timer = setInterval(() => {
      this.runOnce().catch((error) => {
        logger.warn('[ExploreWarmer] Warm-up failed', error);
      });
    }, WARM_INTERVAL_MS);
    // Never keep the event loop (or the test run) alive solely for this timer.
    this.timer.unref?.();
    logger.info('[ExploreWarmer] Started');
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One warm-up at a time: within this task a second trigger joins the one in
   * flight, across tasks the Redis lock decides and the loser skips. The lock
   * fails open, so with Redis down the warm-up runs unguarded.
   */
  public runOnce(): Promise<void> {
    this.inFlight ??= this.warmOnceAcrossTasks().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async warmOnceAcrossTasks(): Promise<void> {
    if (Date.now() < this.restUntil) return;
    const attempt = await this.lock.tryAcquire(WARM_LOCK_KEY, WARM_LOCK_TTL_MS);
    if (attempt.status === 'held') return;
    try {
      const startedAt = Date.now();
      // Read off the module rather than called as `exploreSource.gather(`: the
      // isolated-database scan lists the callers that really run the query.
      const { gather } = exploreSource;
      const rows = await gather(ANONYMOUS_CONTEXT, {}, WARM_CAP);
      logger.info(
        `[ExploreWarmer] Warmed ${rows.length} candidates in ${Date.now() - startedAt} ms`,
      );
    } catch (error) {
      this.restUntil = Date.now() + REST_AFTER_FAILURE_MS;
      throw error;
    } finally {
      if (attempt.status === 'acquired') await attempt.release();
    }
  }
}

export const exploreWarmer = new ExploreWarmer();
