import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * §7.1 — a 201 means stored-and-will-retry, never "CrowdSource accepted it".
 *
 * The property under test is atomicity: the `Report` and its `ModerationOutbox`
 * event commit in ONE transaction, so neither of the two silent failure modes is
 * reachable. A report with no delivery event is a report nothing will ever send,
 * and nobody finds out until somebody asks why a case never opened; a delivery
 * event with no report is a worker looking up an id that was rolled back.
 *
 * Both are invisible at the moment they happen, which is why this is asserted on
 * the SESSION each write receives rather than on the end state. A test that only
 * checked "both rows exist" passes just as happily against two sequential writes
 * outside a transaction — and that is exactly the regression worth catching.
 */

vi.mock('../../../models/Report.model', async () => {
  const actual = await vi.importActual<typeof import('../../../models/Report.model')>(
    '../../../models/Report.model',
  );
  return {
    ...actual,
    default: {
      findOne: vi.fn(),
      create: vi.fn(),
    },
  };
});

vi.mock('../../../models/ModerationOutbox', () => ({
  MODERATION_OUTBOX_RETENTION_SECONDS: 90 * 24 * 60 * 60,
  default: {
    updateOne: vi.fn(),
  },
}));

import ModerationOutbox from '../../../models/ModerationOutbox';
import Report, { ReportCategory, ReportedType } from '../../../models/Report.model';
import {
  DuplicateReportError,
  createReport,
} from '../../../services/moderation/ReportIntakeService';
import { reportSubmitEventId } from '../../../services/moderation/ModerationOutboxService';

interface TransactionSpy {
  /** Whether the body ran to completion inside `withTransaction`. */
  committed: boolean;
  /** Set when the transaction body threw, i.e. the transaction aborted. */
  aborted: unknown;
  ended: boolean;
  /** The session object the service hands to each write. */
  session: mongoose.ClientSession;
}

function stubSession(): TransactionSpy {
  const session = {
    withTransaction: vi.fn(async (operation: () => Promise<void>) => {
      try {
        await operation();
        spy.committed = true;
      } catch (error: unknown) {
        // Mongo aborts the transaction and rethrows: NOTHING the body wrote is
        // durable. Modelling that is the whole point of this stub.
        spy.aborted = error;
        throw error;
      }
    }),
    endSession: vi.fn(async () => {
      spy.ended = true;
    }),
  };
  const spy: TransactionSpy = {
    committed: false,
    aborted: undefined,
    ended: false,
    session: session as unknown as mongoose.ClientSession,
  };
  vi.spyOn(mongoose, 'startSession').mockResolvedValue(spy.session);
  return spy;
}

function queryReturning<T>(value: T) {
  return {
    session: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(value),
  };
}

const REPORT_ID = '507f1f77bcf86cd799439011';

function mockCreatedReport(): void {
  vi.mocked(Report.create).mockResolvedValue([
    {
      _id: new mongoose.Types.ObjectId(REPORT_ID),
      id: REPORT_ID,
      localStatus: 'queued',
    },
  ] as never);
}

const INPUT = {
  reporter: 'oxy-user-reporter',
  reportedType: ReportedType.POST,
  reportedId: '507f1f77bcf86cd799439022',
  categories: [ReportCategory.HARASSMENT],
  details: 'This is targeted at me repeatedly.',
};

describe('report intake — durable reception (§7.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the report and its delivery event with the SAME transaction session', async () => {
    const transaction = stubSession();
    vi.mocked(Report.findOne).mockReturnValue(queryReturning(null) as never);
    mockCreatedReport();
    vi.mocked(ModerationOutbox.updateOne).mockResolvedValue({} as never);

    const result = await createReport(INPUT);

    expect(transaction.committed).toBe(true);
    expect(result.outboxEventId).toBe(reportSubmitEventId(REPORT_ID));

    /**
     * The assertion that matters: both writes received the SAME session instance, and
     * that instance is the one `withTransaction` was called on. Identity is the whole
     * property — a different session, or `undefined`, means the two writes commit
     * independently however adjacent they look in the source.
     */
    const reportSession = vi.mocked(Report.create).mock.calls[0][1]?.session;
    const outboxSession = vi.mocked(ModerationOutbox.updateOne).mock.calls[0][2]?.session;
    expect(reportSession).toBe(transaction.session);
    expect(outboxSession).toBe(transaction.session);

    expect(ModerationOutbox.updateOne).toHaveBeenCalledWith(
      { _id: reportSubmitEventId(REPORT_ID) },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          _id: reportSubmitEventId(REPORT_ID),
          kind: 'report.submit',
          payload: { reportId: REPORT_ID },
          status: 'pending',
          attempts: 0,
        }),
      }),
      expect.objectContaining({ upsert: true }),
    );
  });

  it('aborts the whole intake when the delivery event cannot be written', async () => {
    const transaction = stubSession();
    vi.mocked(Report.findOne).mockReturnValue(queryReturning(null) as never);
    mockCreatedReport();
    const outboxFailure = new Error('outbox write rejected');
    vi.mocked(ModerationOutbox.updateOne).mockRejectedValue(outboxFailure);

    await expect(createReport(INPUT)).rejects.toThrow('outbox write rejected');

    /**
     * The transaction aborted, so the report Mongo had "created" is not durable and
     * the caller answers 5xx rather than 201. This is the assertion that fails when
     * the two writes are merely sequential: there, the report would survive and the
     * user would be told 201 about a report nothing will ever deliver.
     */
    expect(transaction.aborted).toBe(outboxFailure);
    expect(transaction.committed).toBe(false);
    expect(transaction.ended).toBe(true);
  });

  it('answers a duplicate report without queueing a second delivery', async () => {
    stubSession();
    const existing = { _id: new mongoose.Types.ObjectId(REPORT_ID), localStatus: 'submitted' };
    vi.mocked(Report.findOne).mockReturnValue(queryReturning(existing) as never);

    await expect(createReport(INPUT)).rejects.toBeInstanceOf(DuplicateReportError);

    expect(Report.create).not.toHaveBeenCalled();
    expect(ModerationOutbox.updateOne).not.toHaveBeenCalled();
  });

  it('refuses to report success for a transaction that produced no result', async () => {
    /**
     * The guard that stops a silent empty success. `withTransaction` can return without
     * having run its body — Mongo retries a transient transaction error by re-invoking
     * it, and a driver or a mock that swallows the callback would otherwise leave
     * `createReport` returning `undefined` while the caller answers 201 about a report
     * that was never written.
     */
    vi.spyOn(mongoose, 'startSession').mockResolvedValue({
      withTransaction: vi.fn(async () => undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
    } as never);

    await expect(createReport(INPUT)).rejects.toThrow(
      'Report intake transaction completed without a result',
    );
    expect(Report.create).not.toHaveBeenCalled();
  });

  it('never stores a report without a delivery event', async () => {
    const transaction = stubSession();
    vi.mocked(Report.findOne).mockReturnValue(queryReturning(null) as never);
    mockCreatedReport();
    vi.mocked(ModerationOutbox.updateOne).mockResolvedValue({} as never);

    const result = await createReport(INPUT);

    /**
     * There is no "stored but undeliverable" branch, and that is the point. A report
     * Mention cannot act on is refused by `POST /reports` before intake is reached, so
     * every row this function writes has a durable route out. A local state meaning
     * "nothing will ever happen to this" would be a receipt for work nobody does, and
     * no queue alert would ever fire on it.
     */
    expect(result.outboxEventId).toBeDefined();
    expect(Report.create).toHaveBeenCalledWith(
      [expect.objectContaining({ localStatus: 'queued' })],
      { session: transaction.session },
    );
    expect(ModerationOutbox.updateOne).toHaveBeenCalledTimes(1);
  });
});
