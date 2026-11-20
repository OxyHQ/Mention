import { logger } from '../utils/logger';
import { retryFailedClarityJobSyncs } from './clarityJobsAdapter';

/**
 * Retries failed Clarity job syncs on a timer, so a job nobody opens still
 * reaches Clarity's index once Clarity is back.
 *
 * Leader-gated: started from `startSchedulers`, which only the elected leader
 * runs, so two tasks never re-ingest the same job at once. Which jobs are due,
 * the backoff and the attempt cap live in `listFailedClaritySyncs`; an idle
 * tick is one indexed read (`mention_jobs_clarity_sync_status_idx`).
 */
const CLARITY_SYNC_RETRY_INTERVAL_MS = 10 * 60 * 1_000;

class ClaritySyncRetryJob {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private running = false;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, CLARITY_SYNC_RETRY_INTERVAL_MS);
    this.timer.unref?.();
    logger.info('[ClaritySyncRetryJob] started', { intervalMs: CLARITY_SYNC_RETRY_INTERVAL_MS });
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One retry pass. Never throws; a pass still running makes the next tick a no-op. */
  async tick(): Promise<void> {
    if (!this.running || this.inFlight) return;
    const work = retryFailedClarityJobSyncs()
      .then((attempted) => {
        if (attempted > 0) logger.info('[ClaritySyncRetryJob] retried failed syncs', { attempted });
      })
      .catch((error: unknown) => {
        logger.error('[ClaritySyncRetryJob] retry pass failed', {
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

export const claritySyncRetryJob = new ClaritySyncRetryJob();
