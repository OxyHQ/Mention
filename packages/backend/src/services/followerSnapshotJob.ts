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
 *  - Due-ness is read from the newest snapshot, not kept by the timer, so a
 *    change of leader does not start a fresh six-hour cycle with an immediate
 *    sweep (see `runSnapshotSweepIfDue`).
 *  - Re-entrancy guarded and fully non-throwing: a sweep that outlasts its
 *    interval is skipped, and any error is caught + logged, never thrown into the
 *    timer.
 */

import { PostVisibility } from '@mention/shared-types';
import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { isRedisRuntimeConfigured } from '../config';
import { getDb } from '../db/postgres';
import { authorFollowerSnapshots } from '../db/schema/discovery';
import { posts } from '../db/schema/posts';
import { resolveUserSummaries } from './PostHydrationService';
import { logger } from '../utils/logger';

/** Sampling cadence. 6 hours — follower growth is a slow signal. */
export const FOLLOWER_SNAPSHOT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * How often the leader ASKS whether a sweep is due (see `runSnapshotSweepIfDue`).
 * The question is one index probe; the sweep still happens once per
 * {@link FOLLOWER_SNAPSHOT_INTERVAL_MS}. 30 minutes.
 */
export const FOLLOWER_SNAPSHOT_CHECK_INTERVAL_MS = 30 * 60 * 1000;

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
      void this.runSnapshotSweepIfDue();
      this.interval = setInterval(() => {
        void this.runSnapshotSweepIfDue();
      }, FOLLOWER_SNAPSHOT_CHECK_INTERVAL_MS);
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
   * last snapshot at all, and Postgres sorts NULLs LAST by default — so under the
   * default they would sink behind every already-sampled author and, past the
   * cap, never be reached. `nulls first` puts "never sampled" ahead of "sampled
   * long ago", which is the only ordering that lets a new author ever enter the
   * series. Mongo's own rule (missing sorts FIRST) says the same thing.
   *
   * `oxy_user_id` is the final tiebreak: the last `at` alone is not a total order
   * (a whole batch of authors is written with one identical `at`), so without it
   * the cap would cut an arbitrary, run-to-run-varying slice through the tie.
   *
   * ## Why a lateral `limit 1` and not `max(at)` (#1166)
   *
   * This was a correlated `(select max(at) … where oxy_user_id = posts.oxy_user_id)`
   * in the ORDER BY. Postgres did not turn that `max` into a one-row index probe:
   * measured in production (2026-09-26), every one of 22,813 active authors
   * aggregated ALL of their snapshots (138 each, 464k heap fetches, 613k
   * buffers), 12 s of a 17.4 s statement. The lateral `order by at desc nulls
   * last limit 1` reads one entry of `author_follower_snapshots_owner_chrono_idx`
   * per author — the index's own order, so NULLS LAST must stay spelled out —
   * and measured 1.25 s for the whole statement on the same data.
   *
   * The distinct-author set is read from `posts_public_author_recent_idx`
   * (migration 0052), whose predicate is exactly this WHERE: an index-only range
   * over the window instead of a sequential scan of every post.
   *
   * The correlation is a lateral join on the derived table's own alias, so there
   * is no bare column for drizzle to strip the table prefix from — the failure
   * that shipped zero follow counts in the sibling oxy-api port, where a
   * correlated `where "oxy_user_id" = "oxy_user_id"` compared a column to itself.
   * `distinguishes authors by their OWN last snapshot` is the test that holds it.
   */
  private async selectAuthorsToSample(windowStart: Date): Promise<string[]> {
    const db = getDb();
    const active = db
      .selectDistinct({ oxyUserId: posts.oxyUserId })
      .from(posts)
      .where(
        and(
          gte(posts.createdAt, windowStart),
          eq(posts.visibility, PostVisibility.PUBLIC),
          eq(posts.status, 'published'),
          isNotNull(posts.oxyUserId),
        ),
      )
      .as('active_authors');
    const lastSnapshot = db
      .select({ at: authorFollowerSnapshots.at })
      .from(authorFollowerSnapshots)
      .where(eq(authorFollowerSnapshots.oxyUserId, active.oxyUserId))
      .orderBy(sql`${authorFollowerSnapshots.at} desc nulls last`)
      .limit(1)
      .as('last_snapshot');

    const rows = await db
      .select({ oxyUserId: active.oxyUserId })
      .from(active)
      .leftJoinLateral(lastSnapshot, sql`true`)
      .orderBy(sql`${lastSnapshot.at} asc nulls first`, sql`${active.oxyUserId} asc`)
      .limit(FOLLOWER_SNAPSHOT_MAX_AUTHORS);

    return rows.flatMap((row) =>
      typeof row.oxyUserId === 'string' && row.oxyUserId.length > 0 ? [row.oxyUserId] : [],
    );
  }

  /**
   * When the last sweep wrote, or `null` if none ever has. One probe of
   * `author_follower_snapshots_at_idx`.
   */
  private async lastSweepAt(): Promise<Date | null> {
    const [row] = await getDb()
      .select({ at: authorFollowerSnapshots.at })
      .from(authorFollowerSnapshots)
      .orderBy(desc(authorFollowerSnapshots.at))
      .limit(1);
    return row?.at ?? null;
  }

  /**
   * Sweep only when the last one is at least {@link FOLLOWER_SNAPSHOT_INTERVAL_MS}
   * old. This is what the timer calls; `runSnapshotSweep` itself is unconditional.
   *
   * ## Why due-ness lives in the table, not in the timer (#1166)
   *
   * The timer is per LEADER, and leadership moves on every deploy and every lost
   * lease renewal. Each new leader swept five minutes after acquiring it, so the
   * "every six hours" sweep ran 19–55 times a day (counted from the distinct `at`
   * values production wrote, 2026-09-19..25) — each one a 17 s statement and a
   * 2,000-author Oxy lookup. The newest `at` is the one fact every leader shares,
   * so due-ness is read from it; the timer only decides how often to ASK, which
   * is why it ticks every {@link FOLLOWER_SNAPSHOT_CHECK_INTERVAL_MS} and not every
   * six hours (a leader that arrived just after a sweep would otherwise wait up to
   * twelve).
   *
   * A failed read skips the tick rather than sweeping: sweeping blind is what
   * this replaced.
   */
  async runSnapshotSweepIfDue(now: number = Date.now()): Promise<boolean> {
    let last: Date | null;
    try {
      last = await this.lastSweepAt();
    } catch (error) {
      logger.warn('[FollowerSnapshotJob] could not read the last sweep time; skipping this tick', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    if (last && now - last.getTime() < FOLLOWER_SNAPSHOT_INTERVAL_MS) {
      logger.debug('[FollowerSnapshotJob] last sweep is recent; not due', { lastSweepAt: last.toISOString() });
      return false;
    }
    await this.runSnapshotSweep();
    return true;
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
