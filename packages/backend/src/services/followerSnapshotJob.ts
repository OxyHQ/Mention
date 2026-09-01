/**
 * Follower Snapshot Job (Phase 4 — powers the `risingCreators` feed source)
 *
 * A LEADER-GATED periodic job that samples follower counts for recently-active
 * authors and appends them to `author_follower_snapshots`. The `risingCreators`
 * source later computes each author's follower-growth delta over a window from
 * these snapshots, and only ever looks INSIDE that window — the table's 30-day
 * retention entry in `db/expiry.ts` is therefore a bound on storage, not on what
 * the delta can see.
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
import { and, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { isRedisRuntimeConfigured } from '../config';
import { qualified } from '@oxyhq/db';
import { getDb } from '../db/postgres';
import { authorFollowerSnapshots } from '../db/schema/discovery';
import { posts } from '../db/schema/posts';
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
    if (!isRedisRuntimeConfigured()) {
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
   * The authors this sweep will sample: recently-active local authors, LEAST
   * RECENTLY SNAPSHOTTED FIRST, capped at {@link FOLLOWER_SNAPSHOT_MAX_AUTHORS}.
   *
   * ## `nulls first` is the whole point of the ordering
   *
   * Mongo ran `Post.distinct(...)` and `.slice(0, MAX)`: no ordering at all, so
   * with more active authors than the cap the same arbitrary prefix was resampled
   * every six hours and the rest were never sampled — silently, forever. An
   * unordered `limit` in Postgres is just as arbitrary and additionally
   * non-deterministic between runs, so the bound is made FAIR here rather than
   * ported as-is: sample whoever has waited longest.
   *
   * That makes the NULL ordering load-bearing. A never-snapshotted author has no
   * `max(at)` at all, and Postgres sorts NULLs LAST by default — so under the
   * default they would sink behind every already-sampled author and, past the
   * cap, never be reached. `nulls first` puts "never sampled" ahead of "sampled
   * long ago", which is the only ordering that lets a new author ever enter the
   * series. Mongo's own rule (missing sorts FIRST) says the same thing.
   *
   * `oxy_user_id` is the final tiebreak: `max(at)` alone is not a total order
   * (a whole batch of authors is written with one identical `at`), so without it
   * the cap would cut an arbitrary, run-to-run-varying slice through the tie.
   *
   * The correlated reference is `qualified()`, and the reason is worth stating
   * precisely rather than as a blanket rule, because it was MEASURED against
   * drizzle 0.45.2 and the blanket version is wrong: drizzle strips the table
   * prefix from an interpolated column in exactly ONE position — the SELECT LIST
   * of a single-table select. `where`, `order by` and an `update … set` all come
   * out fully qualified on their own, so this particular expression would render
   * correctly even bare (a mutation removing `qualified()` here leaves every test
   * green).
   *
   * It stays because `isSingleTable` is a property of the surrounding QUERY, not
   * of this expression: adding a join flips it, removing one flips it back, and
   * moving this subquery into a select list — where it would read naturally —
   * flips it too. There, `where "oxy_user_id" = "oxy_user_id"` resolves BOTH
   * names against `author_follower_snapshots`, the predicate compares a column to
   * itself, `max(at)` becomes one global maximum shared by every author, and the
   * ordering silently collapses to the tiebreak with no error anywhere. That is
   * the shape that shipped zero follow counts in the sibling oxy-api port.
   */
  private async selectAuthorsToSample(windowStart: Date): Promise<string[]> {
    const rows = await getDb()
      .select({ oxyUserId: posts.oxyUserId })
      .from(posts)
      .where(
        and(
          gte(posts.createdAt, windowStart),
          eq(posts.visibility, PostVisibility.PUBLIC),
          eq(posts.status, 'published'),
          isNotNull(posts.oxyUserId),
        ),
      )
      .groupBy(posts.oxyUserId)
      .orderBy(
        sql`(select max(${authorFollowerSnapshots.at})
             from ${authorFollowerSnapshots}
             where ${qualified(authorFollowerSnapshots.oxyUserId)} = ${qualified(posts.oxyUserId)})
             asc nulls first`,
        sql`${qualified(posts.oxyUserId)} asc`,
      )
      .limit(FOLLOWER_SNAPSHOT_MAX_AUTHORS);

    return rows.flatMap((row) =>
      typeof row.oxyUserId === 'string' && row.oxyUserId.length > 0 ? [row.oxyUserId] : [],
    );
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
      const authorIds = await this.selectAuthorsToSample(windowStart);
      if (authorIds.length === 0) return;

      const summaries = await resolveUserSummaries(authorIds);
      const at = new Date();
      // A count must be a non-negative INTEGER, not merely finite: the column is
      // `integer` with a `>= 0` CHECK, and one bad value would abort the whole
      // sweep's insert — where Mongoose's per-document validation under
      // `{ ordered: false }` only dropped that one author.
      const rows = authorIds.flatMap((oxyUserId) => {
        const followerCount = summaries.get(oxyUserId)?.followerCount;
        if (typeof followerCount !== 'number') return [];
        if (!Number.isInteger(followerCount) || followerCount < 0) return [];
        return [{ oxyUserId, followerCount, at }];
      });

      if (rows.length === 0) return;

      // Mongo's `{ ordered: false }` bought per-document resilience; there are no
      // constraints on this table for a row to violate, so one INSERT is the
      // whole write and a failure is a real failure rather than a partial batch.
      await getDb().insert(authorFollowerSnapshots).values(rows);
      logger.info('[FollowerSnapshotJob] recorded follower snapshots', { count: rows.length });
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
