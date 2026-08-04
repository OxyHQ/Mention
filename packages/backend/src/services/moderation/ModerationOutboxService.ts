import { randomUUID } from 'crypto';
import {
  claimModerationOutboxEvent,
  completeModerationOutboxEvent,
  releaseModerationOutboxEvent,
  renewModerationOutboxEvent,
  type ModerationOutboxEvent,
} from '../../db/moderation/moderationOutboxRepository';
import { logger } from '../../utils/logger';

/**
 * Claiming, completing and failing moderation outbox events.
 *
 * The at-least-once contract is the same one `EngagementOutboxService` states:
 * handlers MUST make every downstream effect idempotent using the event id,
 * because an expired lease is reclaimable and a worker can die mid-delivery.
 *
 * What differs is where retrying stops. A delivery failure the SDK marks as not
 * retryable is a defect in the payload, not a blip — see
 * {@link failModerationOutboxEvent}.
 *
 * ## What lives here and what lives in the repository
 *
 * The ROW transitions — claim, complete, renew, release — are
 * `db/moderation/moderationOutboxRepository.ts`. What is left here is the POLICY
 * that decides which transition to ask for: whether an error can ever succeed on
 * a retry, how long to wait before the next attempt, when to stop trying at all,
 * and the lease heartbeat that keeps a long delivery's claim alive. Splitting it
 * that way is what lets the transitions be tested against real rows without a
 * delivery worker, and the policy be tested without a database.
 *
 * `enqueueModerationOutboxEvent` is deliberately NOT re-exported from here.
 * It is the one writer of the table and it demands a transaction; callers import
 * it from the repository so the guard is visible at the call site.
 */

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 500;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1_000;
const MIN_LEASE_RENEW_INTERVAL_MS = 250;

/**
 * Attempts after which a retryable failure is treated as permanent.
 *
 * Generous: a retryable failure means CrowdSource might still accept this exact
 * payload, and with `MAX_BACKOFF_MS` capped at six hours this is several days of
 * trying. A report that has not landed by then needs a human, not another
 * attempt.
 */
const MAX_RETRYABLE_ATTEMPTS = 25;

/**
 * The event id for delivering a report.
 *
 * Derived from the report, not from the request: a transaction retry or two
 * concurrent duplicate submissions upsert the SAME event rather than queueing two
 * deliveries. There is exactly one delivery event per report for the life of the
 * report, which is also what makes the CrowdSource-side idempotency key stable.
 */
export function reportSubmitEventId(reportId: string): string {
  return `moderation:report.submit:${reportId}`;
}

/**
 * The event id for applying an inbound decision (Appendix D: "Mention inbound
 * event → eventId").
 *
 * The webhook event id is the key, so a redelivery of the same event can never
 * queue the work twice even if the dedupe claim were somehow released.
 */
export function decisionApplyEventId(eventId: string): string {
  return `moderation:decision.apply:${eventId}`;
}

function nextAttemptAt(attempts: number, now: Date): Date {
  const exponent = Math.max(0, Math.min(attempts - 1, 20));
  return new Date(now.getTime() + Math.min(1_000 * 2 ** exponent, MAX_BACKOFF_MS));
}

/**
 * A failure that says whether trying the same payload again could ever work.
 *
 * Every error `@oxyhq/crowdsource` throws carries `retryable`, which is the only
 * thing a delivery worker needs from it. Anything else — a bug in this code, a
 * Mongo error — is treated as retryable, because assuming a defect is permanent
 * is how a recoverable outage becomes lost moderation work.
 */
export function isRetryableDeliveryError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'retryable' in error) {
    const retryable: unknown = (error as { retryable: unknown }).retryable;
    if (typeof retryable === 'boolean') return retryable;
  }
  return true;
}

export interface ModerationOutboxFailure {
  released: boolean;
  deadLettered: boolean;
}

/**
 * Release a failed claim, with backoff — or stop.
 *
 * Stopping is not an optimisation. A 409 means this `externalReportId` already
 * exists at CrowdSource with a different body, and no number of retries turns two
 * payloads into one report; a 422 means the envelope is not processable. Both need
 * the payload to change, so they become `dead_letter` immediately and stay
 * visible with their error rather than accumulating attempts nobody reads.
 */
export async function failModerationOutboxEvent(
  event: Pick<ModerationOutboxEvent, '_id' | 'attempts'>,
  leaseOwner: string,
  error: unknown,
  now: Date = new Date(),
): Promise<ModerationOutboxFailure> {
  const message = error instanceof Error ? error.message : String(error);
  const retryable = isRetryableDeliveryError(error);
  const deadLettered = !retryable || event.attempts >= MAX_RETRYABLE_ATTEMPTS;

  const released = await releaseModerationOutboxEvent({
    eventId: event._id,
    leaseOwner,
    deadLettered,
    availableAt: deadLettered ? now : nextAttemptAt(event.attempts, now),
    error: message,
    now,
  });
  return { released, deadLettered };
}

export type ModerationOutboxHandler = (event: ModerationOutboxEvent) => Promise<void>;

interface LeaseHeartbeatResult {
  lost: boolean;
  error?: unknown;
}

function startLeaseHeartbeat(options: {
  eventId: string;
  leaseOwner: string;
  leaseMs: number;
}): { stop: () => Promise<LeaseHeartbeatResult> } {
  const renewIntervalMs = Math.max(
    MIN_LEASE_RENEW_INTERVAL_MS,
    Math.floor(options.leaseMs / 3),
  );
  let stopped = false;
  let lost = false;
  let renewalError: unknown;
  let renewalInFlight: Promise<void> | null = null;

  const renew = (): void => {
    if (stopped || lost || renewalInFlight) return;
    const renewal = renewModerationOutboxEvent(
      options.eventId,
      options.leaseOwner,
      options.leaseMs,
    )
      .then((stillOwner) => {
        if (!stillOwner) lost = true;
      })
      .catch((error: unknown) => {
        lost = true;
        renewalError = error;
      })
      .finally(() => {
        if (renewalInFlight === renewal) renewalInFlight = null;
      });
    renewalInFlight = renewal;
  };

  const timer = setInterval(renew, renewIntervalMs);
  timer.unref?.();

  return {
    async stop(): Promise<LeaseHeartbeatResult> {
      stopped = true;
      clearInterval(timer);
      await renewalInFlight;
      return { lost, error: renewalError };
    },
  };
}

export interface ModerationDispatchResult {
  processed: number;
  failed: number;
  deadLettered: number;
}

/** Drain up to `batchSize` due events. Bounded, at-least-once, lease-protected. */
export async function dispatchModerationOutbox(options: {
  handler: ModerationOutboxHandler;
  leaseOwner?: string;
  batchSize?: number;
  leaseMs?: number;
  signal?: AbortSignal;
}): Promise<ModerationDispatchResult> {
  const leaseOwner = options.leaseOwner ?? `moderation:${process.pid}:${randomUUID()}`;
  const batchSize = Math.min(Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE), MAX_BATCH_SIZE);
  const leaseMs = Math.max(1_000, options.leaseMs ?? DEFAULT_LEASE_MS);
  let processed = 0;
  let failed = 0;
  let deadLettered = 0;

  for (let index = 0; index < batchSize; index += 1) {
    // Shutdown stops claiming new work but lets the event already in flight reach
    // a durable state.
    if (options.signal?.aborted) break;

    const event = await claimModerationOutboxEvent({ leaseOwner, leaseMs });
    if (!event) break;

    const heartbeat = startLeaseHeartbeat({ eventId: event._id, leaseOwner, leaseMs });
    let deliveryError: unknown;
    try {
      await options.handler(event);
    } catch (error: unknown) {
      deliveryError = error;
    }

    // No completion/failure transition may race an owner-checked renewal.
    const heartbeatResult = await heartbeat.stop();
    if (heartbeatResult.lost) {
      failed += 1;
      logger.warn('[ModerationOutbox] event lease lost during delivery', {
        eventId: event._id,
        kind: event.kind,
        attempts: event.attempts,
        error:
          heartbeatResult.error instanceof Error
            ? heartbeatResult.error.message
            : heartbeatResult.error
              ? String(heartbeatResult.error)
              : 'owner or lease expiry changed',
      });
      continue;
    }

    if (deliveryError) {
      failed += 1;
      const outcome = await failModerationOutboxEvent(event, leaseOwner, deliveryError);
      const context = {
        eventId: event._id,
        kind: event.kind,
        attempts: event.attempts,
        error: deliveryError instanceof Error ? deliveryError.message : String(deliveryError),
      };
      // A dead letter is moderation work that will not happen without a human, so
      // it must not be discoverable only by reading a warn-level log line.
      if (outcome.deadLettered) {
        deadLettered += 1;
        logger.error('[ModerationOutbox] event dead-lettered', context);
      } else {
        logger.warn('[ModerationOutbox] event delivery failed, will retry', context);
      }
      if (!outcome.released) {
        logger.warn('[ModerationOutbox] lease lost before failure release', {
          eventId: event._id,
          kind: event.kind,
        });
      }
      continue;
    }

    const completed = await completeModerationOutboxEvent(event._id, leaseOwner);
    if (!completed) {
      failed += 1;
      logger.warn('[ModerationOutbox] lease lost before completion', {
        eventId: event._id,
        kind: event.kind,
        attempts: event.attempts,
      });
      continue;
    }
    processed += 1;
  }

  return { processed, failed, deadLettered };
}
