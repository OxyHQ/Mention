/**
 * `moderation_events` — the webhook dedupe store.
 *
 * `@oxyhq/crowdsource-express` defaults to an in-process store and says exactly
 * when that is not enough: two instances behind a load balancer each keep their
 * own, so a redelivery landing on the other instance is not deduplicated. Mention
 * runs several ECS tasks behind one ALB, so this is that case.
 *
 * ## The insert IS the claim
 *
 * `id` is the webhook event id and it is the primary key, so the conflict is not
 * an error condition to work around — it is the answer "somebody else has this
 * event". In Mongo that answer arrived as a duplicate-key ERROR that had to be
 * recognised by code (`code === 11000`) and separated from every other failure;
 * here `ON CONFLICT DO NOTHING … RETURNING` gives it as a VALUE, so the two are
 * no longer distinguished by inspecting an exception.
 *
 * That distinction is the load-bearing one. A lost connection or a failover is
 * NOT "already processed": it has to propagate so the middleware answers non-2xx
 * and the event stays on the sender's retry schedule. Swallowing it would answer
 * 200 and retire a decision nobody ever handled — and the Mongo shape made that
 * one mis-widened catch away.
 */

import { eq } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { MODERATION_EVENT_RETENTION_SECONDS, moderationEvents } from '../schema/moderation';

/**
 * Take the claim on an event id.
 *
 * @returns `true` when THIS call took it, `false` when it was already held. A
 *   thrown error is neither — it means the store could not answer, and the caller
 *   must let it propagate rather than treat it as "already processed".
 */
export async function claimModerationEvent(
  eventId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = new Date();
  const inserted = await db
    .insert(moderationEvents)
    .values({
      id: eventId,
      state: 'claimed',
      receivedAt: now,
      expiresAt: new Date(now.getTime() + MODERATION_EVENT_RETENTION_SECONDS * 1_000),
    })
    .onConflictDoNothing({ target: moderationEvents.id })
    .returning({ id: moderationEvents.id });

  return inserted.length === 1;
}

/**
 * Complete a claimed event's audit row and mark it queued for processing.
 *
 * The middleware already CLAIMED this id by inserting the row, so this is an
 * update, never an upsert — an id with no row means the claim was released and
 * the caller has no business completing it.
 */
export async function markModerationEventQueued(
  input: {
    eventId: string;
    type: string;
    caseId?: string;
    decision: unknown;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(moderationEvents)
    .set({
      type: input.type,
      caseId: input.caseId ?? null,
      payload: { caseId: input.caseId, decision: input.decision },
      state: 'queued',
      queuedAt: new Date(),
    })
    .where(eq(moderationEvents.id, input.eventId));
}

/**
 * Record an event there is nothing to do about.
 *
 * No outbox row, because no work — but the row is kept, because "did CrowdSource
 * tell us about this case, and when" is the first question asked when a report
 * looks stuck, and it has to be answerable.
 */
export async function markModerationEventIgnored(
  input: { eventId: string; type: string; caseId?: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(moderationEvents)
    .set({
      type: input.type,
      ...(input.caseId === undefined ? {} : { caseId: input.caseId }),
      state: 'ignored',
    })
    .where(eq(moderationEvents.id, input.eventId));
}

/**
 * Give the claim back so a redelivery can be processed.
 *
 * Called when the handler THROWS. Recording an id and never releasing it would
 * make a transient failure permanent and lose a decision silently.
 */
export async function releaseModerationEvent(
  eventId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.delete(moderationEvents).where(eq(moderationEvents.id, eventId));
}
