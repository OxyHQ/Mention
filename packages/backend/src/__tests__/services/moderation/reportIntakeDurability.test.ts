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
 *
 * The second property, asserted at the bottom: a report whose type has no subject
 * provider gets NO delivery event. Not one that is skipped later — none. That is what
 * keeps a type this application cannot describe from dead-lettering in the queue an
 * operator has to be able to read, and it is why the two branches decide `localStatus`
 * and the outbox row from one fact rather than two.
 */

vi.mock('../../../models/Report.model', async () => {
  const actual = await vi.importActual<typeof import('../../../models/Report.model.js')>(
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

/**
 * The registry is mocked so both branches of the delivery decision are exercised
 * deterministically. Which types actually have providers is pinned separately, by the
 * vacuity floor in `routes/reportsAcceptedTypes.test.ts` — asserting it here too would
 * couple this file to Mention's own nouns, and the property under test is about any
 * application's.
 */
vi.mock('../../../services/moderation/subjects/registry', async () => {
  const actual = await vi.importActual<
    typeof import('../../../services/moderation/subjects/registry.js')
  >('../../../services/moderation/subjects/registry');
  return { ...actual, subjectProviderFor: vi.fn() };
});

import ModerationOutbox from '../../../models/ModerationOutbox';
import Report, { ReportCategory, ReportedType } from '../../../models/Report.model';
import {
  DuplicateReportError,
  createReport,
} from '../../../services/moderation/ReportIntakeService';
import { reportSubmitEventId } from '../../../services/moderation/ModerationOutboxService';
import { subjectProviderFor } from '../../../services/moderation/subjects/registry';

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
    /**
     * Reports being INSIDE a transaction, because `enqueueModerationOutboxEvent`
     * refuses to write otherwise. The stub has to model that or every test here
     * would fail on the guard rather than on the behaviour it targets.
     */
    inTransaction: () => true,
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

/** A provider for the reported type: the report is deliverable. */
function withSubjectProvider(): void {
  vi.mocked(subjectProviderFor).mockReturnValue({
    reportedType: 'post',
    subjectType: 'social.post',
    snapshot: vi.fn(),
  });
}

const INPUT = {
  reporter: 'oxy-user-reporter',
  reportedType: ReportedType.POST,
  reportedId: '507f1f77bcf86cd799439022',
  categories: [ReportCategory.HARASSMENT],
  details: 'This is targeted at me repeatedly.',
};

/** A live room: accepted by the API, and nothing in Mention can describe it. */
const ROOM_INPUT = {
  reporter: 'oxy-user-reporter',
  reportedType: ReportedType.ROOM,
  reportedId: 'room_123',
  categories: [ReportCategory.HARASSMENT],
};

describe('report intake — durable reception (§7.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withSubjectProvider();
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

  it('refuses to write a delivery event outside a transaction', async () => {
    /**
     * The invariant this whole collection exists for, enforced rather than reviewed.
     *
     * A required `session` parameter is satisfied by any session — including a bare
     * `startSession()` nobody opened a transaction on. That type-checks perfectly,
     * commits the outbox row on its own, and passes any test that only asserts the row
     * exists; it fails as lost moderation work with no trace on the day something
     * restarts between the two writes. So the check is on `inTransaction()`, not on the
     * parameter being present.
     *
     * This matters beyond Mention: every app copying this template inherits the guard
     * instead of inheriting a comment asking them to be careful.
     */
    vi.spyOn(mongoose, 'startSession').mockResolvedValue({
      inTransaction: () => false,
      withTransaction: vi.fn(async (operation: () => Promise<void>) => {
        await operation();
      }),
      endSession: vi.fn().mockResolvedValue(undefined),
    } as never);
    vi.mocked(Report.findOne).mockReturnValue(queryReturning(null) as never);
    mockCreatedReport();

    await expect(createReport(INPUT)).rejects.toThrow(
      /Refusing to enqueue moderation outbox event .* outside a transaction/,
    );
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

  it('never stores a DELIVERABLE report without a delivery event', async () => {
    const transaction = stubSession();
    vi.mocked(Report.findOne).mockReturnValue(queryReturning(null) as never);
    mockCreatedReport();
    vi.mocked(ModerationOutbox.updateOne).mockResolvedValue({} as never);

    const result = await createReport(INPUT);

    /**
     * A report whose type has a provider always leaves with a route out. `queued` and
     * the outbox row are decided from ONE fact and written in one transaction, so the
     * pair cannot come apart — a row claiming `queued` with nothing to deliver it is a
     * report that waits forever while every status field says it is on its way.
     */
    expect(result.outboxEventId).toBeDefined();
    expect(Report.create).toHaveBeenCalledWith(
      [expect.objectContaining({ localStatus: 'queued' })],
      { session: transaction.session },
    );
    expect(ModerationOutbox.updateOne).toHaveBeenCalledTimes(1);
  });

  it('stores a report with no subject provider and queues nothing', async () => {
    /**
     * The local-only path, and the assertion the gate change exists for.
     *
     * A type with no provider keeps the behaviour the application had before CrowdSource:
     * the report is a receipt and a local record. Enqueueing one anyway would send it to
     * the delivery worker, which would raise `ModerationSubjectUnsupportedError` with
     * `retryable: false` — dead-lettering a report that is not defective and putting a
     * permanent entry in the queue an operator is supposed to be able to trust.
     */
    const transaction = stubSession();
    vi.mocked(subjectProviderFor).mockReturnValue(undefined);
    vi.mocked(Report.findOne).mockReturnValue(queryReturning(null) as never);
    mockCreatedReport();

    const result = await createReport(ROOM_INPUT);

    expect(transaction.committed).toBe(true);
    expect(result.outboxEventId).toBeUndefined();
    // Nothing was enqueued. Not "enqueued and skipped later" — never written.
    expect(ModerationOutbox.updateOne).not.toHaveBeenCalled();

    /**
     * `received`, with the reason ON the row. A missing outbox event is also what a lost
     * write looks like, so "there was never a route out" has to be recorded rather than
     * inferred months later from which types happened to have providers at the time.
     */
    const [documents] = vi.mocked(Report.create).mock.calls[0];
    expect(documents[0]).toMatchObject({
      reportedType: 'room',
      localStatus: 'received',
      localStatusReason: expect.stringContaining('not sent for community review'),
    });
  });

  it('keeps the local-only report inside the same transaction', async () => {
    /**
     * The transaction is not conditional on there being two writes. `withTransaction`
     * still wraps the intake, so the duplicate check and the insert are one atomic
     * decision — and, more importantly, the shape of the function does not change
     * between the two branches, so a later edit cannot make one of them the
     * carefully-ordered version.
     */
    const transaction = stubSession();
    vi.mocked(subjectProviderFor).mockReturnValue(undefined);
    vi.mocked(Report.findOne).mockReturnValue(queryReturning(null) as never);
    mockCreatedReport();

    await createReport(ROOM_INPUT);

    expect(Report.create).toHaveBeenCalledWith([expect.anything()], {
      session: transaction.session,
    });
    expect(transaction.ended).toBe(true);
  });
});

describe('report intake — an operator is not an identifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withSubjectProvider();
    /**
     * Inert while the guard holds — intake throws before it ever opens a session.
     *
     * It is here for the run where the guard does NOT hold, which is the only run
     * that tells you whether these tests are worth anything. Without it, removing the
     * guard sends `createReport` into a real `mongoose.startSession()` against no
     * connection: the tests fail by a five-second timeout that names nothing and
     * looks like flake. With it they fail in milliseconds, on the assertions below,
     * showing intake running to completion and queueing a delivery for an operator.
     */
    stubSession();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * `CreateReportInput` types these as strings and the route rejects a missing
   * one, but a type is erased at runtime and a truthiness check passes
   * `{$ne: null}`. Handed that, the dedup `findOne` matches an UNRELATED report
   * and intake answers "you already reported this" about somebody else's row —
   * so the failure is not a crash, it is a wrong answer about another user.
   *
   * The refusal is asserted BEFORE any query runs: `Report.findOne` must not have
   * been called at all. A guard that rejects after building the query has already
   * sent the operator to Mongo.
   */
  it.each([
    ['reportedId', { reportedId: { $ne: null } }],
    ['reporter', { reporter: { $ne: null } }],
    ['reportedType', { reportedType: { $ne: null } }],
  ])('refuses an operator in %s before it reaches the query', async (_field, override) => {
    await expect(
      createReport({ ...INPUT, ...override } as unknown as typeof INPUT),
    ).rejects.toThrow(TypeError);
    expect(Report.findOne).not.toHaveBeenCalled();
  });

  it('refuses a reportedType outside the enum, even as a string', async () => {
    await expect(
      createReport({ ...INPUT, reportedType: 'planet' } as unknown as typeof INPUT),
    ).rejects.toThrow(/not a reportable type/);
    expect(Report.findOne).not.toHaveBeenCalled();
  });
});
