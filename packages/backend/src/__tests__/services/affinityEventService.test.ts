import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isRedisConnected: vi.fn(),
  lPush: vi.fn(),
  lTrim: vi.fn(),
  multiLRange: vi.fn(),
  multiLTrim: vi.fn(),
  multiExec: vi.fn(),
  pushEvents: vi.fn(),
}));

/** A chainable MULTI stub whose `exec()` resolves to `multiExec`'s value. */
function makeMulti() {
  const chain = {
    lRange: (...args: unknown[]) => {
      mocks.multiLRange(...args);
      return chain;
    },
    lTrim: (...args: unknown[]) => {
      mocks.multiLTrim(...args);
      return chain;
    },
    exec: () => mocks.multiExec(),
  };
  return chain;
}

vi.mock('../../utils/redis', () => ({
  isRedisConnected: () => mocks.isRedisConnected(),
  getRedisClient: () => ({
    lPush: mocks.lPush,
    lTrim: mocks.lTrim,
    multi: () => makeMulti(),
  }),
}));

import {
  AffinityEventService,
  AFFINITY_BUFFER_KEY,
  AFFINITY_BUFFER_MAX_LEN,
  AFFINITY_DRAIN_BATCH_SIZE,
} from '../../services/AffinityEventService';

const signalsClient = { pushEvents: mocks.pushEvents, pushEndorsements: vi.fn(), pushInterests: vi.fn() };

function makeService() {
  return new AffinityEventService(signalsClient as unknown as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isRedisConnected.mockResolvedValue(true);
  mocks.lPush.mockResolvedValue(1);
  mocks.lTrim.mockResolvedValue('OK');
  mocks.multiExec.mockResolvedValue([[], 'OK']);
  mocks.pushEvents.mockResolvedValue(undefined);
});

describe('AffinityEventService.record', () => {
  it('buffers a compact event to the Redis list and caps the buffer length', async () => {
    const service = makeService();
    const ok = await service.record({ fromUserId: 'a', toUserId: 'b', type: 'like', eventId: 'like:1' });

    expect(ok).toBe(true);
    expect(mocks.lPush).toHaveBeenCalledTimes(1);
    const [key, payload] = mocks.lPush.mock.calls[0];
    expect(key).toBe(AFFINITY_BUFFER_KEY);
    const parsed = JSON.parse(String(payload));
    expect(parsed).toMatchObject({ fromUserId: 'a', toUserId: 'b', type: 'like', eventId: 'like:1' });
    expect(typeof parsed.occurredAt).toBe('string');

    // Buffer capped to [0, MAX-1] on every push.
    expect(mocks.lTrim).toHaveBeenCalledWith(AFFINITY_BUFFER_KEY, 0, AFFINITY_BUFFER_MAX_LEN - 1);
  });

  it('skips self-interactions (from === to) without touching Redis', async () => {
    const service = makeService();
    const ok = await service.record({ fromUserId: 'a', toUserId: 'a', type: 'like' });

    expect(ok).toBe(false);
    expect(mocks.isRedisConnected).not.toHaveBeenCalled();
    expect(mocks.lPush).not.toHaveBeenCalled();
  });

  it('skips events missing either party', async () => {
    const service = makeService();
    expect(await service.record({ fromUserId: '', toUserId: 'b', type: 'like' })).toBe(false);
    expect(await service.record({ fromUserId: 'a', toUserId: '', type: 'like' })).toBe(false);
    expect(mocks.lPush).not.toHaveBeenCalled();
  });

  it('no-ops when Redis is not connected', async () => {
    mocks.isRedisConnected.mockResolvedValue(false);
    const service = makeService();
    const ok = await service.record({ fromUserId: 'a', toUserId: 'b', type: 'like' });

    expect(ok).toBe(false);
    expect(mocks.lPush).not.toHaveBeenCalled();
  });

  it('is fire-and-forget: a Redis error is swallowed and never propagates to the caller', async () => {
    mocks.lPush.mockRejectedValue(new Error('redis down'));
    const service = makeService();

    // Must resolve (to false), never reject.
    await expect(service.record({ fromUserId: 'a', toUserId: 'b', type: 'like' })).resolves.toBe(false);
  });
});

describe('AffinityEventService.drainOnce', () => {
  it('atomically claims a batch (LRANGE + LTRIM in one MULTI) and pushes to Oxy', async () => {
    const buffered = [
      JSON.stringify({ fromUserId: 'a', toUserId: 'b', type: 'like', eventId: 'like:1' }),
      JSON.stringify({ fromUserId: 'c', toUserId: 'd', type: 'boost', eventId: 'boost:2' }),
    ];
    mocks.multiExec.mockResolvedValue([buffered, 'OK']);

    const service = makeService();
    const count = await service.drainOnce();

    expect(count).toBe(2);
    // Claim reads the newest batch and trims it off in the same MULTI.
    expect(mocks.multiLRange).toHaveBeenCalledWith(AFFINITY_BUFFER_KEY, 0, AFFINITY_DRAIN_BATCH_SIZE - 1);
    expect(mocks.multiLTrim).toHaveBeenCalledWith(AFFINITY_BUFFER_KEY, AFFINITY_DRAIN_BATCH_SIZE, -1);

    expect(mocks.pushEvents).toHaveBeenCalledTimes(1);
    const events = mocks.pushEvents.mock.calls[0][0];
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ fromUserId: 'a', toUserId: 'b', type: 'like' });
  });

  it('returns 0 and never calls pushEvents when the buffer is empty', async () => {
    mocks.multiExec.mockResolvedValue([[], 'OK']);
    const service = makeService();

    expect(await service.drainOnce()).toBe(0);
    expect(mocks.pushEvents).not.toHaveBeenCalled();
  });

  it('no-ops when Redis is not connected', async () => {
    mocks.isRedisConnected.mockResolvedValue(false);
    const service = makeService();

    expect(await service.drainOnce()).toBe(0);
    expect(mocks.multiExec).not.toHaveBeenCalled();
    expect(mocks.pushEvents).not.toHaveBeenCalled();
  });

  it('drops malformed buffered entries instead of pushing them', async () => {
    mocks.multiExec.mockResolvedValue([
      ['not-json', JSON.stringify({ fromUserId: 'a', toUserId: 'b', type: 'like' })],
      'OK',
    ]);
    const service = makeService();
    const count = await service.drainOnce();

    expect(count).toBe(1);
    expect(mocks.pushEvents.mock.calls[0][0]).toHaveLength(1);
  });

  it('re-buffers the claimed batch (once) and returns 0 when the push fails', async () => {
    const buffered = [JSON.stringify({ fromUserId: 'a', toUserId: 'b', type: 'like', eventId: 'like:1' })];
    mocks.multiExec.mockResolvedValue([buffered, 'OK']);
    mocks.pushEvents.mockRejectedValue(new Error('oxy down'));

    const service = makeService();
    const count = await service.drainOnce();

    expect(count).toBe(0);
    // The claimed batch is pushed back onto the buffer for the next tick.
    expect(mocks.lPush).toHaveBeenCalledTimes(1);
    expect(mocks.lTrim).toHaveBeenCalledWith(AFFINITY_BUFFER_KEY, 0, AFFINITY_BUFFER_MAX_LEN - 1);
  });

  it('never throws when the drain claim itself fails', async () => {
    mocks.multiExec.mockRejectedValue(new Error('redis exploded'));
    const service = makeService();

    await expect(service.drainOnce()).resolves.toBe(0);
    expect(mocks.pushEvents).not.toHaveBeenCalled();
  });
});
