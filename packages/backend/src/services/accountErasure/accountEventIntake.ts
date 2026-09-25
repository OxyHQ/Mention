/**
 * Where a VERIFIED account event becomes durable work. Shared by the webhook,
 * the reconciliation sweep and the operator script, so all three dedupe the same
 * way (on the event id) and schedule the same job.
 *
 * Order: record, then enqueue. The row commits first, so when the webhook answers
 * 202 the event cannot be lost. If the enqueue fails (Redis down), the row stays
 * `pending` and the reconciliation sweep runs it; that is why an enqueue failure
 * is logged and swallowed rather than turned into a non-2xx that would make Oxy
 * redeliver an event Mention already holds.
 */

import { logger } from '../../utils/logger';
import { enqueueAccountErasure } from '../../queue/producers';
import {
  recordAccountErasureRequest,
  type AccountErasureRow,
} from '../../db/accountErasures/accountErasureRepository';
import type { AccountErasureSource } from '../../db/schema/accountErasures';
import type { OxyAccountEvent } from './oxyAccountEvents';
import { processAccountErasure } from './AccountErasureService';

const LOG_PREFIX = '[AccountErasure]';

export interface IntakeResult {
  /** False when this event id was already recorded (a redelivery or an overlap). */
  inserted: boolean;
  status: AccountErasureRow['status'];
}

/**
 * Schedule the erasure recorded under `row`. With no queue (no Redis: local dev,
 * tests, a degraded boot) it runs in the background of this process instead;
 * the lease still makes that single-flight.
 */
export async function scheduleAccountErasure(row: AccountErasureRow): Promise<void> {
  if (row.status === 'completed') return;
  try {
    if (await enqueueAccountErasure({ eventId: row.eventId }, row.attempts)) return;
  } catch (error) {
    logger.warn(`${LOG_PREFIX} enqueue failed; the reconciliation sweep will run it`, {
      eventId: row.eventId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  void processAccountErasure(row.eventId).catch(() => {
    // Recorded on the ledger row by processAccountErasure; the sweep retries it.
  });
}

/** Record a verified event and schedule its erasure. */
export async function acceptAccountEvent(
  event: OxyAccountEvent,
  source: AccountErasureSource,
): Promise<IntakeResult> {
  const occurredAt = new Date(event.occurredAt);
  const { inserted, row } = await recordAccountErasureRequest({
    eventId: event.eventId,
    oxyUserId: event.userId,
    source,
    reason: event.type,
    occurredAt: Number.isNaN(occurredAt.getTime()) ? null : occurredAt,
    retained: event.retained,
    username: event.username,
  });
  logger.info(`${LOG_PREFIX} account event recorded`, {
    eventId: event.eventId,
    source,
    inserted,
    status: row.status,
  });
  await scheduleAccountErasure(row);
  return { inserted, status: row.status };
}
