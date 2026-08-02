/**
 * `moderation_outbox` against real rows.
 *
 * Two things here cannot be checked any other way.
 *
 * **The claim is a raw `FOR UPDATE SKIP LOCKED` subquery**, which typechecks
 * whatever it says — the SQL is a string as far as the compiler is concerned. So
 * the predicate (due `pending`, or `processing` with an expired lease), the
 * oldest-first order, the attempt increment and the concurrent-drain property are
 * all asserted against the database rather than read.
 *
 * **The transaction guard replaces `session.inTransaction()`**, and the mistake
 * it catches is passing the ROOT connection — which is what every other
 * repository here defaults that parameter to, so it is what forgetting an
 * argument gets you. A test that only asserts the row exists passes either way;
 * this asserts the refusal.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { moderationOutbox, reports } from '../../db/schema/moderation';
import {
  claimModerationOutboxEvent,
  completeModerationOutboxEvent,
  enqueueModerationOutboxEvent,
  findModerationOutboxEvent,
  releaseModerationOutboxEvent,
  renewModerationOutboxEvent,
} from '../../db/moderation/moderationOutboxRepository';
import { MissingTransactionError } from '../../db/moderation/transactionGuard';

/** Namespaces every event this file writes, so a parallel file cannot collide. */
const PREFIX = 'moderation:test-outbox-repo:';

let seq = 0;
function eventId(): string {
  seq += 1;
  return `${PREFIX}${seq}`;
}

/**
 * A real report row for the event to name.
 *
 * `moderation_outbox.payload_report_id` carries a FOREIGN KEY to `reports.id` —
 * which is the Mongo transaction's invariant made structural: an outbox row that
 * names a report which does not exist is now impossible to write, rather than
 * merely prevented by committing the two together.
 */
async function seedReport(): Promise<string> {
  seq += 1;
  const [row] = await getDb()
    .insert(reports)
    .values({
      reportedType: 'post',
      reportedId: `${PREFIX}subject-${seq}`,
      reporter: `${PREFIX}reporter-${seq}`,
      categories: ['spam'],
    })
    .returning({ id: reports.id });
  return row.id;
}

/** Enqueue through the real (transaction-required) path. */
async function enqueue(id: string, reportId?: string): Promise<string> {
  const subject = reportId ?? (await seedReport());
  await getDb().transaction(async (tx) => {
    await enqueueModerationOutboxEvent(
      { eventId: id, kind: 'report.submit', payload: { reportId: subject } },
      tx,
    );
  });
  return subject;
}

async function readRow(id: string) {
  const [row] = await getDb()
    .select()
    .from(moderationOutbox)
    .where(eq(moderationOutbox.id, id))
    .limit(1);
  return row;
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await getDb().delete(moderationOutbox).where(like(moderationOutbox.id, `${PREFIX}%`));
  // `moderation_outbox.payload_report_id` cascades from `reports`, but the events
  // are deleted above by their own prefix; this clears the subjects they named.
  await getDb().delete(reports).where(like(reports.reporter, `${PREFIX}%`));
});

afterAll(async () => {
  await closePostgres();
});

describe('enqueueing', () => {
  /**
   * THE invariant. Handed the root connection, this must refuse — the domain
   * write and this row have to commit together, or a report is answered 201 and
   * never delivered.
   */
  it('refuses the root connection', async () => {
    const reportId = await seedReport();
    await expect(
      enqueueModerationOutboxEvent(
        { eventId: eventId(), kind: 'report.submit', payload: { reportId } },
        getDb(),
      ),
    ).rejects.toBeInstanceOf(MissingTransactionError);
  });

  it('writes the event when given a transaction', async () => {
    const id = eventId();
    const reportId = await enqueue(id);

    const row = await readRow(id);
    expect(row).toMatchObject({ kind: 'report.submit', status: 'pending', attempts: 0 });
    expect(row?.payloadReportId).toBe(reportId);
  });

  /**
   * A repeat is a genuine NO-OP, not a write.
   *
   * A repeat is ordinary — a transaction retry, two concurrent duplicate
   * submissions, a reconciliation sweep re-deriving this deterministic id — and
   * it runs while the dispatcher holds leases on these same rows. A write nobody
   * needed would contend with a live lease.
   */
  it('is a no-op for an id that already exists, leaving the row untouched', async () => {
    const id = eventId();
    const reportId = await enqueue(id);
    const before = await readRow(id);

    // Claim it first, so a stray write would visibly clobber live lease state.
    await claimModerationOutboxEvent({ leaseOwner: 'worker-1', eventId: id });
    const claimed = await readRow(id);

    await enqueue(id, reportId);

    const after = await readRow(id);
    expect(after?.status).toBe('processing');
    expect(after?.leaseOwner).toBe('worker-1');
    expect(after?.attempts).toBe(claimed?.attempts);
    expect(after?.createdAt.getTime()).toBe(before?.createdAt.getTime());
  });

  it('rolls the event back with its transaction', async () => {
    const id = eventId();
    const reportId = await seedReport();
    await expect(
      getDb().transaction(async (tx) => {
        await enqueueModerationOutboxEvent(
          { eventId: id, kind: 'report.submit', payload: { reportId } },
          tx,
        );
        throw new Error('domain write failed');
      }),
    ).rejects.toThrow('domain write failed');

    expect(await readRow(id)).toBeUndefined();
  });
});

describe('claiming', () => {
  it('claims a due pending event and increments its attempts', async () => {
    const id = eventId();
    const reportId = await enqueue(id);

    const event = await claimModerationOutboxEvent({ leaseOwner: 'worker-1', eventId: id });

    expect(event?._id).toBe(id);
    expect(event?.attempts).toBe(1);
    expect(event?.payload).toEqual({ reportId });
    expect((await readRow(id))?.status).toBe('processing');
  });

  it('does not claim an event whose backoff has not elapsed', async () => {
    const id = eventId();
    await enqueue(id);
    await getDb()
      .update(moderationOutbox)
      .set({ availableAt: new Date(Date.now() + 60_000) })
      .where(eq(moderationOutbox.id, id));

    await expect(
      claimModerationOutboxEvent({ leaseOwner: 'worker-1', eventId: id }),
    ).resolves.toBeNull();
  });

  it('does not claim an event another worker holds a live lease on', async () => {
    const id = eventId();
    await enqueue(id);
    await claimModerationOutboxEvent({ leaseOwner: 'worker-1', eventId: id });

    await expect(
      claimModerationOutboxEvent({ leaseOwner: 'worker-2', eventId: id }),
    ).resolves.toBeNull();
  });

  /**
   * A dead worker must not strand moderation work forever, so an EXPIRED
   * `processing` lease is reclaimable — the second half of the claim predicate,
   * and the half a `status = 'pending'`-only filter would silently drop.
   */
  it('reclaims an event whose lease expired', async () => {
    const id = eventId();
    await enqueue(id);
    await claimModerationOutboxEvent({ leaseOwner: 'worker-1', eventId: id });
    await getDb()
      .update(moderationOutbox)
      .set({ leaseUntil: new Date(Date.now() - 60_000) })
      .where(eq(moderationOutbox.id, id));

    const reclaimed = await claimModerationOutboxEvent({ leaseOwner: 'worker-2', eventId: id });

    expect(reclaimed?._id).toBe(id);
    expect((await readRow(id))?.leaseOwner).toBe('worker-2');
  });

  /**
   * Two dispatchers draining at once get DIFFERENT events, and neither blocks.
   *
   * That is what `SKIP LOCKED` buys, and it is unobservable sequentially: run one
   * after the other and each simply takes the next row, which a plain
   * `FOR UPDATE` — or no locking at all — also does.
   */
  it('hands two concurrent dispatchers different events', async () => {
    const first = eventId();
    const second = eventId();
    await enqueue(first);
    await enqueue(second);

    const [a, b] = await Promise.all([
      claimModerationOutboxEvent({ leaseOwner: 'worker-a' }),
      claimModerationOutboxEvent({ leaseOwner: 'worker-b' }),
    ]);

    const claimedIds = [a?._id, b?._id].filter((id): id is string => id !== undefined);
    // Both claimed something (the table may hold other suites' rows, so this
    // asserts distinctness rather than exactly which two).
    expect(claimedIds).toHaveLength(2);
    expect(new Set(claimedIds).size).toBe(2);
  });

  it('claims the oldest due event first when no id is named', async () => {
    const older = eventId();
    const newer = eventId();
    await enqueue(older);
    await enqueue(newer);
    // Pin the order explicitly: both rows are created within the same millisecond
    // often enough that `created_at` alone is a coin flip.
    await getDb()
      .update(moderationOutbox)
      .set({ createdAt: new Date('2020-01-01T00:00:00.000Z') })
      .where(eq(moderationOutbox.id, older));
    await getDb()
      .update(moderationOutbox)
      .set({ createdAt: new Date('2030-01-01T00:00:00.000Z') })
      .where(eq(moderationOutbox.id, newer));

    const claimed = await claimModerationOutboxEvent({ leaseOwner: 'worker-1' });

    expect(claimed?._id).toBe(older);
  });
});

describe('finishing', () => {
  it('completes only the lease this worker owns', async () => {
    const id = eventId();
    await enqueue(id);
    await claimModerationOutboxEvent({ leaseOwner: 'worker-1', eventId: id });

    await expect(completeModerationOutboxEvent(id, 'worker-2')).resolves.toBe(false);
    await expect(completeModerationOutboxEvent(id, 'worker-1')).resolves.toBe(true);

    const row = await readRow(id);
    expect(row?.status).toBe('processed');
    expect(row?.leaseOwner).toBeNull();
    expect(row?.processedAt).not.toBeNull();
  });

  it('renews only a live lease this worker owns', async () => {
    const id = eventId();
    await enqueue(id);
    await claimModerationOutboxEvent({ leaseOwner: 'worker-1', eventId: id });

    await expect(renewModerationOutboxEvent(id, 'worker-2', 30_000)).resolves.toBe(false);
    await expect(renewModerationOutboxEvent(id, 'worker-1', 30_000)).resolves.toBe(true);
  });

  it('releases a retryable failure back to pending with its backoff', async () => {
    const id = eventId();
    await enqueue(id);
    await claimModerationOutboxEvent({ leaseOwner: 'worker-1', eventId: id });
    const availableAt = new Date(Date.now() + 120_000);

    await expect(
      releaseModerationOutboxEvent({
        eventId: id,
        leaseOwner: 'worker-1',
        deadLettered: false,
        availableAt,
        error: 'crowdsource unreachable',
      }),
    ).resolves.toBe(true);

    const row = await readRow(id);
    expect(row?.status).toBe('pending');
    expect(row?.lastError).toBe('crowdsource unreachable');
    expect(row?.leaseOwner).toBeNull();
    expect(row?.availableAt.getTime()).toBe(availableAt.getTime());
  });

  /**
   * A dead-lettered event STAYS visible with its error rather than accumulating
   * attempts nobody reads — and must never be claimable again, or a 409 that no
   * number of retries can resolve spins forever.
   */
  it('dead-letters a permanent failure, and it is not claimable again', async () => {
    const id = eventId();
    await enqueue(id);
    await claimModerationOutboxEvent({ leaseOwner: 'worker-1', eventId: id });

    await releaseModerationOutboxEvent({
      eventId: id,
      leaseOwner: 'worker-1',
      deadLettered: true,
      availableAt: new Date(),
      error: 'payload conflict',
    });

    expect((await readRow(id))?.status).toBe('dead_letter');
    await expect(
      claimModerationOutboxEvent({ leaseOwner: 'worker-2', eventId: id }),
    ).resolves.toBeNull();
  });

  it('reads one event back by id', async () => {
    const id = eventId();
    await enqueue(id);

    await expect(findModerationOutboxEvent(id)).resolves.toMatchObject({
      _id: id,
      kind: 'report.submit',
    });
    await expect(findModerationOutboxEvent(`${PREFIX}absent`)).resolves.toBeUndefined();
  });
});
