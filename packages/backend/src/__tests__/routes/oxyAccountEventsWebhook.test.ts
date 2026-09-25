import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq, like } from 'drizzle-orm';

/**
 * `POST /webhooks/oxy/account-events` (OxyHQ/Mention#1169): the receiver for
 * Oxy's signed account-deletion events.
 *
 * The SDK's verification is mocked (its own tests cover the cryptography); what is
 * tested here is what the ROUTE does with each verdict, against the real ledger
 * table: nothing is recorded or erased unless the token verified, a redelivery is
 * acknowledged without a second row, and a failure to record is not a 2xx.
 */

const verifyAccountEvent = vi.hoisted(() => vi.fn());
const listAccountEvents = vi.hoisted(() => vi.fn());
const enqueueAccountErasure = vi.hoisted(() => vi.fn(async () => true));
const clientShape = vi.hoisted(() => ({ supportsEvents: true }));

vi.mock('../../utils/oxyHelpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/oxyHelpers')>()),
  getServiceOxyClient: () =>
    clientShape.supportsEvents ? { verifyAccountEvent, listAccountEvents } : { getUserById: vi.fn() },
}));
vi.mock('../../queue/producers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../queue/producers')>()),
  enqueueAccountErasure,
}));

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { accountErasures } from '../../db/schema/accountErasures';
import { createOxyAccountEventsRoutes } from '../../routes/oxyAccountEvents.routes';

const PREFIX = 'oxy-account-events-webhook-';
const TOKEN = 'eyJhbGciOiJFZERTQSJ9.eyJqdGkiOiJ4In0.c2lnbmF0dXJl';

function refusal(message: string): Error {
  const error = new Error(message);
  error.name = 'OxyAccountEventError';
  return error;
}

function event(eventId: string, userId = `${PREFIX}user`) {
  return {
    eventId,
    type: 'account.deleted' as const,
    userId,
    username: 'gone',
    occurredAt: '2026-09-26T09:14:00.000Z',
    retained: false,
    applicationId: 'mention',
    issuedAt: 1_790_000_000,
  };
}

function app() {
  const server = express();
  server.use('/webhooks', createOxyAccountEventsRoutes());
  return server;
}

function post(body: string, contentType = 'application/secevent+jwt') {
  return request(app()).post('/webhooks/oxy/account-events').set('Content-Type', contentType).send(body);
}

async function ledgerRows() {
  return getDb()
    .select({
      eventId: accountErasures.eventId,
      oxyUserId: accountErasures.oxyUserId,
      source: accountErasures.source,
      username: accountErasures.username,
      occurredAt: accountErasures.occurredAt,
    })
    .from(accountErasures)
    .where(like(accountErasures.oxyUserId, `${PREFIX}%`));
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  clientShape.supportsEvents = true;
  enqueueAccountErasure.mockResolvedValue(true);
  await getDb().delete(accountErasures).where(like(accountErasures.oxyUserId, `${PREFIX}%`));
});

afterAll(async () => {
  await getDb().delete(accountErasures).where(like(accountErasures.oxyUserId, `${PREFIX}%`));
  await closePostgres();
});

describe('POST /webhooks/oxy/account-events', () => {
  it('records a verified event, schedules the erasure and answers 202', async () => {
    verifyAccountEvent.mockResolvedValue(event(`${PREFIX}evt-1`));

    const res = await post(TOKEN).expect(202);

    expect(res.body).toEqual({ received: true, eventId: `${PREFIX}evt-1`, duplicate: false });
    expect(verifyAccountEvent).toHaveBeenCalledWith(TOKEN);
    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventId: `${PREFIX}evt-1`, source: 'webhook', username: 'gone' });
    expect(rows[0].occurredAt?.toISOString()).toBe('2026-09-26T09:14:00.000Z');
    expect(enqueueAccountErasure).toHaveBeenCalledWith({ eventId: `${PREFIX}evt-1` }, 0);
  });

  it('acknowledges a redelivered event id once, without a second row', async () => {
    verifyAccountEvent.mockResolvedValue(event(`${PREFIX}evt-2`));

    await post(TOKEN).expect(202);
    const again = await post(TOKEN).expect(202);

    expect(again.body.duplicate).toBe(true);
    expect(await ledgerRows()).toHaveLength(1);
    // The same job id generation both times, so the queue dedupes the job too.
    expect(enqueueAccountErasure.mock.calls).toEqual([
      [{ eventId: `${PREFIX}evt-2` }, 0],
      [{ eventId: `${PREFIX}evt-2` }, 0],
    ]);
  });

  it('answers 401 and records nothing when the signature does not verify', async () => {
    verifyAccountEvent.mockRejectedValue(refusal('Account event token signature is invalid'));

    await post(TOKEN).expect(401);

    expect(await ledgerRows()).toHaveLength(0);
    expect(enqueueAccountErasure).not.toHaveBeenCalled();
  });

  it('answers 400 for a body that is not a compact JWS, without verifying', async () => {
    await post('not a token').expect(400);
    await post('').expect(400);
    expect(verifyAccountEvent).not.toHaveBeenCalled();
  });

  it('answers 415 for any other content type', async () => {
    await post(JSON.stringify({ token: TOKEN }), 'application/json').expect(415);
    expect(verifyAccountEvent).not.toHaveBeenCalled();
  });

  it('answers 503 (retry) when the token cannot be checked, rather than 401', async () => {
    verifyAccountEvent.mockRejectedValue(new Error('JWKS fetch failed'));
    await post(TOKEN).expect(503);

    clientShape.supportsEvents = false;
    await post(TOKEN).expect(503);
    expect(await ledgerRows()).toHaveLength(0);
  });

  it('answers 500 when the event cannot be recorded, so Oxy retries', async () => {
    verifyAccountEvent.mockResolvedValueOnce(event(`${PREFIX}evt-3`, `${PREFIX}user-a`));
    await post(TOKEN).expect(202);
    // The same event id now naming a different account is refused at intake.
    verifyAccountEvent.mockResolvedValueOnce(event(`${PREFIX}evt-3`, `${PREFIX}user-b`));

    await post(TOKEN).expect(500);

    const rows = await ledgerRows();
    expect(rows.map((row) => row.oxyUserId)).toEqual([`${PREFIX}user-a`]);
  });

  it('still answers 202 when the queue is unreachable, leaving the row for the sweep', async () => {
    verifyAccountEvent.mockResolvedValue(event(`${PREFIX}evt-4`));
    enqueueAccountErasure.mockRejectedValue(new Error('redis down'));

    await post(TOKEN).expect(202);

    const [row] = await getDb()
      .select({ status: accountErasures.status })
      .from(accountErasures)
      .where(eq(accountErasures.eventId, `${PREFIX}evt-4`));
    expect(row.status).toBe('pending');
  });

  it('refuses an oversized body before verifying it', async () => {
    const huge = `${'a'.repeat(20_000)}.b.c`;
    const res = await post(huge);
    expect(res.status).toBe(413);
    expect(verifyAccountEvent).not.toHaveBeenCalled();
  });
});
