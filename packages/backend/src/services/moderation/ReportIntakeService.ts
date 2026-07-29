import mongoose, { type ClientSession } from 'mongoose';
import Report, {
  ReportCategory,
  ReportStatus,
  ReportedType,
  type IReport,
  type LeanReport,
} from '../../models/Report.model';
import {
  enqueueModerationOutboxEvent,
  reportSubmitEventId,
} from './ModerationOutboxService';

/**
 * Storing a report and the promise to deliver it, in one operation.
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
 */

const TRANSACTION_OPTIONS = {
  readPreference: 'primary' as const,
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const },
};

export class DuplicateReportError extends Error {
  readonly existing: LeanReport;

  constructor(existing: LeanReport) {
    super('This item has already been reported by this reporter.');
    this.name = 'DuplicateReportError';
    this.existing = existing;
  }
}

export interface CreateReportInput {
  reporter: string;
  reportedType: ReportedType;
  reportedId: string;
  categories: ReportCategory[];
  details?: string;
}

export interface CreateReportResult {
  report: IReport;
  /** The durable delivery event, absent when this type cannot be delivered. */
  outboxEventId?: string;
}

async function inTransaction<T>(
  operation: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = await mongoose.startSession();
  let result: T | undefined;
  try {
    await session.withTransaction(async () => {
      result = await operation(session);
    }, TRANSACTION_OPTIONS);
    if (result === undefined) {
      throw new Error('Report intake transaction completed without a result');
    }
    return result;
  } finally {
    await session.endSession();
  }
}

/**
 * Store the report, and queue its delivery in the same transaction.
 *
 * Every report that reaches here is one Mention can act on: `POST /reports` has
 * already refused any type the subject registry does not cover, so there is no
 * "stored but undeliverable" branch and no local state meaning "nothing will ever
 * happen to this".
 *
 * Intake deliberately does not read `CROWDSOURCE_ENABLED` either. A report taken
 * while the integration is off still gets its delivery event, so turning the flag on
 * delivers the backlog instead of stranding it — the dispatcher is what is gated,
 * not the durable record. Nothing here is conditional on a third party's state.
 */
export async function createReport(input: CreateReportInput): Promise<CreateReportResult> {
  return await inTransaction(async (session) => {
    const existing = await Report.findOne({
      reporter: input.reporter,
      reportedId: input.reportedId,
      reportedType: input.reportedType,
    })
      .session(session)
      .lean<LeanReport | null>();
    if (existing) throw new DuplicateReportError(existing);

    const [report] = await Report.create(
      [
        {
          reportedType: input.reportedType,
          reportedId: input.reportedId,
          reporter: input.reporter,
          categories: input.categories,
          details: input.details,
          status: ReportStatus.PENDING,
          localStatus: 'queued',
        },
      ],
      { session },
    );

    const outboxEventId = await enqueueModerationOutboxEvent(
      {
        eventId: reportSubmitEventId(report.id),
        kind: 'report.submit',
        payload: { reportId: report.id },
      },
      session,
    );

    return { report, outboxEventId };
  });
}
