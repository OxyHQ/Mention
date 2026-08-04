import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The repo-wide `setup.ts` replaces `mongoose.connect` with a no-op so no test
 * can open a real connection. That is the right default and it is exactly why
 * this class of defect was invisible: with it in force, every query buffers and
 * nothing a real server would reject is ever sent to one.
 *
 * This one file opts out. The unmock is hoisted above the imports, so mongoose
 * and everything that reaches it are loaded dynamically below.
 */
vi.unmock('mongoose');

const mongoose = (await import('mongoose')).default;
const { default: ModerationOutbox } = await import('../../../models/ModerationOutbox');
const { enqueueModerationOutboxEvent } = await import(
  '../../../services/moderation/ModerationOutboxService'
);

/**
 * The outbox write, against a REAL server.
 *
 * ## Why this file exists
 *
 * Every other moderation test mocks `ModerationOutbox`, and a mocked `updateOne`
 * accepts any update document at all. That made a whole class of defect
 * invisible: an update Mongo itself rejects passes a mocked suite unanimously.
 *
 * It shipped one. `enqueueModerationOutboxEvent` named `createdAt`/`updatedAt` in
 * `$setOnInsert` while the schema declares `{ timestamps: true }`, so Mongoose
 * added the same paths itself and Mongo refused the whole write with
 * `Updating the path 'updatedAt' would create a conflict at 'updatedAt'`. Because
 * the enqueue runs inside `createReport`'s transaction, that aborted the `Report`
 * too — so `POST /reports` failed for **every** report, from the first one, in a
 * tree whose suite was green.
 *
 * This is the shape `~/Oxy/AGENTS.md` calls a check that cannot distinguish
 * success from failure. The fix is not a better assertion against the mock; it is
 * one test that lets the database answer.
 *
 * ## Why a standalone server and no transaction
 *
 * `enqueueModerationOutboxEvent` refuses a session with no transaction open, and
 * a transaction needs a replica set — which costs startup time this repo does not
 * currently pay anywhere. But the defect is in the UPDATE DOCUMENT, not in the
 * transaction: Mongo rejects it before any of that matters. So the session is a
 * real one reporting `inTransaction()`, and the write goes to a real server.
 * Nothing here asserts transactional behaviour; `reportIntakeDurability.test.ts`
 * owns that, with mocks, and the two are complementary rather than duplicates.
 */

let server: MongoMemoryServer;
let session: mongoose.ClientSession;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri(), { dbName: 'moderation-outbox-writes' });
  session = await mongoose.startSession();
}, 120_000);

afterAll(async () => {
  await session.endSession();
  await mongoose.disconnect();
  await server.stop();
});

/**
 * A REAL driver session that reports itself as in a transaction.
 *
 * The guard exists to stop an enqueue happening outside the transaction that
 * wrote the domain row, and `reportIntakeDurability.test.ts` proves it holds — so
 * it is answered here rather than removed. Deleting a guard for a test's
 * convenience is the test dictating the code.
 *
 * It has to be a real session and not a plain object: the driver reads its own
 * fields off whatever is passed, and a stand-in fails inside Mongoose long before
 * the write is built — which would test the stand-in rather than the update. Only
 * `inTransaction` is overridden, because a standalone server cannot start a
 * transaction and the defect under test is in the update document, which Mongo
 * rejects before a transaction would matter.
 */
function sessionInTransaction(session: mongoose.ClientSession): mongoose.ClientSession {
  return new Proxy(session, {
    get(target, property, receiver) {
      if (property === 'inTransaction') return () => true;
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('the outbox write is one Mongo accepts', () => {
  it('enqueues a first event', async () => {
    const eventId = `moderation:report.submit:${new mongoose.Types.ObjectId().toString()}`;

    await expect(
      enqueueModerationOutboxEvent(
        { eventId, kind: 'report.submit', payload: { reportId: 'r1' } },
        sessionInTransaction(session),
      ),
    ).resolves.toBe(eventId);

    const stored = await ModerationOutbox.findById(eventId).lean();
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe('pending');
    // Mongoose owns these because the schema says `timestamps: true`. Asserting
    // they arrive is what pins the fix: naming them in `$setOnInsert` to "make
    // sure" is exactly what broke the write.
    expect(stored?.createdAt).toBeInstanceOf(Date);
    expect(stored?.updatedAt).toBeInstanceOf(Date);
  });

  it('a repeated enqueue writes NOTHING — not even updatedAt', async () => {
    /**
     * The assertion that DISTINGUISHES the two candidate fixes, and the reason it
     * exists as its own test.
     *
     * Both `timestamps: false` + explicit fields and "let Mongoose own them" clear
     * the update-conflict, so both satisfy every other assertion in this file —
     * including the row-count one below, because a row that was rewritten is still
     * one row. Only `updatedAt` moves, so only `updatedAt` tells them apart.
     *
     * The 25 ms wait is load-bearing: without it an unchanged timestamp could be
     * same-millisecond luck on a fast machine, and the test would pass under the
     * wrong fix about half the time.
     */
    const eventId = `moderation:report.submit:${new mongoose.Types.ObjectId().toString()}`;
    const enqueue = async (): Promise<void> => {
      await enqueueModerationOutboxEvent(
        { eventId, kind: 'report.submit', payload: { reportId: 'r4' } },
        sessionInTransaction(session),
      );
    };

    await enqueue();
    const before = await ModerationOutbox.findById(eventId).lean();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await enqueue();
    const after = await ModerationOutbox.findById(eventId).lean();

    expect(before?.updatedAt).toBeInstanceOf(Date);
    expect(after?.updatedAt?.getTime()).toBe(before?.updatedAt?.getTime());
    expect(after?.createdAt?.getTime()).toBe(before?.createdAt?.getTime());
  });

  it('is idempotent — a replayed enqueue writes one row, not two', async () => {
    const eventId = `moderation:report.submit:${new mongoose.Types.ObjectId().toString()}`;

    await enqueueModerationOutboxEvent(
      { eventId, kind: 'report.submit', payload: { reportId: 'r2' } },
      sessionInTransaction(session),
    );
    await enqueueModerationOutboxEvent(
      { eventId, kind: 'report.submit', payload: { reportId: 'r2' } },
      sessionInTransaction(session),
    );

    expect(await ModerationOutbox.countDocuments({ _id: eventId })).toBe(1);
  });

  it('round-trips a frozen urgency exactly as the contract shapes it', async () => {
    /**
     * The urgency is snapshotted at intake and read back at delivery, so the ROW is
     * what has to be faithful — a mocked `updateOne` would accept a payload Mongo
     * stores differently, which is the class of defect this whole file exists for.
     */
    const eventId = `moderation:report.submit:${new mongoose.Types.ObjectId().toString()}`;
    const urgency = { hint: 'public_feed', reach: 250_000, activeDistribution: true };

    await enqueueModerationOutboxEvent(
      { eventId, kind: 'report.submit', payload: { reportId: 'r5', urgency } },
      sessionInTransaction(session),
    );

    const stored = await ModerationOutbox.findById(eventId).lean();
    expect(stored?.payload).toEqual({ reportId: 'r5', urgency });
  });

  it('stores NO urgency key for a subject that had none', async () => {
    /**
     * Absent has to stay absent, and the difference is not cosmetic: `urgency` is a
     * STRICT contract object requiring `hint`, so an empty `{}` materialised onto
     * the row would fail envelope composition with a NON-retryable input error and
     * dead-letter a report whose only defect is a missing scheduling hint. That is
     * why the schema path is `Mixed` rather than declared sub-paths — and only the
     * server can confirm which of the two Mongoose actually wrote.
     */
    const eventId = `moderation:report.submit:${new mongoose.Types.ObjectId().toString()}`;

    await enqueueModerationOutboxEvent(
      { eventId, kind: 'report.submit', payload: { reportId: 'r6' } },
      sessionInTransaction(session),
    );

    const stored = await ModerationOutbox.findById(eventId).lean();
    expect(stored?.payload).toEqual({ reportId: 'r6' });
    expect(stored?.payload).not.toHaveProperty('urgency');
  });

  it('refuses a session with no transaction open, before touching the server', async () => {
    const eventId = `moderation:report.submit:${new mongoose.Types.ObjectId().toString()}`;
    const noTransaction = { inTransaction: () => false } as unknown as mongoose.ClientSession;

    await expect(
      enqueueModerationOutboxEvent(
        { eventId, kind: 'report.submit', payload: { reportId: 'r3' } },
        noTransaction,
      ),
    ).rejects.toThrow();

    expect(await ModerationOutbox.countDocuments({ _id: eventId })).toBe(0);
  });
});
