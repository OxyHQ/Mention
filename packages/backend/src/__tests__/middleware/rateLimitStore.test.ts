import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  eval: vi.fn(),
  evalSha: vi.fn(),
  ping: vi.fn(),
  connect: vi.fn(),
  client: {
    isReady: true,
    isOpen: true,
    eval: vi.fn(),
    evalSha: vi.fn(),
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
    mocks.client.evalSha = mocks.evalSha;
    mocks.client.ping = mocks.ping;
    mocks.client.connect = mocks.connect;
    mocks.evalSha.mockResolvedValue([3, 60]);
    mocks.eval.mockResolvedValue([3, 60]);
  });

  it('runs the cached script by digest, and only that, when Redis is ready', async () => {
    const store = new RedisStore({ prefix: 'test:', windowMs: 60_000 });

    const result = await store.increment('viewer');

    expect(result.totalHits).toBe(3);
    expect(result.resetTime).toBeInstanceOf(Date);
    expect(mocks.evalSha).toHaveBeenCalledTimes(1);
    expect(mocks.eval).not.toHaveBeenCalled();
    expect(mocks.ping).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('sends the script body once when Redis does not have it cached', async () => {
    mocks.evalSha.mockRejectedValueOnce(new Error('NOSCRIPT No matching script.'));
    const store = new RedisStore({ prefix: 'test:', windowMs: 60_000 });

    await expect(store.increment('viewer')).resolves.toMatchObject({ totalHits: 3 });
    expect(mocks.eval).toHaveBeenCalledTimes(1);
    expect(mocks.eval.mock.calls[0][1]).toEqual(mocks.evalSha.mock.calls[0][1]);
  });

  it('returns the permissive fallback without issuing a command while unready', async () => {
    mocks.client.isReady = false;
    const store = new RedisStore({ prefix: 'test:', windowMs: 60_000 });

    await expect(store.increment('viewer')).resolves.toEqual({
      totalHits: 1,
      resetTime: undefined,
    });
    expect(mocks.evalSha).not.toHaveBeenCalled();
    expect(mocks.ping).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('never returns NaN when Redis contains a malformed counter', async () => {
    mocks.evalSha.mockResolvedValueOnce(['not-a-number', -1]);
    const store = new RedisStore({ prefix: 'test:', windowMs: 60_000 });

    await expect(store.increment('viewer')).resolves.toEqual({
      totalHits: 1,
      resetTime: undefined,
    });
  });
});
