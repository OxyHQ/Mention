import { getDb } from '../../db/postgres';
import {
  enqueueModerationOutboxEvent,
  readModerationOutboxStatus,
} from '../../db/moderation/moderationOutboxRepository';
import {
  countLocalOnlyReports,
  countReportsAwaitingDecision,
  findReportsAwaitingDelivery,
} from '../../db/moderation/reportRepository';
import { logger } from '../../utils/logger';
import { reportSubmitEventId } from './ModerationOutboxService';

/**
 * Finding the reports the pipeline lost sight of (§14.4's `ModerationReconciliation`).
 *
 * The outbox makes delivery durable, not infallible. Four divergences are possible and
 * none of them announces itself:
 *
 * 1. A report that should have a delivery event and does not — one whose event was
 *    dropped by a retention TTL while the deployment was down for longer than the
 *    retention window, or one whose enqueue was lost to an operator's intervention.
 * 2. A report stuck at `delivery_failed` whose outbox event has been dead-lettered.
 *    That one is not re-queued: something about the payload has to change first, and
 *    re-queueing it would spin. It is COUNTED, because the count is the alert.
 * 3. A report `submitted` long ago whose case never came back. Nothing to do locally —
 *    the decision is CrowdSource's to publish — but a rising count is how a broken
 *    webhook endpoint or a rotated secret becomes visible before somebody notices a
 *    quiet moderation queue.
 * 4. A report that was never going anywhere: `received`, because its type has no
 *    subject provider (a live room), or because it predates the integration. This is
 *    the one divergence that is not a fault, so it is counted and NEVER re-queued —
 *    re-deriving a delivery event for a report nothing can describe would send it
 *    straight to the dead-letter queue and turn a deliberate local-only report into a
 *    recurring alert. Counting it is still worth doing: it is the only number that
 *    makes "reports stored here that no jury will ever see" visible at all, and that
 *    is precisely the cost of accepting them.
 *
 * A sweep only ever RE-DERIVES work from the reports; it never invents any. Everything
 * it enqueues uses the same deterministic event id as the original, so a report that
 * did have an event is untouched rather than delivered twice.
 */

const DEFAULT_BATCH_SIZE = 200;
/** How long a `submitted` report may wait for a decision before it is worth counting. */
const STALE_SUBMITTED_HOURS = 72;

export interface ModerationReconciliationResult {
  /** Reports that had no delivery event and now have one. */
  requeued: number;
  /** Reports whose delivery event is dead-lettered. Needs a human. */
  deadLettered: number;
  /** Reports submitted long ago with no decision yet. */
  awaitingDecision: number;
  /** Reports stored with no route to review at all. Never re-queued. */
  localOnly: number;
}

/**
 * One sweep. Bounded, idempotent, safe to run on every task.
 *
 * Reads `queued` and `delivery_failed` reports oldest-first — the index on
 * `{ localStatus, createdAt }` exists for this query — and re-enqueues only those with
 * no outbox event at all.
 */
export async function reconcileModerationReports(
  options: { batchSize?: number; now?: Date } = {},
): Promise<ModerationReconciliationResult> {
  const batchSize = Math.min(Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE), 1_000);
  const now = options.now ?? new Date();
  const result: ModerationReconciliationResult = {
    requeued: 0,
    deadLettered: 0,
    awaitingDecision: 0,
    localOnly: 0,
  };

  /**
   * `queued` and `delivery_failed` only. `received` is excluded deliberately and the
   * omission is the safety property, not an oversight: those reports have no subject
   * provider, so an event re-derived for one would fail as
   * `ModerationSubjectUnsupportedError` on its first attempt and dead-letter. They are
   * counted below instead.
   */
  const pending = await findReportsAwaitingDelivery(batchSize);

  for (const report of pending) {
    const eventId = reportSubmitEventId(report.id);
    const status = await readModerationOutboxStatus(eventId);

    if (status === 'dead_letter') {
      result.deadLettered += 1;
      continue;
    }
    // `undefined` means NO delivery event exists, which is the one state this
    // sweep acts on. Every other status means one is already there.
    if (status !== undefined) continue;

    /**
     * A transaction for a single upsert, for consistency with intake rather than
     * for atomicity: `enqueueModerationOutboxEvent` requires a transaction handle
     * precisely so that no path in this codebase can write an outbox event outside
     * one — and it CHECKS, because the root connection satisfies the parameter
     * type. A signature that made it optional would be the crack the next caller
     * slips through.
     */
    await getDb().transaction(async (tx) => {
      await enqueueModerationOutboxEvent(
        { eventId, kind: 'report.submit', payload: { reportId: report.id } },
        tx,
      );
    });
    result.requeued += 1;
  }

  result.awaitingDecision = await countReportsAwaitingDecision(
    new Date(now.getTime() - STALE_SUBMITTED_HOURS * 60 * 60 * 1_000),
  );
  result.localOnly = await countLocalOnlyReports();

  if (result.requeued > 0 || result.deadLettered > 0) {
    logger.warn('[CrowdSource] reconciliation found divergence', result);
  } else if (result.awaitingDecision > 0 || result.localOnly > 0) {
    logger.info('[CrowdSource] reports with no decision to apply', {
      awaitingDecision: result.awaitingDecision,
      olderThanHours: STALE_SUBMITTED_HOURS,
      localOnly: result.localOnly,
    });
  }

  return result;
}
