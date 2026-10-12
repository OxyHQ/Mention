/**
 * Topic Affinity Refresh Job — keeps `topic_affinity_posts` current.
 *
 * The view is the narrow set of posts topic affinity reads (see its schema
 * docstring in `db/schema/discovery.ts`). This job is what moves the cost of
 * finding them off the request path: one scan of the eligible window every
 * {@link TOPIC_AFFINITY_REFRESH_INTERVAL_MS}, instead of one per viewer whose
 * affinity cache expired.
 *
 * Operational invariants (mirror the other schedulers):
 *  - Started ONLY by `startSchedulers()` on the elected leader.
 *  - `REFRESH ... CONCURRENTLY`: readers keep the previous contents until the
 *    new ones commit, so a refresh never blocks or empties a request's read.
 *  - Re-entrancy guarded: a refresh that outlasts its interval makes the next
 *    tick a no-op rather than a second concurrent refresh.
 *  - Never throws; a failed refresh is logged and the view keeps serving its
 *    last contents. Readers still apply their own `created_at` window, so a
 *    stale view can lag behind new posts but never serve an older window.
 *  - Every timer is unref'd, so the job never keeps the process alive.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../db/postgres';
import { getDb } from '../db/postgres';
import { logger } from '../utils/logger';

/**
 * Five minutes: the cadence post classification runs at, so a newly classified
 * post reaches topic affinity within about one classification cycle.
 */
export const TOPIC_AFFINITY_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** Defer the first refresh past boot; the migration built the view with data. */
export const TOPIC_AFFINITY_REFRESH_START_DELAY_MS = 60 * 1000;

/** Recompute `topic_affinity_posts` without blocking its readers. */
export async function refreshTopicAffinityPosts(db: Database = getDb()): Promise<void> {
  await db.execute(sql`refresh materialized view concurrently topic_affinity_posts`);
}

export class TopicAffinityRefreshJob {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startTimeout: ReturnType<typeof setTimeout> | null = null;
  private isRunning = false;
  private isRefreshing = false;

  /** Start the leader-gated periodic refresh. Idempotent. */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.startTimeout = setTimeout(() => {
      this.startTimeout = null;
      void this.runRefresh();
      this.interval = setInterval(() => {
        void this.runRefresh();
      }, TOPIC_AFFINITY_REFRESH_INTERVAL_MS);
      this.interval.unref?.();
    }, TOPIC_AFFINITY_REFRESH_START_DELAY_MS);
    this.startTimeout.unref?.();

    logger.info('[TopicAffinityRefreshJob] started (leader-gated view refresh)');
  }

  /** Stop the refresh and cancel a pending first run. Idempotent. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.startTimeout) {
      clearTimeout(this.startTimeout);
      this.startTimeout = null;
    }
    this.isRunning = false;
  }

  /** Refresh once. Never throws. Returns whether a refresh ran and succeeded. */
  async runRefresh(): Promise<boolean> {
    if (this.isRefreshing) return false;
    this.isRefreshing = true;
    const startedAt = Date.now();
    try {
      await refreshTopicAffinityPosts();
      logger.debug('[TopicAffinityRefreshJob] refreshed', { durationMs: Date.now() - startedAt });
      return true;
    } catch (error) {
      logger.error('[TopicAffinityRefreshJob] refresh failed', {
        durationMs: Date.now() - startedAt,
        error,
      });
      return false;
    } finally {
      this.isRefreshing = false;
    }
  }
}

export const topicAffinityRefreshJob = new TopicAffinityRefreshJob();
