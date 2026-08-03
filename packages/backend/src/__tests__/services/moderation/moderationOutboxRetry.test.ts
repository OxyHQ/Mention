import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, like, lte, or } from 'drizzle-orm';

/**
 * The report that survives CrowdSource being down.
 *
 * This is the test the whole durable-reception design exists to make passable: the
 * user is answered, CrowdSource is unreachable, and the report is delivered later
 * without anybody re-filing it. It is written as two dispatcher ticks against the
 * real queue rather than as assertions on mock calls, because the property is about
 * what SURVIVES between the two — an assertion that `reports.create` was called
 * twice would pass just as well if the second call had come from a caller
 * re-submitting by hand.
 *
 * ## What the Postgres port changed
 *
 * The outbox row and the report are REAL ROWS, so the in-memory Mongo emulator this
 * file carried — `matches`, `applyUpdate`, and a hand-written `findOneAndUpdate`
 * that had to reimplement `$or`/`$lte`/`$gt`/`$exists` — is gone, and with it the
 * test that existed solely to keep it honest ("claims with an owner-checked lease
 * and orders oldest-first"). That was a vacuity floor for the FAKE: it pinned the
 * shape of the query because the fake could not answer whether the query was right.
 * Postgres answers, and `__tests__/db/moderationOutboxRepository.test.ts` drives
 * every row transition — the claim predicate, oldest-first ordering, owner-checked
 * completion, reclaim after lease expiry — against real rows. Re-asserting the
 * argument shape here would now be a weaker copy of a stronger check.
 *
 * What is left here, and is covered nowhere else, is the POLICY on top of those
 * transitions: what a retryable failure costs, what a permanent one costs, and that
 * the two halves — the outbox row and the report the reporter reads — always agree
 * about which happened.
 *
 * ## Isolation: `moderation_outbox` is a SHARED, GLOBALLY-DRAINED queue
 *
 * `dispatchModerationOutbox` claims the oldest due row, whoever wrote it, and
 * vitest runs test FILES in parallel — so a tick here could otherwise claim,
 * lease, deliver and COMPLETE a row belonging to `reportIntakeDurability`,
 * `crowdSourceWebhook`, `moderationReconciliation` or the repository suite, writing
 * a delivery receipt onto another file's report through this file's mocked client.
 *
 * Two things together make that impossible rather than unlikely:
 *
 *  - every tick is `batchSize: 1`, so a tick claims exactly one row; and
 *  - this file's event is backdated to {@link ANCIENT}, older than any row any
 *    other suite writes (the oldest elsewhere is `2020-01-01`, in the repository
 *    suite's ordering test), so oldest-first always reaches ours first.
 *
 * That is an assumption about other files, so {@link tick} CHECKS it before every
 * dispatch instead of trusting it: it reads the next due row and refuses to
 * dispatch if it is not ours. A future suite that backdates further gets a named
 * failure here rather than a corrupted row over there.
 */

const mocks = vi.hoisted(() => ({
  reportsCreate: vi.fn(),
  snapshot: vi.fn(),
}));

/** The subject snapshot. The seam is exercised elsewhere; here it just resolves. */
vi.mock('../../../services/moderation/subjects/registry', async () => {
  const actual = await vi.importActual<
    typeof import('../../../services/moderation/subjects/registry')
  >('../../../services/moderation/subjects/registry');
  return { ...actual, subjectProviderFor: vi.fn() };
});

vi.mock('../../../services/moderation/crowdSourceClient', () => ({
  getCrowdSourceClient: vi.fn(() => ({ reports: { create: mocks.reportsCreate } })),
  resetCrowdSourceClient: vi.fn(),
}));

import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { moderationOutbox, reports } from '../../../db/schema/moderation';
import {
  claimModerationOutboxEvent,
  enqueueModerationOutboxEvent,
} from '../../../db/moderation/moderationOutboxRepository';
import { findReportById } from '../../../db/moderation/reportRepository';
import { getCrowdSourceClient } from '../../../services/moderation/crowdSourceClient';
import { subjectProviderFor } from '../../../services/moderation/subjects/registry';
import {
  dispatchModerationOutbox,
  reportSubmitEventId,
} from '../../../services/moderation/ModerationOutboxService';
import { handleModerationOutboxEvent } from '../../../services/moderation/ModerationOutboxDispatcher';

/** Namespaces every row this file writes, so a parallel file cannot collide. */
const PREFIX = 'moderation:test-outbox-retry:';

/**
 * Older than any row any other suite writes — see the isolation note above.
 * {@link tick} verifies the consequence rather than assuming it.
 */
const ANCIENT = new Date('1999-01-01T00:00:00.000Z');

/** A distinct reporter per test: `(reporter, reported_id, reported_type)` is unique. */
let reporterSeq = 0;
let reportId: string;
let eventId: string;

/**
 * The error shape `@oxyhq/crowdsource` throws for "come back later": a 503 or a
 * connection failure. `retryable` is the only field the outbox reads.
 */
class RetryableTransportError extends Error {
  readonly retryable = true;

  constructor() {
    super('The request to /v1/reports did not complete.');
    this.name = 'CrowdSourceTransportError';
  }
}

/** The 409 of §10.5: the same external id with a different body. Never retryable. */
class PayloadConflictError extends Error {
  readonly retryable = false;

  constructor() {
    super('CrowdSource answered 409 for /v1/reports.');
    this.name = 'CrowdSourceApiError';
  }
}

/** The report, and its delivery event, in the state a fresh intake leaves them. */
async function seed(): Promise<void> {
  reporterSeq += 1;
  const [row] = await getDb()
    .insert(reports)
    .values({
      reportedType: 'post',
      reportedId: `${PREFIX}subject`,
      reporter: `${PREFIX}reporter-${reporterSeq}`,
      categories: ['harassment'],
      localStatus: 'queued',
    })
    .returning({ id: reports.id });
  reportId = row.id;
  eventId = reportSubmitEventId(reportId);

  // Through the real, transaction-required writer, so the row under test is the
  // one intake would have produced.
  await getDb().transaction(async (tx) => {
    await enqueueModerationOutboxEvent(
      { eventId, kind: 'report.submit', payload: { reportId } },
      tx,
    );
  });
  await getDb()
    .update(moderationOutbox)
    .set({ createdAt: ANCIENT })
    .where(eq(moderationOutbox.id, eventId));
}

async function readEvent() {
  const [row] = await getDb()
    .select()
    .from(moderationOutbox)
    .where(eq(moderationOutbox.id, eventId))
    .limit(1);
  return row;
}

/**
 * One dispatcher pass over exactly one due event — ours, checked first.
 *
 * The check is the isolation contract in executable form. Claiming another
 * suite's row would not fail here; it would succeed, deliver through this file's
 * mocked client, and fail over there.
 */
async function tick(): Promise<{ processed: number; failed: number; deadLettered: number }> {
  const now = new Date();
  const [next] = await getDb()
    .select({ id: moderationOutbox.id })
    .from(moderationOutbox)
    .where(
      or(
        and(eq(moderationOutbox.status, 'pending'), lte(moderationOutbox.availableAt, now)),
        and(eq(moderationOutbox.status, 'processing'), lte(moderationOutbox.leaseUntil, now)),
      ),
    )
    .orderBy(asc(moderationOutbox.createdAt))
    .limit(1);
  if (next?.id !== eventId) {
    throw new Error(
      `The next due moderation_outbox row is ${next?.id ?? '(none)'}, not this suite's ` +
        `${eventId}. A dispatch would have claimed and delivered another suite's work. ` +
        `Backdate this file's event further than every other suite's.`,
    );
  }
  return dispatchModerationOutbox({ handler: handleModerationOutboxEvent, batchSize: 1 });
}

/** Make the event due again, as the passage of real time would. */
async function fastForwardPastBackoff(): Promise<void> {
  await getDb()
    .update(moderationOutbox)
    .set({ availableAt: new Date(Date.now() - 1_000) })
    .where(eq(moderationOutbox.id, eventId));
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('moderation outbox — delivery survives CrowdSource being unreachable', () => {
  beforeEach(async () => {
    // The events cascade from their reports, so one delete clears both.
    await getDb().delete(reports).where(like(reports.reporter, `${PREFIX}%`));
    vi.clearAllMocks();
    mocks.reportsCreate.mockReset();
    mocks.snapshot.mockResolvedValue({
      subject: {
        externalId: `${PREFIX}subject`,
        type: 'social.post',
        author: { oxyUserId: 'oxy-author' },
      },
      content: 'The exact reported text.',
    });
    vi.mocked(subjectProviderFor).mockReturnValue({
      reportedType: 'post',
      subjectType: 'social.post',
      snapshot: mocks.snapshot,
    });
    await seed();
  });

  afterEach(async () => {
    await getDb().delete(reports).where(like(reports.reporter, `${PREFIX}%`));
  });

  it('keeps the report and delivers it on a later tick', async () => {
    mocks.reportsCreate
      .mockRejectedValueOnce(new RetryableTransportError())
      .mockResolvedValueOnce({
        reportId: 'rpt_01',
        caseId: 'case_01',
        status: 'received',
        merged: false,
      });

    // --- Tick 1: CrowdSource is unreachable.
    expect(await tick()).toEqual({ processed: 0, failed: 1, deadLettered: 0 });

    // The event survived, is due in the future, and remembers the failure.
    const afterFailure = await readEvent();
    expect(afterFailure).toMatchObject({ status: 'pending', attempts: 1 });
    expect(afterFailure?.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(afterFailure?.lastError).toContain('did not complete');
    // No lease is held, so any task can pick it up next.
    expect(afterFailure?.leaseOwner).toBeNull();

    // The failure is visible on the report itself, not only in the outbox.
    const failed = await findReportById(reportId);
    expect(failed?.localStatus).toBe('delivery_failed');
    expect(failed?.crowdSourceCaseId).toBeUndefined();

    // --- Tick 2: CrowdSource is back.
    await fastForwardPastBackoff();
    expect(await tick()).toEqual({ processed: 1, failed: 0, deadLettered: 0 });

    // The SAME event completed — no second event was ever created, so the
    // idempotency key CrowdSource sees is the same one it saw before.
    expect(
      await getDb()
        .select({ id: moderationOutbox.id })
        .from(moderationOutbox)
        .where(eq(moderationOutbox.payloadReportId, reportId)),
    ).toEqual([{ id: eventId }]);
    expect((await readEvent())?.status).toBe('processed');

    const delivered = await findReportById(reportId);
    expect(delivered).toMatchObject({
      localStatus: 'submitted',
      crowdSourceReportId: 'rpt_01',
      crowdSourceCaseId: 'case_01',
      crowdSourceMerged: false,
    });
    expect(delivered?.contentSnapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The failure note is cleared rather than left to be read as current.
    expect(delivered?.lastDeliveryError).toBeUndefined();

    expect(mocks.reportsCreate).toHaveBeenCalledTimes(2);
  });

  it('sends the same submittedAt on every attempt, so a retry is not a 409', async () => {
    mocks.reportsCreate
      .mockRejectedValueOnce(new RetryableTransportError())
      .mockResolvedValueOnce({
        reportId: 'rpt_01',
        caseId: 'case_01',
        status: 'received',
        merged: false,
      });

    await tick();
    await fastForwardPastBackoff();
    await tick();

    /**
     * §10.5 answers 409 when one `externalReportId` arrives with a different body,
     * and ingress fingerprints the WHOLE envelope. A timestamp invented per attempt
     * would therefore turn every legitimate retry into a permanent conflict — days
     * later, as moderation work stuck in a queue. Both attempts must be byte-equal.
     */
    const [firstAttempt] = mocks.reportsCreate.mock.calls[0];
    const [secondAttempt] = mocks.reportsCreate.mock.calls[1];
    expect(secondAttempt).toEqual(firstAttempt);
    // The report's OWN timestamp, read back from the row — not the moment of either
    // delivery, and not a value this test supplied.
    expect(firstAttempt.submittedAt).toEqual((await findReportById(reportId))?.createdAt);
    expect(firstAttempt.externalReportId).toBe(reportId);
  });

  it('stops trying when the failure says a retry can never succeed', async () => {
    mocks.reportsCreate.mockRejectedValue(new PayloadConflictError());

    expect(await tick()).toEqual({ processed: 0, failed: 1, deadLettered: 1 });

    /**
     * Dead-lettered on the FIRST attempt, not after twenty-five. No number of
     * retries makes two different payloads one report, so the attempt count would
     * only bury the reason in a growing row nobody reads.
     */
    const stopped = await readEvent();
    expect(stopped).toMatchObject({ status: 'dead_letter', attempts: 1 });
    expect(stopped?.lastError).toContain('409');

    // Still due immediately rather than backed off: the event is not waiting for
    // time to pass, it is waiting for a person.
    expect(stopped?.availableAt.getTime()).toBeLessThanOrEqual(Date.now());

    // And it is genuinely out of the queue, not merely labelled — a dead letter a
    // dispatcher can still claim spins forever on a payload nobody has fixed.
    await expect(
      claimModerationOutboxEvent({ leaseOwner: 'a-later-dispatcher', eventId }),
    ).resolves.toBeNull();
  });

  it('leaves the event untouched when there is nowhere to deliver to', async () => {
    vi.mocked(getCrowdSourceClient).mockReturnValueOnce(undefined);

    expect(await tick()).toEqual({ processed: 0, failed: 1, deadLettered: 0 });

    // An unconfigured deployment is a DELAY. The report keeps its durable event and
    // delivers when the integration is switched on.
    expect((await readEvent())?.status).toBe('pending');
    expect(mocks.reportsCreate).not.toHaveBeenCalled();
    // The report is not marked as having failed delivery either: nothing about it
    // changed, only the world's readiness.
    expect((await findReportById(reportId))?.localStatus).toBe('queued');
  });

  it('never claims an event a second time while its lease is live', async () => {
    /**
     * The claim, not the loop, is what makes running this on every ECS task safe. A
     * held lease must be invisible to a second dispatcher — otherwise two tasks
     * deliver one report concurrently and only the SDK's idempotency key stands
     * between that and two cases.
     *
     * The second dispatcher is a NAMED claim on this file's own event rather than a
     * nested `tick()`: a global drain running here would be claiming whatever
     * parallel suites happen to have due, which is the corruption the isolation note
     * above describes — and it would be answering a question about their rows, not
     * about this lease.
     */
    let concurrent: Awaited<ReturnType<typeof claimModerationOutboxEvent>> = null;
    mocks.reportsCreate.mockImplementation(async () => {
      concurrent = await claimModerationOutboxEvent({
        leaseOwner: 'a-second-dispatcher',
        eventId,
      });
      return { reportId: 'rpt_01', caseId: 'case_01', status: 'received', merged: false };
    });

    expect(await tick()).toEqual({ processed: 1, failed: 0, deadLettered: 0 });

    // While the delivery was in flight, the row was invisible to anyone else.
    expect(concurrent).toBeNull();
    expect(mocks.reportsCreate).toHaveBeenCalledTimes(1);
    expect((await readEvent())?.status).toBe('processed');
  });
});
