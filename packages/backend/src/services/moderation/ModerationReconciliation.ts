import ModerationOutbox from '../../models/ModerationOutbox';
import Report from '../../models/Report.model';
import { logger } from '../../utils/logger';
import {
  enqueueModerationOutboxEvent,
  reportSubmitEventId,
} from './ModerationOutboxService';
import mongoose from 'mongoose';

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

const TRANSACTION_OPTIONS = {
  readPreference: 'primary' as const,
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const },
};

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
  const pending = await Report.find({ localStatus: { $in: ['queued', 'delivery_failed'] } })
    .select('_id localStatus')
    .sort({ createdAt: 1 })
    .limit(batchSize)
    .lean<{ _id: mongoose.Types.ObjectId }[]>();

  for (const report of pending) {
    const reportId = String(report._id);
    const eventId = reportSubmitEventId(reportId);
    const event = await ModerationOutbox.findById(eventId)
      .select('status')
      .lean<{ status: string } | null>();

    if (event?.status === 'dead_letter') {
      result.deadLettered += 1;
      continue;
    }
    if (event) continue;

    /**
     * A transaction for a single upsert, for consistency with intake rather than for
     * atomicity: `enqueueModerationOutboxEvent` requires a session precisely so that
     * no path in this codebase can write an outbox event outside one. A signature that
     * made the session optional would be the crack the next caller slips through.
     */
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        /**
         * No `urgency`, and re-measuring one here would be a mistake rather than a
         * completeness fix. A sweep re-derives work from the report, and the
         * distribution facts it could read now are the ones at RECONCILIATION time
         * — a different envelope from the one the lost event would have composed,
         * which is exactly what the ingress fingerprint treats as §10.5's payload
         * conflict. A report re-derived here therefore triages at the bottom of the
         * reach band, which is the price of having lost its event.
         */
        await enqueueModerationOutboxEvent(
          { eventId, kind: 'report.submit', payload: { reportId } },
          session,
        );
      }, TRANSACTION_OPTIONS);
      result.requeued += 1;
    } finally {
      await session.endSession();
    }
  }

  result.awaitingDecision = await Report.countDocuments({
    localStatus: 'submitted',
    submittedAt: { $lt: new Date(now.getTime() - STALE_SUBMITTED_HOURS * 60 * 60 * 1_000) },
  });
  result.localOnly = await Report.countDocuments({ localStatus: 'received' });

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
