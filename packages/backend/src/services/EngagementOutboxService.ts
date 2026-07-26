import { randomUUID } from 'crypto';
import type { ClientSession } from 'mongoose';
import EngagementOutbox, {
  ENGAGEMENT_OUTBOX_RETENTION_SECONDS,
  type EngagementOutboxKind,
  type EngagementOutboxPayload,
  type IEngagementOutbox,
} from '../models/EngagementOutbox';
import { logger } from '../utils/logger';

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const ORDERING_DEFERRAL_MS = 1_000;
const MIN_LEASE_RENEW_INTERVAL_MS = 250;

export interface EngagementOutboxEvent {
  _id: string;
  kind: EngagementOutboxKind;
  revision: number;
  payload: EngagementOutboxPayload;
  attempts: number;
  availableAt: Date;
  leaseOwner?: string;
  leaseUntil?: Date;
  expiresAt: Date;
  createdAt: Date;
}

export interface EnqueueEngagementEventInput {
  kind: EngagementOutboxKind;
  relationshipId: string;
  revision: number;
  payload: EngagementOutboxPayload;
}

function normalizeRevision(revision: number): number {
  const truncated = Math.trunc(revision);
  return Number.isSafeInteger(truncated) && truncated > 0 ? truncated : 1;
}

/**
 * Derive a stable id from the relationship transition, not the HTTP request.
 * Mongo transaction retries and concurrent duplicate requests therefore upsert
 * the same event. `revision` makes repeated like↔downvote transitions distinct.
 */
export function engagementOutboxEventId(
  kind: EngagementOutboxKind,
  relationshipId: string,
  revision: number,
): string {
  const normalizedRevision = normalizeRevision(revision);
  return `engagement:${kind}:${relationshipId}:v${normalizedRevision}`;
}

/** Insert the event with the caller's Mongo session. Failure aborts the command. */
export async function enqueueEngagementOutboxEvent(
  input: EnqueueEngagementEventInput,
  session: ClientSession,
): Promise<string> {
  const eventId = engagementOutboxEventId(
    input.kind,
    input.relationshipId,
    input.revision,
  );
  const revision = normalizeRevision(input.revision);
  const now = new Date();
  await EngagementOutbox.updateOne(
    { _id: eventId },
    {
      $setOnInsert: {
        _id: eventId,
        kind: input.kind,
        revision,
        payload: input.payload,
        status: 'pending',
        attempts: 0,
        availableAt: now,
        expiresAt: new Date(
          now.getTime() + ENGAGEMENT_OUTBOX_RETENTION_SECONDS * 1_000,
        ),
        createdAt: now,
        updatedAt: now,
      },
    },
    { upsert: true, session },
  );
  return eventId;
}

function claimFilter(now: Date, eventId?: string): Record<string, unknown> {
  return {
    ...(eventId ? { _id: eventId } : {}),
    $or: [
      { status: 'pending', availableAt: { $lte: now } },
      { status: 'processing', leaseUntil: { $lte: now } },
    ],
  };
}

/**
 * Atomically claim one due event. An expired processing lease is reclaimable,
 * so a dead worker cannot strand the event forever.
 */
export async function claimEngagementOutboxEvent(options: {
  leaseOwner: string;
  eventId?: string;
  now?: Date;
  leaseMs?: number;
}): Promise<EngagementOutboxEvent | null> {
  const now = options.now ?? new Date();
  const leaseMs = Math.max(1_000, options.leaseMs ?? DEFAULT_LEASE_MS);
  const claimed = await EngagementOutbox.findOneAndUpdate(
    claimFilter(now, options.eventId),
    {
      $set: {
        status: 'processing',
        leaseOwner: options.leaseOwner,
        leaseUntil: new Date(now.getTime() + leaseMs),
        updatedAt: now,
      },
      $inc: { attempts: 1 },
      $unset: { lastError: '' },
    },
    {
      new: true,
      sort: { createdAt: 1 },
    },
  )
    .select(
      '_id kind revision payload attempts availableAt leaseOwner leaseUntil expiresAt createdAt',
    )
    .lean<EngagementOutboxEvent | null>();

  return claimed;
}

async function hasEarlierUnprocessedRevision(
  event: EngagementOutboxEvent,
): Promise<boolean> {
  const earlier = await EngagementOutbox.exists({
    'payload.relationshipId': event.payload.relationshipId,
    revision: { $lt: event.revision },
    status: { $ne: 'processed' },
  });
  return Boolean(earlier);
}

/**
 * Return a claimed event to the queue without counting the claim as a delivery
 * attempt. A lower revision for the same relationship is still pending or
 * processing, so applying this transition now could resurrect a stale Like
 * after its Undo on another worker.
 */
async function deferOutOfOrderEvent(
  eventId: string,
  leaseOwner: string,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await EngagementOutbox.updateOne(
    {
      _id: eventId,
      status: 'processing',
      leaseOwner,
      leaseUntil: { $gt: now },
    },
    {
      $set: {
        status: 'pending',
        availableAt: new Date(now.getTime() + ORDERING_DEFERRAL_MS),
        updatedAt: now,
      },
      $inc: { attempts: -1 },
      $unset: {
        leaseOwner: '',
        leaseUntil: '',
      },
    },
  );
  return result.modifiedCount === 1;
}

/** Complete only the lease currently owned by this dispatcher. */
export async function completeEngagementOutboxEvent(
  eventId: string,
  leaseOwner: string,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await EngagementOutbox.updateOne(
    {
      _id: eventId,
      status: 'processing',
      leaseOwner,
      leaseUntil: { $gt: now },
    },
    {
      $set: {
        status: 'processed',
        processedAt: now,
        updatedAt: now,
      },
      $unset: {
        leaseOwner: '',
        leaseUntil: '',
        lastError: '',
      },
    },
  );
  return result.modifiedCount === 1;
}

/** Extend only a live lease still owned by this dispatcher. */
export async function renewEngagementOutboxEvent(
  eventId: string,
  leaseOwner: string,
  leaseMs: number,
  now: Date = new Date(),
): Promise<boolean> {
  const boundedLeaseMs = Math.max(1_000, leaseMs);
  const result = await EngagementOutbox.updateOne(
    {
      _id: eventId,
      status: 'processing',
      leaseOwner,
      leaseUntil: { $gt: now },
    },
    {
      $set: {
        leaseUntil: new Date(now.getTime() + boundedLeaseMs),
        updatedAt: now,
      },
    },
  );
  return result.matchedCount === 1;
}

function nextAttemptAt(attempts: number, now: Date): Date {
  const exponent = Math.max(0, Math.min(attempts - 1, 10));
  const delayMs = Math.min(1_000 * (2 ** exponent), MAX_BACKOFF_MS);
  return new Date(now.getTime() + delayMs);
}

/** Release a failed claim with bounded exponential backoff. */
export async function failEngagementOutboxEvent(
  event: Pick<EngagementOutboxEvent, '_id' | 'attempts'>,
  leaseOwner: string,
  error: unknown,
  now: Date = new Date(),
): Promise<boolean> {
  const message = error instanceof Error ? error.message : String(error);
  const result = await EngagementOutbox.updateOne(
    {
      _id: event._id,
      status: 'processing',
      leaseOwner,
      leaseUntil: { $gt: now },
    },
    {
      $set: {
        status: 'pending',
        availableAt: nextAttemptAt(event.attempts, now),
        lastError: message.slice(0, 2_000),
        updatedAt: now,
      },
      $unset: {
        leaseOwner: '',
        leaseUntil: '',
      },
    },
  );
  return result.modifiedCount === 1;
}

export type EngagementOutboxHandler = (
  event: EngagementOutboxEvent,
) => Promise<void>;

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
    const renewal = renewEngagementOutboxEvent(
      options.eventId,
      options.leaseOwner,
      options.leaseMs,
    )
      .then((stillOwner) => {
        if (!stillOwner) {
          lost = true;
        }
      })
      .catch((error) => {
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

/**
 * Reusable, bounded at-least-once dispatcher.
 *
 * Handlers MUST make each downstream write idempotent with `event._id`. The
 * concrete dispatcher uses strict notification/MTN/federation helpers that
 * surface persistence or enqueue failures. Relationship revisions are applied
 * in order even when several backend tasks claim work concurrently.
 */
export async function dispatchEngagementOutbox(options: {
  handler: EngagementOutboxHandler;
  leaseOwner?: string;
  batchSize?: number;
  leaseMs?: number;
  signal?: AbortSignal;
}): Promise<{ processed: number; failed: number }> {
  const leaseOwner = options.leaseOwner ?? `engagement:${process.pid}:${randomUUID()}`;
  const batchSize = Math.min(
    Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE),
    MAX_BATCH_SIZE,
  );
  const leaseMs = Math.max(1_000, options.leaseMs ?? DEFAULT_LEASE_MS);
  let processed = 0;
  let failed = 0;

  for (let index = 0; index < batchSize; index += 1) {
    // Shutdown stops claiming new work but lets the event already being handled
    // reach a durable processed/pending state.
    if (options.signal?.aborted) break;

    const event = await claimEngagementOutboxEvent({
      leaseOwner,
      leaseMs,
    });
    if (!event) break;

    if (await hasEarlierUnprocessedRevision(event)) {
      const deferred = await deferOutOfOrderEvent(event._id, leaseOwner);
      if (!deferred) {
        failed += 1;
        logger.warn('[EngagementOutbox] lease lost before ordering deferral', {
          eventId: event._id,
          kind: event.kind,
        });
      }
      continue;
    }

    const heartbeat = startLeaseHeartbeat({
      eventId: event._id,
      leaseOwner,
      leaseMs,
    });
    let deliveryError: unknown;
    try {
      await options.handler(event);
    } catch (error) {
      deliveryError = error;
    }

    // No completion/failure transition may race an owner-checked renewal.
    const heartbeatResult = await heartbeat.stop();
    if (heartbeatResult.lost) {
      failed += 1;
      logger.warn('[EngagementOutbox] event lease lost during delivery', {
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
      const released = await failEngagementOutboxEvent(
        event,
        leaseOwner,
        deliveryError,
      );
      logger.warn('[EngagementOutbox] event delivery failed', {
        eventId: event._id,
        kind: event.kind,
        attempts: event.attempts,
        error:
          deliveryError instanceof Error
            ? deliveryError.message
            : String(deliveryError),
      });
      if (!released) {
        logger.warn('[EngagementOutbox] lease lost before failure release', {
          eventId: event._id,
          kind: event.kind,
          attempts: event.attempts,
        });
      }
      continue;
    }

    const completed = await completeEngagementOutboxEvent(event._id, leaseOwner);
    if (!completed) {
      failed += 1;
      logger.warn('[EngagementOutbox] lease lost before completion', {
        eventId: event._id,
        kind: event.kind,
        attempts: event.attempts,
      });
      continue;
    }
    processed += 1;
  }

  return { processed, failed };
}

export type { IEngagementOutbox };
