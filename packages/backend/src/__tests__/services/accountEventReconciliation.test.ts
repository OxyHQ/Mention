import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, like } from 'drizzle-orm';

/**
 * The pull-feed safety net (OxyHQ/Mention#1169), against the real ledger and
 * cursor tables. Oxy's feed and the SDK's verification are mocked; the cursor,
 * the dedupe and the retry scan are the code under test.
 *
 * The rule being held: the cursor moves ONLY past a page whose every event was
 * recorded. A failure to reach Oxy, a failure to verify that is not a refusal, or a
 * failure to record leaves it where it was, so the next tick re-reads the page.
 */

const verifyAccountEvent = vi.hoisted(() => vi.fn());
const listAccountEvents = vi.hoisted(() => vi.fn());
const enqueueAccountErasure = vi.hoisted(() => vi.fn(async () => true));
const processAccountErasure = vi.hoisted(() => vi.fn(async () => ({ outcome: 'completed' })));

vi.mock('../../utils/oxyHelpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/oxyHelpers')>()),
  getServiceOxyClient: () => ({ verifyAccountEvent, listAccountEvents }),
}));
vi.mock('../../queue/producers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../queue/producers')>()),
  enqueueAccountErasure,
}));
vi.mock('../../services/accountErasure/AccountErasureService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/accountErasure/AccountErasureService')>()),
  processAccountErasure,
}));

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { accountErasures, oxyAccountEventCursors } from '../../db/schema/accountErasures';
import {
  ACCOUNT_EVENTS_FEED,
  AccountEventReconciliationJob,
  RECONCILIATION_INTERVAL_MS,
  pullAccountEvents,
  reconcileAccountEvents,
  retryUnfinishedErasures,
} from '../../services/accountErasure/AccountEventReconciliationJob';
import {
  readAccountEventCursor,
  recordAccountErasureRequest,
} from '../../db/accountErasures/accountErasureRepository';

const PREFIX = 'oxy-account-event-reconciliation-';

function item(n: number) {
  return {
    eventId: `${PREFIX}evt-${n}`,
    type: 'account.deleted' as const,
    userId: `${PREFIX}user-${n}`,
    username: `user${n}`,
    occurredAt: '2026-09-26T09:14:00.000Z',
    retained: false,
    token: `token-${n}`,
  };
}

/** The verifier echoes the token's number back as a verified event. */
function verifyByToken(token: string) {
  const n = Number(token.replace('token-', ''));
  const { token: _token, ...fields } = item(n);
  return Promise.resolve({ ...fields, applicationId: 'mention', issuedAt: 1 });
}

function refusal(): Error {
  const error = new Error('Account event token signature is invalid');
  error.name = 'OxyAccountEventError';
  return error;
}

async function recordedEventIds(): Promise<string[]> {
  const rows = await getDb()
    .select({ eventId: accountErasures.eventId })
    .from(accountErasures)
    .where(like(accountErasures.oxyUserId, `${PREFIX}%`));
  return rows.map((row) => row.eventId).sort();
}

async function reset(): Promise<void> {
  await getDb().delete(accountErasures).where(like(accountErasures.oxyUserId, `${PREFIX}%`));
  await getDb().delete(oxyAccountEventCursors).where(eq(oxyAccountEventCursors.id, ACCOUNT_EVENTS_FEED));
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  verifyAccountEvent.mockImplementation(verifyByToken);
  enqueueAccountErasure.mockResolvedValue(true);
  await reset();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await reset();
  await closePostgres();
});

describe('pullAccountEvents', () => {
  it('records every event on a page and advances the cursor to the page end', async () => {
    listAccountEvents
      .mockResolvedValueOnce({ events: [item(1), item(2)], nextCursor: 'c2' });

    const result = await pullAccountEvents();

    expect(listAccountEvents).toHaveBeenCalledWith({ limit: 100 });
    expect(result).toMatchObject({ recorded: 2, refused: 0, cursorAdvanced: true });
    expect(await recordedEventIds()).toEqual([`${PREFIX}evt-1`, `${PREFIX}evt-2`]);
    expect(await readAccountEventCursor(ACCOUNT_EVENTS_FEED)).toBe('c2');
    expect(enqueueAccountErasure).toHaveBeenCalledTimes(2);
  });

  it('reads on from the stored cursor, and an overlapping event is deduped', async () => {
    listAccountEvents.mockResolvedValueOnce({ events: [item(1), item(2)], nextCursor: 'c2' });
    await pullAccountEvents();

    // Oxy serves evt-2 again (an overlap) and evt-3.
    listAccountEvents.mockResolvedValueOnce({ events: [item(2), item(3)], nextCursor: 'c3' });
    await pullAccountEvents();

    expect(listAccountEvents).toHaveBeenLastCalledWith({ after: 'c2', limit: 100 });
    expect(await recordedEventIds()).toEqual([`${PREFIX}evt-1`, `${PREFIX}evt-2`, `${PREFIX}evt-3`]);
    expect(await readAccountEventCursor(ACCOUNT_EVENTS_FEED)).toBe('c3');
  });

  it('follows a full page to the next one, and stops at an empty page', async () => {
    const full = Array.from({ length: 100 }, (_, index) => item(100 + index));
    listAccountEvents
      .mockResolvedValueOnce({ events: full, nextCursor: 'p1' })
      .mockResolvedValueOnce({ events: [], nextCursor: 'p1' });

    const result = await pullAccountEvents();

    expect(result.pages).toBe(2);
    expect(result.recorded).toBe(100);
    expect(await readAccountEventCursor(ACCOUNT_EVENTS_FEED)).toBe('p1');
  });

  it('leaves the cursor unchanged when Oxy cannot be reached', async () => {
    listAccountEvents.mockResolvedValueOnce({ events: [item(1)], nextCursor: 'c1' });
    await pullAccountEvents();
    listAccountEvents.mockRejectedValueOnce(new Error('503 from Oxy'));

    await expect(pullAccountEvents()).rejects.toThrow('503 from Oxy');
    // The tick wrapper swallows it and still does the rest of its work.
    listAccountEvents.mockRejectedValueOnce(new Error('503 from Oxy'));
    await expect(reconcileAccountEvents()).resolves.toBeUndefined();

    expect(await readAccountEventCursor(ACCOUNT_EVENTS_FEED)).toBe('c1');
  });

  it('leaves the cursor unchanged when a token cannot be CHECKED (not a refusal)', async () => {
    verifyAccountEvent.mockRejectedValueOnce(new Error('JWKS unreachable'));
    listAccountEvents.mockResolvedValueOnce({ events: [item(1)], nextCursor: 'c1' });

    await expect(pullAccountEvents()).rejects.toThrow('JWKS unreachable');

    expect(await readAccountEventCursor(ACCOUNT_EVENTS_FEED)).toBeNull();
    expect(await recordedEventIds()).toEqual([]);
  });

  it('skips a token that is REFUSED, records nothing for it, and moves on', async () => {
    verifyAccountEvent.mockImplementation((token: string) =>
      token === 'token-1' ? Promise.reject(refusal()) : verifyByToken(token),
    );
    listAccountEvents.mockResolvedValueOnce({ events: [item(1), item(2)], nextCursor: 'c2' });

    const result = await pullAccountEvents();

    expect(result).toMatchObject({ recorded: 1, refused: 1 });
    expect(await recordedEventIds()).toEqual([`${PREFIX}evt-2`]);
    expect(await readAccountEventCursor(ACCOUNT_EVENTS_FEED)).toBe('c2');
  });

  it('records from the signed token when the feed fields disagree with it', async () => {
    listAccountEvents.mockResolvedValueOnce({
      events: [{ ...item(5), userId: `${PREFIX}someone-else` }],
      nextCursor: 'c5',
    });

    await pullAccountEvents();

    const [row] = await getDb()
      .select({ oxyUserId: accountErasures.oxyUserId })
      .from(accountErasures)
      .where(eq(accountErasures.eventId, `${PREFIX}evt-5`));
    expect(row.oxyUserId).toBe(`${PREFIX}user-5`);
  });
});

describe('retryUnfinishedErasures and the username scrub', () => {
  async function seedRow(eventId: string, patch: Partial<typeof accountErasures.$inferInsert>) {
    await recordAccountErasureRequest({
      eventId,
      oxyUserId: `${PREFIX}retry`,
      source: 'webhook',
      reason: 'account.deleted',
      occurredAt: null,
      retained: false,
      username: 'handle',
    });
    await getDb().update(accountErasures).set(patch).where(eq(accountErasures.eventId, eventId));
  }

  it('re-schedules stale pending/failed rows and lapsed leases, not fresh or finished ones', async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await seedRow(`${PREFIX}stale-failed`, { status: 'failed', attempts: 2, updatedAt: old });
    await seedRow(`${PREFIX}stale-pending`, { status: 'pending', updatedAt: old });
    await seedRow(`${PREFIX}lapsed`, { status: 'running', leaseUntil: old });
    await seedRow(`${PREFIX}fresh`, { status: 'pending' });
    await seedRow(`${PREFIX}done`, { status: 'completed', updatedAt: old });

    const retried = await retryUnfinishedErasures();

    expect(retried).toBeGreaterThanOrEqual(3);
    const scheduled = enqueueAccountErasure.mock.calls.map((call) => (call[0] as { eventId: string }).eventId);
    expect(scheduled).toEqual(
      expect.arrayContaining([`${PREFIX}stale-failed`, `${PREFIX}stale-pending`, `${PREFIX}lapsed`]),
    );
    expect(scheduled).not.toContain(`${PREFIX}fresh`);
    expect(scheduled).not.toContain(`${PREFIX}done`);
    // A failed row is re-enqueued under a NEW job generation.
    const failedCall = enqueueAccountErasure.mock.calls.find(
      (call) => (call[0] as { eventId: string }).eventId === `${PREFIX}stale-failed`,
    );
    expect(failedCall?.[1]).toBe(2);
  });

  it('runs a stale row in-process when there is no queue', async () => {
    enqueueAccountErasure.mockResolvedValue(false);
    await seedRow(`${PREFIX}inline`, { status: 'pending', updatedAt: new Date(Date.now() - 60 * 60 * 1000) });

    await retryUnfinishedErasures();
    await vi.waitFor(() => expect(processAccountErasure).toHaveBeenCalledWith(`${PREFIX}inline`));
  });

  it('clears the handle of an erasure completed past the retention window, and only that', async () => {
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await seedRow(`${PREFIX}old-done`, { status: 'completed', completedAt: longAgo });
    await seedRow(`${PREFIX}new-done`, { status: 'completed', completedAt: new Date() });
    listAccountEvents.mockResolvedValue({ events: [], nextCursor: null });

    await reconcileAccountEvents();

    const rows = await getDb()
      .select({ eventId: accountErasures.eventId, username: accountErasures.username })
      .from(accountErasures)
      .where(like(accountErasures.oxyUserId, `${PREFIX}retry`));
    const byId = new Map(rows.map((row) => [row.eventId, row.username]));
    expect(byId.get(`${PREFIX}old-done`)).toBeNull();
    expect(byId.get(`${PREFIX}new-done`)).toBe('handle');
  });
});

describe('AccountEventReconciliationJob', () => {
  it('ticks soon after start and then on its interval, and never after stop', async () => {
    vi.useFakeTimers();
    const job = new AccountEventReconciliationJob();
    const tick = vi.spyOn(job, 'tick').mockResolvedValue(undefined);

    job.start();
    job.start(); // idempotent: one interval, one first tick
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(2);

    job.stop();
    await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS * 2);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('runs one pass per tick, single-flight, and none once stopped', async () => {
    listAccountEvents.mockResolvedValue({ events: [], nextCursor: null });
    const job = new AccountEventReconciliationJob();

    await job.tick(); // not started: no pass
    expect(listAccountEvents).not.toHaveBeenCalled();

    job.start();
    await Promise.all([job.tick(), job.tick()]);
    expect(listAccountEvents).toHaveBeenCalledTimes(1);
    job.stop();
  });
});
