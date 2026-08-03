import { config } from '../../config';
import { logger } from '../../utils/logger';
import { applyDecisionOutboxEvent } from './ModerationDecisionWorker';
import { deliverReportOutboxEvent } from './ModerationDeliveryWorker';
import type { ModerationOutboxEvent } from '../../db/moderation/moderationOutboxRepository';
import { dispatchModerationOutbox } from './ModerationOutboxService';

/**
 * The loop that drains the moderation outbox.
 *
 * Deliberately the same shape as `EngagementOutboxDispatcher`: a bounded interval, one
 * batch in flight at a time, an abort signal that stops claiming new work but lets the
 * event already being handled reach a durable state.
 *
 * It is NOT leader-gated, and that is a property of the claim rather than an
 * oversight. Every event is taken under a lease with an owner check, so N tasks
 * draining the same collection simply share the work — and a task dying mid-delivery
 * has its lease expire and its event reclaimed, which a single leader would not give
 * us.
 *
 * `CROWDSOURCE_ENABLED` gates the LOOP, never the durable record. Reports taken while
 * the integration is off keep their outbox rows and deliver when it is switched on;
 * running the loop instead would count attempts against a deployment that has nowhere
 * to send anything and dead-letter the backlog it was supposed to preserve.
 */

/** Route an event to the worker that owns its kind. */
export async function handleModerationOutboxEvent(
  event: ModerationOutboxEvent,
): Promise<void> {
  switch (event.kind) {
    case 'report.submit':
      await deliverReportOutboxEvent(event);
      return;
    case 'decision.apply':
      await applyDecisionOutboxEvent(event);
      return;
  }
}

export class ModerationOutboxDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private running = false;

  start(): void {
    if (this.running) return;
    if (!config.crowdSource.enabled) {
      logger.info('[CrowdSource] outbox dispatcher not started: CROWDSOURCE_ENABLED=false');
      return;
    }
    this.running = true;
    this.abortController = new AbortController();
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, config.crowdSource.outboxPollIntervalMs);
    this.timer.unref?.();
    logger.info('[CrowdSource] outbox dispatcher started', {
      intervalMs: config.crowdSource.outboxPollIntervalMs,
      batchSize: config.crowdSource.outboxBatchSize,
      enforcementMode: config.crowdSource.enforcementMode,
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    const controller = this.abortController;
    controller?.abort();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.inFlight;
    if (this.abortController === controller) {
      this.abortController = null;
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    if (this.inFlight) return this.inFlight;
    const work = dispatchModerationOutbox({
      handler: handleModerationOutboxEvent,
      batchSize: config.crowdSource.outboxBatchSize,
      signal: this.abortController?.signal,
    })
      .then(({ processed, failed, deadLettered }) => {
        if (processed > 0 || failed > 0) {
          logger.info('[CrowdSource] outbox batch complete', {
            processed,
            failed,
            deadLettered,
          });
        }
      })
      .catch((error: unknown) => {
        // Claim/database failures happen outside the per-event retry block. Keep the
        // interval alive and avoid an unhandled rejection.
        logger.error('[CrowdSource] outbox tick failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.inFlight === work) this.inFlight = null;
      });
    this.inFlight = work;
    return work;
  }
}

export const moderationOutboxDispatcher = new ModerationOutboxDispatcher();
