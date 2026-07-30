import { config } from '../../config';
import { logger } from '../../utils/logger';
import { reconcileModerationReports } from './ModerationReconciliation';

/**
 * The reconciliation sweep, on a timer.
 *
 * Leader-gated — started from `startSchedulers` in `server.ts`, which only the elected
 * leader runs. Unlike the outbox dispatcher, whose per-event lease makes it safe on
 * every task, this sweep scans and counts across the whole collection; running it on
 * every task would multiply that work by the task count for no benefit.
 *
 * Long interval on purpose. It is a safety net for divergences the durable path is
 * supposed to prevent, not a delivery mechanism — a report that needs this sweep to be
 * delivered is already a report something went wrong with.
 */
const RECONCILIATION_INTERVAL_MS = 15 * 60 * 1_000;

export class ModerationReconciliationJob {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private running = false;

  start(): void {
    if (this.running) return;
    if (!config.crowdSource.enabled) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, RECONCILIATION_INTERVAL_MS);
    this.timer.unref?.();
    logger.info('[CrowdSource] reconciliation job started', {
      intervalMs: RECONCILIATION_INTERVAL_MS,
    });
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (!this.running || this.inFlight) return;
    const work = reconcileModerationReports()
      .then(() => undefined)
      .catch((error: unknown) => {
        logger.error('[CrowdSource] reconciliation sweep failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.inFlight === work) this.inFlight = null;
      });
    this.inFlight = work;
    await work;
  }
}

export const moderationReconciliationJob = new ModerationReconciliationJob();
