import mongoose, { type ClientSession } from 'mongoose';
import ModerationEvent from '../../models/ModerationEvent';
import {
  decisionApplyEventId,
  enqueueModerationOutboxEvent,
} from './ModerationOutboxService';

/**
 * What happens between "a signed decision arrived" and "2xx".
 *
 * §10.8: answer quickly and queue the processing. So exactly two writes happen
 * here, in ONE transaction — the event's audit row is completed and a durable
 * `decision.apply` event is created — and the dispatcher does the rest.
 *
 * The transaction is what makes the dedupe safe. The middleware has already
 * claimed the event id by inserting the row (see `moderationEventStore.ts`); if
 * completing that row and queueing the work were two operations, a crash between
 * them would leave an event that is permanently deduplicated with no work queued —
 * a decision silently lost, with a row that says it arrived. Committing both
 * together means the only two possible outcomes are "recorded and queued" or
 * "neither", and "neither" releases the claim and gets redelivered.
 */

const TRANSACTION_OPTIONS = {
  readPreference: 'primary' as const,
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const },
};

async function inTransaction(
  operation: (session: ClientSession) => Promise<void>,
): Promise<void> {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await operation(session);
    }, TRANSACTION_OPTIONS);
  } finally {
    await session.endSession();
  }
}

export interface RecordDecisionEventInput {
  eventId: string;
  type: string;
  caseId: string;
  /**
   * The decision as delivered.
   *
   * `unknown`, deliberately. It is stored whole and parsed against the published
   * contract by the worker that acts on it — §10.11 makes these payloads loose, and
   * validating here would mean an event whose shape this deployment does not
   * recognise yet is refused at the door and retried until it dead-letters, instead
   * of being kept until the code catches up.
   */
  decision: unknown;
}

/** Record a decision-bearing event and queue its application. */
export async function recordDecisionEvent(input: RecordDecisionEventInput): Promise<void> {
  await inTransaction(async (session) => {
    const now = new Date();
    await ModerationEvent.updateOne(
      { _id: input.eventId },
      {
        $set: {
          type: input.type,
          caseId: input.caseId,
          payload: { caseId: input.caseId, decision: input.decision },
          state: 'queued',
          queuedAt: now,
          updatedAt: now,
        },
      },
      { session },
    );

    await enqueueModerationOutboxEvent(
      {
        eventId: decisionApplyEventId(input.eventId),
        kind: 'decision.apply',
        payload: {
          eventId: input.eventId,
          caseId: input.caseId,
          decision: input.decision,
        },
      },
      session,
    );
  });
}

/**
 * Record an event there is nothing to do about.
 *
 * `case.created`, `case.escalated`, `case.closed` and any type a newer CrowdSource
 * introduces. No outbox row, because no work — but the row is kept, because "did
 * CrowdSource tell us about this case, and when" is the first question asked when a
 * report looks stuck, and it has to be answerable.
 */
export async function recordIgnoredEvent(input: {
  eventId: string;
  type: string;
  caseId?: string;
}): Promise<void> {
  const now = new Date();
  await ModerationEvent.updateOne(
    { _id: input.eventId },
    {
      $set: {
        type: input.type,
        ...(input.caseId === undefined ? {} : { caseId: input.caseId }),
        state: 'ignored',
        updatedAt: now,
      },
    },
  );
}
