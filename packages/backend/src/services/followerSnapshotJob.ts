/**
 * Follower Snapshot Job (Phase 4 — powers the `risingCreators` feed source)
 *
 * A LEADER-GATED periodic job that samples follower counts for recently-active
 * authors and appends them to {@link AuthorFollowerSnapshot}. The `risingCreators`
 * source later computes each author's follower-growth delta over a window from
 * these snapshots.
 *
 * Operational invariants (mirror the other schedulers):
 *  - Started ONLY by `startSchedulers()` on the elected leader, so the sweep
 *    never multiplies across the fleet.
 *  - Additionally env-gated on `REDIS_URL`: with no Redis (local dev / a
 *    misconfigured task) the job stays an inline no-op rather than sampling
 *    without the distributed lock that guarantees single-writer semantics.
 *  - Every timer calls `.unref?.()` so the job NEVER keeps the event loop /
 *    process alive on its own (no test hangs, clean shutdown).
 *  - Re-entrancy guarded and fully non-throwing: a sweep that outlasts its
 *    interval is skipped, and any error is caught + logged, never thrown into the
 *    timer.
 */

import { PostVisibility } from '@mention/shared-types';
import { Post } from '../models/Post';
import { AuthorFollowerSnapshot } from '../models/AuthorFollowerSnapshot';
import { resolveUserSummaries } from './PostHydrationService';
import { logger } from '../utils/logger';

/** Sampling cadence. 6 hours — follower growth is a slow signal. */
export const FOLLOWER_SNAPSHOT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Defer the first sweep so boot is never contended. 5 minutes. */
export const FOLLOWER_SNAPSHOT_START_DELAY_MS = 5 * 60 * 1000;

/** "Active author" window: authors who published a public post within this span. 14 days. */
const FOLLOWER_SNAPSHOT_ACTIVE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** Upper bound on authors sampled per sweep (bounds the Oxy fetch + inserts). */
const FOLLOWER_SNAPSHOT_MAX_AUTHORS = 2000;

export class FollowerSnapshotJob {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startTimeout: ReturnType<typeof setTimeout> | null = null;
  private isRunning = false;
  /** Re-entrancy guard: a sweep is mid-flight (skip overlapping ticks). */
  private isSweeping = false;

  /** Start the leader-gated periodic snapshot sweep. Idempotent; env-gated on REDIS_URL. */
  start(): void {
    if (this.isRunning) return;
    if (!process.env.REDIS_URL) {
      logger.info('[FollowerSnapshotJob] REDIS_URL not set — follower snapshot job disabled (inline no-op)');
      return;
    }
    this.isRunning = true;

    this.startTimeout = setTimeout(() => {
      this.startTimeout = null;
      void this.runSnapshotSweep();
      this.interval = setInterval(() => {
        void this.runSnapshotSweep();
      }, FOLLOWER_SNAPSHOT_INTERVAL_MS);
      this.interval.unref?.();
    }, FOLLOWER_SNAPSHOT_START_DELAY_MS);
    this.startTimeout.unref?.();

    logger.info('[FollowerSnapshotJob] started (leader-gated follower snapshots)');
  }

  /** Stop the sweep + cancel any pending first-tick. Idempotent. */
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

  /**
   * One snapshot sweep: find recently-active local authors, resolve their current
   * follower counts (cached Oxy summaries), and append one snapshot per author
   * that reports a numeric count. Bounded, re-entrancy-guarded, never throws.
   */
  async runSnapshotSweep(): Promise<void> {
    if (this.isSweeping) {
      logger.debug('[FollowerSnapshotJob] sweep still running; skipping overlapping tick');
      return;
    }
    this.isSweeping = true;
    try {
      const windowStart = new Date(Date.now() - FOLLOWER_SNAPSHOT_ACTIVE_WINDOW_MS);
      const rawAuthorIds = (await Post.distinct('oxyUserId', {
        createdAt: { $gte: windowStart },
        visibility: PostVisibility.PUBLIC,
        status: 'published',
      })) as unknown[];

      const authorIds = rawAuthorIds
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
        .slice(0, FOLLOWER_SNAPSHOT_MAX_AUTHORS);
      if (authorIds.length === 0) return;

      const summaries = await resolveUserSummaries(authorIds);
      const at = new Date();
      const docs = authorIds
        .map((oxyUserId) => ({ oxyUserId, followerCount: summaries.get(oxyUserId)?.followerCount }))
        .filter(
          (doc): doc is { oxyUserId: string; followerCount: number } =>
            typeof doc.followerCount === 'number' && Number.isFinite(doc.followerCount),
        )
        .map((doc) => ({ oxyUserId: doc.oxyUserId, followerCount: doc.followerCount, at }));

      if (docs.length === 0) return;

      await AuthorFollowerSnapshot.insertMany(docs, { ordered: false });
      logger.info('[FollowerSnapshotJob] recorded follower snapshots', { count: docs.length });
    } catch (error) {
      logger.warn('[FollowerSnapshotJob] snapshot sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.isSweeping = false;
    }
  }
}

export const followerSnapshotJob = new FollowerSnapshotJob();
