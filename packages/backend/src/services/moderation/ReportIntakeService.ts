import { REPORTED_TYPES } from '../../db/schema/moderation';
import { getDb } from '../../db/postgres';
import {
  findDuplicateReport,
  insertReport,
  type ReportCategory,
  type ReportRecord,
  type ReportedType,
} from '../../db/moderation/reportRepository';
import { enqueueModerationOutboxEvent } from '../../db/moderation/moderationOutboxRepository';
import { reportSubmitEventId } from './ModerationOutboxService';
import { subjectProviderFor } from './subjects/registry';

/**
 * Storing a report and, when there is somewhere to send it, the promise to deliver
 * it — in one operation.
 *
 * This is §7.1, and it is the only thing in the integration that a user waits for.
 * A 201 from `POST /reports` means the report row and its outbox event committed
 * together. It does NOT mean CrowdSource accepted anything — CrowdSource may be
 * unreachable, mid-deploy or not yet configured, and the reporter is told their
 * report was received either way, because it was.
 *
 * The transaction is the whole mechanism. Two writes outside one would give two
 * failure modes that are both silent: a report with no delivery event (the report
 * exists, nothing will ever send it, and nobody finds out until somebody asks why
 * a case never opened) or a delivery event with no report (a delivery worker
 * looking up an id that was rolled back). Neither surfaces as an error at the
 * moment it happens, which is exactly why this has to be atomic rather than
 * carefully ordered.
 *
 * The one report with NO delivery event is the one whose type has no subject
 * provider, and that is a different claim entirely: not "delivery failed" but "there
 * was never a route out of this application for this kind of object". Those two must
 * not be conflated, which is why they are different `localStatus` values and why the
 * absent route is written down as a reason rather than inferred from a missing row.
 */

export class DuplicateReportError extends Error {
  readonly existing: ReportRecord;

  constructor(existing: ReportRecord) {
    super('This item has already been reported by this reporter.');
    this.name = 'DuplicateReportError';
    this.existing = existing;
  }
}

/**
 * Refuses an identifier that is not a string, at the point the QUERY is built.
 *
 * `CreateReportInput` types these as strings and the route rejects a missing one,
 * but a type is erased at runtime and a truthiness check passes `{$ne: null}`.
 * Handed that, `findOne` matches an UNRELATED report and this function answers
 * "you already reported this" about somebody else's row — and `create` would then
 * store an operator where an id belongs.
 *
 * The check lives here rather than at the route because `createReport` is
 * exported: a queue worker, a reconciliation script or a future admin path is
 * under no obligation to have passed the route's validation, and a guard that
 * only exists at one caller is a guard that holds until the second one arrives.
 */
function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`createReport: ${field} must be a non-empty string.`);
  }
  return value;
}

export interface CreateReportInput {
  reporter: string;
  reportedType: ReportedType;
  reportedId: string;
  categories: ReportCategory[];
  details?: string;
}

export interface CreateReportResult {
  report: ReportRecord;
  /**
   * The durable delivery event.
   *
   * Absent exactly when the reported type has no subject provider — the report was
   * stored and there is nothing to deliver it, by design rather than by failure.
   */
  outboxEventId?: string;
}

/**
 * Why a report is not going anywhere, in words an operator can read.
 *
 * Stored on the row rather than left to be inferred from a missing outbox event. A
 * missing row is also what a lost write looks like, and the two need to be
 * distinguishable months later without re-deriving which types had providers at the
 * time. Bounded by the schema's 300-character limit.
 */
function localOnlyReason(reportedType: string): string {
  return (
    `Mention has no moderation subject provider for '${reportedType}', so this report ` +
    'is recorded locally and is not sent for community review.'
  );
}

/**
 * Store the report, and queue its delivery in the same transaction.
 *
 * Delivery is queued when — and only when — the reported type has a subject provider.
 * A type without one is stored at `received` with the reason recorded, which is the
 * behaviour the application had before CrowdSource existed: the report is a receipt
 * and a local record, and nothing else ever happens to it.
 *
 * That branch is the reason the two writes stay in one transaction rather than being
 * ordered carefully. The condition is read BEFORE the transaction body decides
 * anything, so `localStatus` and the presence of an outbox row are decided together
 * from one fact — a report can never commit as `queued` with nothing to deliver it,
 * nor as `received` with a delivery event that will try anyway.
 *
 * Intake deliberately does not read `CROWDSOURCE_ENABLED`. A report taken while the
 * integration is off still gets its delivery event, so turning the flag on delivers
 * the backlog instead of stranding it — the dispatcher is what is gated, not the
 * durable record. Nothing here is conditional on a third party's state; only on
 * whether this application knows how to describe the object at all.
 */
export async function createReport(input: CreateReportInput): Promise<CreateReportResult> {
  const reporter = requireIdentifier(input.reporter, 'reporter');
  const reportedId = requireIdentifier(input.reportedId, 'reportedId');
  const reportedType = requireIdentifier(input.reportedType, 'reportedType');
  if (!(REPORTED_TYPES as readonly string[]).includes(reportedType)) {
    throw new TypeError(`createReport: reportedType '${reportedType}' is not a reportable type.`);
  }
  const deliverable = subjectProviderFor(reportedType) !== undefined;

  return await getDb().transaction(async (tx) => {
    const existing = await findDuplicateReport(
      reporter,
      reportedId,
      reportedType as ReportedType,
      tx,
    );
    if (existing) throw new DuplicateReportError(existing);

    const report = await insertReport(
      {
        reportedType: reportedType as ReportedType,
        reportedId,
        reporter,
        categories: input.categories,
        details: input.details,
        localStatus: deliverable ? 'queued' : 'received',
        ...(deliverable ? {} : { localStatusReason: localOnlyReason(reportedType) }),
      },
      tx,
    );

    if (!deliverable) return { report };

    const outboxEventId = await enqueueModerationOutboxEvent(
      {
        eventId: reportSubmitEventId(report.id),
        kind: 'report.submit',
        payload: { reportId: report.id },
      },
      tx,
    );

    return { report, outboxEventId };
  });
}
