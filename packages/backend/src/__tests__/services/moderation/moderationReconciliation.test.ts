import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';

/**
 * The sweep that finds the reports the pipeline lost sight of.
 *
 * The outbox makes delivery durable, not infallible: a report written before this
 * integration existed, or one whose event expired while the deployment was down, has
 * nothing to deliver it. This sweep RE-DERIVES that work from the reports and never
 * invents any — the guarantee being tested is that it enqueues only what is missing,
 * with the same deterministic id, so a report that already has an event is untouched
 * rather than delivered twice.
 *
 * ## What the Postgres port changed
 *
 * Both stores are real rows. The mocks this replaces were unusually careful —
 * `find` honoured the `localStatus` filter and `countDocuments` answered on the
 * FILTER rather than on call order, both deliberately, so that a filter-blind
 * double could not make "the sweep excludes it" indistinguishable from "the mock
 * handed it over anyway". Those two properties are exactly what real rows give
 * for free, and one they could not give at all: `moderation_outbox.
 * payload_report_id` carries a FOREIGN KEY to `reports.id`, so an event naming a
 * report that does not exist is now unwritable rather than merely undesirable.
 *
 * The transaction assertion changed subject with it. There is no session to spy
 * on; what is asserted instead is the property the session existed to protect —
 * `enqueueModerationOutboxEvent` REFUSES the root connection — and that refusal
 * is owned by `__tests__/db/moderationOutboxRepository.test.ts`, which drives it
 * directly. Re-asserting it here through the sweep would be a second, weaker copy.
 */

import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { moderationOutbox, reports } from '../../../db/schema/moderation';
import type { ReportLocalStatus } from '../../../db/moderation/reportRepository';
import { reconcileModerationReports } from '../../../services/moderation/ModerationReconciliation';
import { reportSubmitEventId } from '../../../services/moderation/ModerationOutboxService';

/**
 * Namespaces every row this file writes.
 *
 * The sweep reads the WHOLE `reports` table — that is its job — so a fixture from
 * a parallel file would be picked up and counted. Every assertion below is
 * therefore about rows this file can name, and the two aggregate counters
 * (`awaitingDecision`, `localOnly`) are asserted as a DELTA against a baseline
 * taken in the same test rather than as an absolute.
 */
const PREFIX = 'moderation:test-reconciliation:';

let seq = 0;

/** One report, in the state the sweep will find it. */
async function seedReport(options: {
  localStatus: ReportLocalStatus;
  submittedAt?: Date;
}): Promise<string> {
  seq += 1;
  const [row] = await getDb()
    .insert(reports)
    .values({
      reportedType: 'post',
      reportedId: `${PREFIX}subject-${seq}`,
      reporter: `${PREFIX}reporter-${seq}`,
      categories: ['spam'],
      localStatus: options.localStatus,
      ...(options.submittedAt ? { submittedAt: options.submittedAt } : {}),
    })
    .returning({ id: reports.id });
  return row.id;
}

/** An existing delivery event for `reportId`, in the given state. */
async function seedOutboxEvent(reportId: string, status: 'pending' | 'dead_letter'): Promise<void> {
  const now = new Date();
  await getDb().insert(moderationOutbox).values({
    id: reportSubmitEventId(reportId),
    kind: 'report.submit',
    payloadReportId: reportId,
    status,
    attempts: 0,
    availableAt: now,
    expiresAt: new Date(now.getTime() + 86_400_000),
  });
}

/** The delivery event for `reportId`, or `undefined`. */
async function readEvent(reportId: string) {
  const [row] = await getDb()
    .select()
    .from(moderationOutbox)
    .where(eq(moderationOutbox.id, reportSubmitEventId(reportId)))
    .limit(1);
  return row;
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  // The events cascade from their reports, so one delete clears both.
  await getDb().delete(reports).where(like(reports.reporter, `${PREFIX}%`));
});

afterAll(async () => {
  await closePostgres();
});

describe('moderation reconciliation', () => {
  it('re-derives a missing delivery event with the same deterministic id', async () => {
    const reportId = await seedReport({ localStatus: 'queued' });

    const result = await reconcileModerationReports();

    expect(result.requeued).toBeGreaterThanOrEqual(1);
    /**
     * The SAME id the intake would have used. A sweep that minted a new one would
     * deliver the report twice — and because the SDK's idempotency key is derived from
     * the report, the second delivery would arrive under a different key and open a
     * second case.
     */
    expect(await readEvent(reportId)).toMatchObject({
      id: reportSubmitEventId(reportId),
      kind: 'report.submit',
      payloadReportId: reportId,
      status: 'pending',
    });
  });

  it('leaves a report that already has an event alone', async () => {
    const reportId = await seedReport({ localStatus: 'queued' });
    await seedOutboxEvent(reportId, 'pending');
    const before = await readEvent(reportId);

    await reconcileModerationReports();

    // Byte-identical: the sweep did not rewrite it, which is what "untouched"
    // means for a row a dispatcher may be holding a lease on.
    expect(await readEvent(reportId)).toEqual(before);
  });

  it('counts a dead-lettered event instead of spinning on it', async () => {
    const reportId = await seedReport({ localStatus: 'delivery_failed' });
    await seedOutboxEvent(reportId, 'dead_letter');

    const result = await reconcileModerationReports();

    /**
     * Something about the payload has to change before this can succeed, so re-queueing
     * it would spin forever. The COUNT is the alert — the sweep's job here is to make
     * the report visible, not to retry it.
     */
    expect(result.deadLettered).toBeGreaterThanOrEqual(1);
    expect((await readEvent(reportId))?.status).toBe('dead_letter');
  });

  it('reports how many submitted cases have gone quiet', async () => {
    const baseline = (await reconcileModerationReports()).awaitingDecision;
    // Well past the 72-hour threshold.
    await seedReport({
      localStatus: 'submitted',
      submittedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000),
    });
    // Submitted just now — inside the window, so it must NOT be counted. Without
    // this row the assertion could not tell a working threshold from one that
    // counts every submitted report.
    await seedReport({ localStatus: 'submitted', submittedAt: new Date() });

    const result = await reconcileModerationReports();

    // Nothing to do locally — publishing the decision is CrowdSource's job — but a
    // rising count is how a broken endpoint or a rotated secret becomes visible before
    // somebody notices a silent moderation queue.
    expect(result.awaitingDecision).toBe(baseline + 1);
  });

  it('counts local-only reports and never re-queues one', async () => {
    /**
     * The sweep's answer to the cost of accepting a report nothing will deliver. A
     * `received` report has no subject provider, so a re-derived delivery event would
     * fail non-retryably on its first attempt and dead-letter — turning a deliberate
     * local-only report into a permanent entry in the queue that is supposed to mean
     * "something is wrong". Counting is the only correct action, and it is the one number
     * that makes reports no jury will ever see visible at all.
     */
    const baseline = (await reconcileModerationReports()).localOnly;
    const reportId = await seedReport({ localStatus: 'received' });

    const result = await reconcileModerationReports();

    expect(result.localOnly).toBe(baseline + 1);
    // The load-bearing half: adding `'received'` to the sweep's own status filter
    // would produce an event here, and it would dead-letter on its first attempt.
    expect(await readEvent(reportId)).toBeUndefined();
  });
});
