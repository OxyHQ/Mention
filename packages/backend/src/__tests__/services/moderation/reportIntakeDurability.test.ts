import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, like, sql } from 'drizzle-orm';

/**
 * §7.1 — a 201 means stored-and-will-retry, never "CrowdSource accepted it".
 *
 * The property under test is atomicity: the report row and its delivery event
 * commit in ONE transaction, so neither of the two silent failure modes is
 * reachable. A report with no delivery event is a report nothing will ever send,
 * and nobody finds out until somebody asks why a case never opened; a delivery
 * event with no report is a worker looking up an id that was rolled back.
 *
 * The second property, asserted at the bottom: a report whose type has no subject
 * provider gets NO delivery event. Not one that is skipped later — none. That is
 * what keeps a type this application cannot describe from dead-lettering in the
 * queue an operator has to be able to read, and it is why the two branches decide
 * `localStatus` and the outbox row from one fact rather than two.
 *
 * ## What the Postgres port changed
 *
 * The old file asserted on the SESSION each write received, because in Mongo that
 * was the only way to tell one transaction from two adjacent writes. There is no
 * session to inspect now, and the substitute is stronger rather than weaker: a
 * `before insert` TRIGGER on `moderation_outbox`, scoped to one probe subject so
 * it is invisible to every other suite, refuses the delivery event for real — and
 * the assertion is that the REPORT is not there afterwards. That is the claim two
 * sequential writes fail and a session-identity check could only imply.
 *
 * Two tests are gone rather than translated, because what they named no longer
 * exists:
 *
 *  - *"refuses to write a delivery event outside a transaction"* — the guard moved
 *    from `session.inTransaction()` to `requireTransaction`, and
 *    `__tests__/db/moderationOutboxRepository.test.ts` drives it directly against
 *    the root connection. Re-asserting it here through intake would be a second,
 *    weaker copy of a stronger check.
 *  - *"refuses to report success for a transaction that produced no result"* —
 *    that guarded Mongo's `withTransaction`, which can return without having run
 *    its body (it re-invokes the callback on a transient error). Drizzle's
 *    `db.transaction(fn)` RETURNS the callback's value and has no re-invoke path,
 *    so there is no state in which intake could answer 201 about a body that never
 *    ran. Restating it would be asserting a property of the driver.
 *
 * And one test is NEW, because the port made a race reachable that Mongo never
 * had: `reports_reporter_reported_key`. See its own comment.
 */

/**
 * The registry is mocked so both branches of the delivery decision are exercised
 * deterministically. Which types actually have providers is pinned separately, by
 * the vacuity floor in `routes/reportsAcceptedTypes.test.ts` — asserting it here
 * too would couple this file to Mention's own nouns, and the property under test
 * is about any application's.
 */
vi.mock('../../../services/moderation/subjects/registry', async () => {
  const actual = await vi.importActual<
    typeof import('../../../services/moderation/subjects/registry')
  >('../../../services/moderation/subjects/registry');
  return { ...actual, subjectProviderFor: vi.fn() };
});

/**
 * Real repository, with ONE outcome injectable.
 *
 * `findDuplicateReport` runs after the unique violation has already been raised by
 * a real index on real rows, and the only state it cannot be made to report is the
 * one where the winning row is deleted in the window between the two — a window
 * with no seam a single process can schedule. Everything else in that path stays
 * real: the constraint, the violation, the SQLSTATE, the aborted transaction.
 *
 * `vi.fn(actual)` keeps the genuine implementation as the default, so only the test
 * that calls `mockResolvedValueOnce` sees anything different. This file clears
 * mocks between tests and never RESETS them, so that default survives.
 */
vi.mock('../../../db/moderation/reportRepository', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../db/moderation/reportRepository')>();
  return { ...actual, findDuplicateReport: vi.fn(actual.findDuplicateReport) };
});

import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { moderationOutbox, reports } from '../../../db/schema/moderation';
import { sqlStateOf } from '../../../db/pgErrors';
import { findDuplicateReport } from '../../../db/moderation/reportRepository';
import {
  DuplicateReportError,
  createReport,
  type CreateReportInput,
} from '../../../services/moderation/ReportIntakeService';
import { reportSubmitEventId } from '../../../services/moderation/ModerationOutboxService';
import { subjectProviderFor } from '../../../services/moderation/subjects/registry';

/** Namespaces every row this file writes, so a parallel file cannot collide. */
const PREFIX = 'moderation:test-intake:';

/**
 * The reported id the atomicity probe trigger below refuses to accept. Scoping the
 * trigger to one subject rather than to the table is what keeps it invisible to
 * every other suite sharing this database.
 */
const ATOMICITY_PROBE_SUBJECT = `${PREFIX}atomicity-probe`;

/** A distinct reporter per test: `(reporter, reported_id, reported_type)` is unique. */
let reporterSeq = 0;
function nextReporter(): string {
  reporterSeq += 1;
  return `${PREFIX}reporter-${reporterSeq}`;
}

function postInput(overrides: Partial<CreateReportInput> = {}): CreateReportInput {
  return {
    reporter: nextReporter(),
    reportedType: 'post',
    reportedId: `${PREFIX}subject`,
    categories: ['harassment'],
    details: 'This is targeted at me repeatedly.',
    ...overrides,
  };
}

/** A live room: accepted by the API, and nothing in Mention can describe it. */
function roomInput(overrides: Partial<CreateReportInput> = {}): CreateReportInput {
  return {
    reporter: nextReporter(),
    reportedType: 'room',
    reportedId: `${PREFIX}room`,
    categories: ['harassment'],
    ...overrides,
  };
}

/** A provider for the reported type: the report is deliverable. */
function withSubjectProvider(): void {
  vi.mocked(subjectProviderFor).mockReturnValue({
    reportedType: 'post',
    subjectType: 'social.post',
    snapshot: vi.fn(),
  });
}

async function outboxRowsFor(reportId: string) {
  return getDb()
    .select()
    .from(moderationOutbox)
    .where(eq(moderationOutbox.payloadReportId, reportId));
}

async function reportRowsFor(reporter: string) {
  return getDb().select().from(reports).where(eq(reports.reporter, reporter));
}

beforeAll(async () => {
  const db = await connectPostgres();
  /**
   * A deterministic mid-transaction failure. Intake writes the report BEFORE the
   * outbox row, so a refused insert here is the only clean way to ask "did the
   * earlier write survive?" — and it is a REAL rollback rather than a mocked throw.
   *
   * The probe value is spliced as a LITERAL, not bound: a `$1` inside a function
   * body has no inferable type and Postgres refuses the whole DDL (42P18). It is a
   * local `const` of identifier-shaped characters, never a runtime value.
   */
  await db.execute(sql`
    create or replace function moderation_outbox_atomicity_probe() returns trigger as $$
    begin
      if exists (
        select 1 from reports r
        where r.id = new.payload_report_id
          and r.reported_id = ${sql.raw(`'${ATOMICITY_PROBE_SUBJECT}'`)}
      ) then
        raise exception 'moderation outbox atomicity probe';
      end if;
      return new;
    end;
    $$ language plpgsql;
  `);
  await db.execute(sql`
    create or replace trigger moderation_outbox_atomicity_probe_trigger
    before insert on moderation_outbox
    for each row execute function moderation_outbox_atomicity_probe();
  `);
});

afterAll(async () => {
  await getDb().execute(
    sql`drop trigger if exists moderation_outbox_atomicity_probe_trigger on moderation_outbox`,
  );
  await getDb().execute(sql`drop function if exists moderation_outbox_atomicity_probe()`);
  await closePostgres();
});

describe('report intake — durable reception (§7.1)', () => {
  beforeEach(async () => {
    // The events cascade from their reports, so one delete clears both.
    await getDb().delete(reports).where(like(reports.reporter, `${PREFIX}%`));
    vi.clearAllMocks();
    withSubjectProvider();
  });

  afterEach(async () => {
    await getDb().delete(reports).where(like(reports.reporter, `${PREFIX}%`));
  });

  it('writes the report and its delivery event together', async () => {
    const input = postInput();

    const result = await createReport(input);

    expect(result.report.localStatus).toBe('queued');
    expect(result.outboxEventId).toBe(reportSubmitEventId(result.report.id));

    /**
     * The event names this report and is ready to go out. "Both rows exist" is a
     * weaker claim than atomicity — two sequential writes satisfy it too — which is
     * what the probe test below is for.
     */
    expect(await outboxRowsFor(result.report.id)).toEqual([
      expect.objectContaining({
        id: reportSubmitEventId(result.report.id),
        kind: 'report.submit',
        payloadReportId: result.report.id,
        status: 'pending',
        attempts: 0,
      }),
    ]);
  });

  it('aborts the whole intake when the delivery event cannot be written', async () => {
    const input = postInput({ reportedId: ATOMICITY_PROBE_SUBJECT });

    // Read the SQLSTATE rather than the message: drizzle re-wraps the driver error
    // as "Failed query: …", so the plpgsql text is only on `cause`. `P0001` is
    // `raise_exception`, i.e. the probe fired and nothing else did.
    const rejection = await createReport(input).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).not.toBeNull();
    expect(sqlStateOf(rejection)).toBe('P0001');

    /**
     * The transaction aborted, so the report is not durable and the caller answers
     * 5xx rather than 201. This is the assertion that fails when the two writes are
     * merely sequential: there, the report would survive and the user would be told
     * 201 about a report nothing will ever deliver.
     */
    expect(await reportRowsFor(input.reporter)).toHaveLength(0);
  });

  it('answers a duplicate report without queueing a second delivery', async () => {
    const input = postInput();
    const first = await createReport(input);

    await expect(createReport(input)).rejects.toBeInstanceOf(DuplicateReportError);

    // One report, one event — the second attempt wrote neither.
    expect(await reportRowsFor(input.reporter)).toHaveLength(1);
    expect(await outboxRowsFor(first.report.id)).toHaveLength(1);
  });

  it.each([
    ['deliverable', () => withSubjectProvider(), postInput],
    ['local-only', () => vi.mocked(subjectProviderFor).mockReturnValue(undefined), roomInput],
  ])(
    'answers a CONCURRENT duplicate the same way it answers a sequential one (%s)',
    async (_branch, arrange, build) => {
      /**
       * A race Postgres made REACHABLE and Mongo never had.
       *
       * The dedup read and the insert are one transaction, but two intakes running
       * at once both read nothing and both insert; `reports_reporter_reported_key`
       * is what refuses the second. Mongo declared no such index, so there the
       * double-tap simply stored two reports and delivered two of them.
       *
       * Left alone the refusal surfaces as a raw 23505, which the route answers
       * `500 Error creating report` to — telling somebody their report failed when
       * it is already filed. So the constraint violation is translated back into
       * the SAME `DuplicateReportError` the sequential path raises, and the answer
       * is 409 either way.
       *
       * Staged rather than hoped for: the colliding row is held in an UNCOMMITTED
       * transaction, so intake's own read genuinely sees nothing and its insert
       * genuinely blocks. `settled` proves it blocked — without that check this
       * test would pass just as well against a sequential duplicate, which is the
       * case above.
       */
      arrange();
      const input = build();

      let releaseHolder = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      let holderInserted = (): void => undefined;
      const inserted = new Promise<void>((resolve) => {
        holderInserted = resolve;
      });

      const holder = getDb().transaction(async (tx) => {
        await tx.insert(reports).values({
          reportedType: input.reportedType,
          reportedId: input.reportedId,
          reporter: input.reporter,
          categories: input.categories,
          localStatus: 'queued',
        });
        holderInserted();
        await held;
      });
      await inserted;

      let settled = false;
      const racer = createReport(input).then(
        () => {
          settled = true;
          return null;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );

      // Long enough for a non-blocking insert to have completed and set the flag.
      // If the racer proceeds instead of waiting, two rows exist for one key.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(settled).toBe(false);

      releaseHolder();
      await holder;

      expect(await racer).toBeInstanceOf(DuplicateReportError);
      // And the loser learns about the WINNER's row, not about nothing.
      expect((await racer as DuplicateReportError).existing.reporter).toBe(input.reporter);
      expect(await reportRowsFor(input.reporter)).toHaveLength(1);
    },
  );

  it('raises the original violation, not a duplicate, when there is no winner to name', async () => {
    /**
     * The case above is the one that happens; this is the one that must not lie.
     *
     * `DuplicateReportError` is a CLAIM — it carries `existing`, the row the caller
     * is told already covers their report, and the UI turns that into "you already
     * reported this". If the winner is gone by the time we look (deleted in the
     * window between the violation and the read, which happens outside the aborted
     * transaction), then answering "duplicate" would invent both the cause and the
     * row: there is nothing the reporter can be pointed at, and the report they
     * filed does not exist either. Re-raising the original violation is the only
     * honest answer, and it is the one that lets the caller retry.
     *
     * Everything here is real except the vanishing: two reports genuinely collide
     * on `reports_reporter_reported_key`, and Postgres genuinely raises 23505. Only
     * the lookup's answer is injected, because a concurrent DELETE landing inside
     * that window is not schedulable from one process.
     *
     * `findDuplicateReport` is called TWICE per intake and both calls have to miss
     * for this path to be reached — which is the two-actor race stated precisely:
     * the in-transaction pre-check misses because the winner is not committed yet
     * (READ COMMITTED, exactly as the concurrent case above), and the read after
     * the violation misses because by then the winner has been deleted. Stubbing
     * only one of them would leave the other to answer, which is what the first
     * version of this test did — it reported a `DuplicateReportError` and named the
     * real row, because the injected `undefined` was consumed by the pre-check and
     * the genuine implementation served the read that mattered.
     */
    const input = postInput();
    await createReport(input);

    vi.mocked(findDuplicateReport)
      // The pre-check, inside the transaction: the winner is not visible yet.
      .mockResolvedValueOnce(undefined)
      // The read after 23505, outside the aborted transaction: the winner is gone.
      .mockResolvedValueOnce(undefined);

    const error = await createReport(input).catch((thrown: unknown) => thrown);

    expect(error).not.toBeInstanceOf(DuplicateReportError);
    expect(sqlStateOf(error)).toBe('23505');

    // The first report is untouched, and no second row was stored.
    expect(await reportRowsFor(input.reporter)).toHaveLength(1);
  });

  it('never stores a DELIVERABLE report without a delivery event', async () => {
    const input = postInput();

    const result = await createReport(input);

    /**
     * A report whose type has a provider always leaves with a route out. `queued`
     * and the outbox row are decided from ONE fact and written in one transaction,
     * so the pair cannot come apart — a row claiming `queued` with nothing to
     * deliver it is a report that waits forever while every status field says it is
     * on its way.
     */
    expect(result.outboxEventId).toBeDefined();
    expect(
      await getDb()
        .select()
        .from(reports)
        .where(and(eq(reports.id, result.report.id), eq(reports.localStatus, 'queued'))),
    ).toHaveLength(1);
    expect(await outboxRowsFor(result.report.id)).toHaveLength(1);
  });

  it('stores a report with no subject provider and queues nothing', async () => {
    /**
     * The local-only path, and the assertion the gate change exists for.
     *
     * A type with no provider keeps the behaviour the application had before
     * CrowdSource: the report is a receipt and a local record. Enqueueing one anyway
     * would send it to the delivery worker, which would raise
     * `ModerationSubjectUnsupportedError` with `retryable: false` — dead-lettering a
     * report that is not defective and putting a permanent entry in the queue an
     * operator is supposed to be able to trust.
     */
    vi.mocked(subjectProviderFor).mockReturnValue(undefined);
    const input = roomInput();

    const result = await createReport(input);

    expect(result.outboxEventId).toBeUndefined();
    // Nothing was enqueued. Not "enqueued and skipped later" — never written.
    expect(await outboxRowsFor(result.report.id)).toHaveLength(0);

    /**
     * `received`, with the reason ON the row. A missing outbox event is also what a
     * lost write looks like, so "there was never a route out" has to be recorded
     * rather than inferred months later from which types happened to have providers
     * at the time.
     */
    expect(result.report).toMatchObject({
      reportedType: 'room',
      localStatus: 'received',
      localStatusReason: expect.stringContaining('not sent for community review'),
    });
    // Read back, not merely returned: the reason has to survive the write.
    expect((await reportRowsFor(input.reporter))[0]).toMatchObject({
      localStatus: 'received',
      localStatusReason: expect.stringContaining('not sent for community review'),
    });
  });
});

describe('report intake — an operator is not an identifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withSubjectProvider();
  });

  afterEach(async () => {
    await getDb().delete(reports).where(like(reports.reporter, `${PREFIX}%`));
  });

  /**
   * `CreateReportInput` types these as strings and the route rejects a missing one,
   * but a type is erased at runtime and a truthiness check passes `{$ne: null}`.
   *
   * In Mongo, handed that, the dedup `findOne` matched an UNRELATED report and
   * intake answered "you already reported this" about somebody else's row — a wrong
   * answer about another user rather than a crash. A parameterised query cannot be
   * turned into a different query by one of its parameters, so that particular
   * failure is not reachable here; what is left is the difference between a named
   * refusal and a driver error from deep inside a repository.
   *
   * The guard stays in `createReport` rather than at the route because
   * `createReport` is exported: a queue worker, a reconciliation script or a future
   * admin path is under no obligation to have passed the route's validation, and a
   * guard that only exists at one caller is a guard that holds until the second one
   * arrives.
   */
  it.each([
    ['reportedId', { reportedId: { $ne: null } }],
    ['reporter', { reporter: { $ne: null } }],
    ['reportedType', { reportedType: { $ne: null } }],
  ])('refuses an operator in %s', async (_field, override) => {
    const input = { ...postInput(), ...override } as unknown as CreateReportInput;

    await expect(createReport(input)).rejects.toThrow(TypeError);

    // Nothing reached the table under any of the three spellings.
    expect(
      await getDb().select().from(reports).where(like(reports.reporter, `${PREFIX}%`)),
    ).toHaveLength(0);
  });

  it('refuses a reportedType outside the enum, even as a string', async () => {
    const input = { ...postInput(), reportedType: 'planet' } as unknown as CreateReportInput;

    await expect(createReport(input)).rejects.toThrow(/not a reportable type/);
    expect(
      await getDb().select().from(reports).where(like(reports.reporter, `${PREFIX}%`)),
    ).toHaveLength(0);
  });
});
