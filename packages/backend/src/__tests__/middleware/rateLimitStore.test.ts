import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  eval: vi.fn(),
  ping: vi.fn(),
  connect: vi.fn(),
  client: {
    isReady: true,
    isOpen: true,
    eval: vi.fn(),
    ping: vi.fn(),
    connect: vi.fn(),
  },
}));

vi.mock('../../utils/redis', () => ({
  getRedisClient: () => mocks.client,
}));

import { RedisStore } from '../../middleware/rateLimitStore';

describe('RedisStore increment hot path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.isReady = true;
    mocks.client.isOpen = true;
    mocks.client.eval = mocks.eval;
    mocks.client.ping = mocks.ping;
    mocks.client.connect = mocks.connect;
    mocks.eval.mockResolvedValue([3, 60]);
  });

  it('executes only the atomic EVAL when Redis is ready', async () => {
    const store = new RedisStore({ prefix: 'test:', windowMs: 60_000 });

    const result = await store.increment('viewer');

    expect(result.totalHits).toBe(3);
    expect(result.resetTime).toBeInstanceOf(Date);
    expect(mocks.eval).toHaveBeenCalledTimes(1);
    expect(mocks.ping).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('returns the permissive fallback without issuing a command while unready', async () => {
    mocks.client.isReady = false;
    const store = new RedisStore({ prefix: 'test:', windowMs: 60_000 });

    await expect(store.increment('viewer')).resolves.toEqual({
      totalHits: 1,
      resetTime: undefined,
    });
    expect(mocks.eval).not.toHaveBeenCalled();
    expect(mocks.ping).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('never returns NaN when Redis contains a malformed counter', async () => {
    mocks.eval.mockResolvedValueOnce(['not-a-number', -1]);
    const store = new RedisStore({ prefix: 'test:', windowMs: 60_000 });

    await expect(store.increment('viewer')).resolves.toEqual({
      totalHits: 1,
      resetTime: undefined,
    });
  });
});
