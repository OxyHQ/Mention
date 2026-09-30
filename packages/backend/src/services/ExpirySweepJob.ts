/**
 * Expiry Sweep Job — runs the TTL registry in `db/expiry.ts` (OxyHQ/Mention#1187)
 *
 * The registry was ported, tested, and never scheduled, so every table in it
 * grew without bound. This is the schedule.
 *
 * Operational invariants (mirror the other schedulers):
 *  - Started ONLY by `startSchedulers()` on the elected leader, so one task
 *    sweeps and the deletes never race each other across the fleet.
 *  - Each target is swept in bounded batches (`@oxy.so/db/expiry`: 1000 rows ×
 *    50 batches), so the first run over a months-old backlog deletes 50k rows
 *    per table and leaves the rest for the next tick instead of holding one
 *    enormous delete open. At {@link EXPIRY_SWEEP_INTERVAL_MS} that drains the
 *    5.4M-row `author_follower_snapshots` backlog in under a day.
 *  - Targets run in sequence and each one's failure is caught and logged alone,
 *    so one broken table cannot keep the others from being reaped.
 *  - Re-entrancy guarded: a run that outlasts its interval makes the next tick
 *    a no-op rather than a second concurrent sweep.
 *  - Every timer is unref'd, so the job never keeps the process alive.
 */

import type { ExpirySweepResult } from '@oxy.so/db/expiry';
import { sweepExpiredRows } from '@oxy.so/db/expiry';
import { getTableName } from 'drizzle-orm';
import { SCHEDULED_EXPIRY_SWEEP_TARGETS, sweepProcessedEngagementOutbox } from '../db/expiry';
import { getDb } from '../db/postgres';
import { logger } from '../utils/logger';

/** Ten minutes: short enough to drain a backlog in hours, cheap when there is none. */
export const EXPIRY_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** Defer the first run so boot is never contended. 5 minutes. */
export const EXPIRY_SWEEP_START_DELAY_MS = 5 * 60 * 1000;

export class ExpirySweepJob {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startTimeout: ReturnType<typeof setTimeout> | null = null;
  private isRunning = false;
  private isSweeping = false;

  /** Start the leader-gated periodic sweep. Idempotent. */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.startTimeout = setTimeout(() => {
      this.startTimeout = null;
      void this.runSweep();
      this.interval = setInterval(() => {
        void this.runSweep();
      }, EXPIRY_SWEEP_INTERVAL_MS);
      this.interval.unref?.();
    }, EXPIRY_SWEEP_START_DELAY_MS);
    this.startTimeout.unref?.();

    logger.info('[ExpirySweepJob] started (leader-gated TTL sweep)');
  }

  /** Stop the sweep and cancel a pending first run. Idempotent. */
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
   * Sweep every scheduled target once. Never throws: each target's error is
   * logged and the run moves on. Returns what was swept, for the tests.
   */
  async runSweep(): Promise<ExpirySweepResult[]> {
    if (this.isSweeping) return [];
    this.isSweeping = true;
    const results: ExpirySweepResult[] = [];
    try {
      const db = getDb();
      const sweeps: Array<{ table: string; sweep: () => Promise<ExpirySweepResult> }> = [
        ...SCHEDULED_EXPIRY_SWEEP_TARGETS.map((target) => ({
          table: getTableName(target.table),
          sweep: () => sweepExpiredRows(db, target),
        })),
        { table: 'engagement_outbox', sweep: () => sweepProcessedEngagementOutbox(db) },
      ];

      for (const { table, sweep } of sweeps) {
        try {
          const result = await sweep();
          results.push(result);
          if (result.deleted > 0) {
            logger.info('[ExpirySweepJob] swept expired rows', {
              table: result.table,
              deleted: result.deleted,
              truncated: result.truncated,
            });
          }
        } catch (error) {
          logger.error('[ExpirySweepJob] sweep failed', { table, error });
        }
      }
    } catch (error) {
      logger.error('[ExpirySweepJob] run failed', error);
    } finally {
      this.isSweeping = false;
    }
    return results;
  }
}

export const expirySweepJob = new ExpirySweepJob();
