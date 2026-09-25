import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The thin adapter over `@oxy.so/core`'s account-event API, and the intake's
 * scheduling decision. The SDK itself is mocked: these tests pin what Mention
 * does with what the SDK returns.
 */

const client = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const enqueueAccountErasure = vi.hoisted(() => vi.fn());
const processAccountErasure = vi.hoisted(() => vi.fn(async () => ({ outcome: 'completed' })));

vi.mock('../../utils/oxyHelpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/oxyHelpers')>()),
  getServiceOxyClient: () => client.current,
}));
vi.mock('../../queue/producers', () => ({ enqueueAccountErasure }));
vi.mock('../../services/accountErasure/AccountErasureService', () => ({ processAccountErasure }));

import { OxyAccountEventError } from '@oxy.so/core';
import {
  isAccountEventRefusal,
  listAccountEvents,
  normalizeUsername,
  verifyAccountEvent,
} from '../../services/accountErasure/oxyAccountEvents';
import { scheduleAccountErasure } from '../../services/accountErasure/accountEventIntake';

beforeEach(() => {
  vi.clearAllMocks();
  client.current = {};
});

describe('oxyAccountEvents adapter', () => {
  it('passes the token through and keeps only a plain handle from the event', async () => {
    const verify = vi.fn(async () => ({ eventId: 'e', userId: 'u', username: '  alice  ' }));
    client.current = { verifyAccountEvent: verify, listAccountEvents: vi.fn() };

    const event = await verifyAccountEvent('a.b.c');

    expect(verify).toHaveBeenCalledWith('a.b.c');
    expect(event.username).toBe('alice');
  });

  it('lists a page with the caller options', async () => {
    const list = vi.fn(async () => ({ events: [], nextCursor: 'c' }));
    client.current = { verifyAccountEvent: vi.fn(), listAccountEvents: list };

    await expect(listAccountEvents({ after: 'x', limit: 5 })).resolves.toEqual({ events: [], nextCursor: 'c' });
    expect(list).toHaveBeenCalledWith({ after: 'x', limit: 5 });
  });

  it('never lets something that is not a handle into an ActivityPub URL', () => {
    expect(normalizeUsername('qatest0925')).toBe('qatest0925');
    expect(normalizeUsername('a/b')).toBeNull();
    expect(normalizeUsername('../x')).toBeNull();
    expect(normalizeUsername('')).toBeNull();
    expect(normalizeUsername(null)).toBeNull();
    expect(normalizeUsername(42)).toBeNull();
    expect(normalizeUsername('x'.repeat(65))).toBeNull();
  });

  it("recognises the SDK's own refusal class", () => {
    expect(isAccountEventRefusal(new OxyAccountEventError('Account event token signature is invalid'))).toBe(true);
  });

  it('recognises the SDK refusal by name only', () => {
    const refusal = new Error('bad signature');
    refusal.name = 'OxyAccountEventError';
    expect(isAccountEventRefusal(refusal)).toBe(true);
    expect(isAccountEventRefusal(new Error('network'))).toBe(false);
    expect(isAccountEventRefusal({ name: 'OxyAccountEventError' })).toBe(false);
  });
});

describe('scheduleAccountErasure', () => {
  const row = {
    id: 'r',
    eventId: 'evt',
    oxyUserId: 'u',
    source: 'webhook' as const,
    status: 'pending' as const,
    attempts: 0,
    username: null,
    completedAt: null,
  };

  it('does nothing for a completed erasure', async () => {
    await scheduleAccountErasure({ ...row, status: 'completed' });
    expect(enqueueAccountErasure).not.toHaveBeenCalled();
    expect(processAccountErasure).not.toHaveBeenCalled();
  });

  it('enqueues under the row attempt generation when a queue exists', async () => {
    enqueueAccountErasure.mockResolvedValue(true);
    await scheduleAccountErasure({ ...row, attempts: 3 });
    expect(enqueueAccountErasure).toHaveBeenCalledWith({ eventId: 'evt' }, 3);
    expect(processAccountErasure).not.toHaveBeenCalled();
  });

  it('runs in-process when there is no queue, swallowing a failure the ledger records', async () => {
    enqueueAccountErasure.mockResolvedValue(false);
    processAccountErasure.mockRejectedValueOnce(new Error('boom'));
    await scheduleAccountErasure(row);
    await vi.waitFor(() => expect(processAccountErasure).toHaveBeenCalledWith('evt'));
  });
});
