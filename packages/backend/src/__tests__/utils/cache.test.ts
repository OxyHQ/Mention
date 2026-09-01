/**
 * Unit coverage for the shared Redis cache primitive (`utils/cache.ts`).
 *
 * The three things every cache in this backend used to re-implement by hand are
 * what these tests pin:
 *
 *  - **Stampede protection.** N concurrent callers for one cold key must produce
 *    ONE computation. The test drives that with a compute that cannot settle
 *    until every caller has entered, so it fails (10 computations, not 1) the
 *    moment the single-flight map is removed — a concurrency test that passes
 *    either way is worth nothing.
 *  - **Fail-open.** Redis being unready, throwing, or answering with a shape it
 *    should not, degrades to a miss/no-op — never to an error reaching the caller.
 *  - **Serialization + TTL.** One JSON path, one atomic `SETEX` per key, one
 *    guard against the non-array `MGET` reply ElastiCache Valkey can hand back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const client = {
  isReady: true,
  get: vi.fn(),
  mGet: vi.fn(),
  exists: vi.fn(),
  setEx: vi.fn(),
  del: vi.fn(),
  multi: vi.fn(),
};

const pipeline = {
  setEx: vi.fn(),
  exec: vi.fn(),
};

const reportRedisConnectionFailure = vi.fn();

vi.mock('../../utils/redis', () => ({
  getRedisClient: () => client,
  reportRedisConnectionFailure: (...args: unknown[]) => reportRedisConnectionFailure(...args),
}));

import { createCache } from '../../utils/cache';
import { logger } from '../../utils/logger';

/** A promise a test resolves by hand, so "concurrent" really means concurrent. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  client.isReady = true;
  client.get.mockResolvedValue(null);
  client.mGet.mockResolvedValue([]);
  client.exists.mockResolvedValue(0);
  client.setEx.mockResolvedValue('OK');
  client.del.mockResolvedValue(1);
  client.multi.mockReturnValue(pipeline);
  pipeline.exec.mockResolvedValue([]);
});

describe('createCache', () => {
  it('refuses a non-positive default TTL — a TTL-less entry is never intended', () => {
    expect(() => createCache({ name: 'Bad', ttlSeconds: 0 })).toThrow(/positive/);
  });
});

describe('cache.get / set', () => {
  const cache = createCache({ name: 'Test', ttlSeconds: 30 });

  it('returns the parsed value on a hit', async () => {
    client.get.mockResolvedValue(JSON.stringify({ a: 1 }));
    await expect(cache.get<{ a: number }>('k')).resolves.toEqual({ a: 1 });
  });

  it('returns undefined on a miss', async () => {
    await expect(cache.get('k')).resolves.toBeUndefined();
  });

  it('treats a corrupt entry as a miss instead of throwing', async () => {
    client.get.mockResolvedValue('{not json');
    await expect(cache.get('k')).resolves.toBeUndefined();
  });

  it('degrades to a miss when Redis throws, without touching the caller', async () => {
    client.get.mockRejectedValue(new Error('boom'));
    await expect(cache.get('k')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith('[Test] get failed', { reason: 'boom' });
  });

  it('reports a CONNECTION failure to the supervisor and stays quiet at warn', async () => {
    client.get.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));

    await expect(cache.get('k')).resolves.toBeUndefined();

    expect(reportRedisConnectionFailure).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not issue a command at all when the client is not ready', async () => {
    client.isReady = false;
    await expect(cache.get('k')).resolves.toBeUndefined();
    await cache.set('k', { a: 1 });
    expect(client.get).not.toHaveBeenCalled();
    expect(client.setEx).not.toHaveBeenCalled();
  });

  it('writes with the instance TTL, and with a per-call override', async () => {
    await cache.set('k', { a: 1 });
    expect(client.setEx).toHaveBeenCalledWith('k', 30, JSON.stringify({ a: 1 }));

    await cache.set('k', { a: 2 }, { ttlSeconds: 5 });
    expect(client.setEx).toHaveBeenLastCalledWith('k', 5, JSON.stringify({ a: 2 }));
  });

  it('swallows a write failure', async () => {
    client.setEx.mockRejectedValue(new Error('boom'));
    await expect(cache.set('k', { a: 1 })).resolves.toBeUndefined();
  });
});

describe('cache.getMany / setMany / delete / has', () => {
  const cache = createCache({ name: 'Test', ttlSeconds: 30 });

  it('answers positionally, with undefined for misses and corrupt entries', async () => {
    client.mGet.mockResolvedValue([JSON.stringify({ id: 'a' }), null, '{corrupt']);

    const values = await cache.getMany<{ id: string }>(['ka', 'kb', 'kc']);

    expect(values).toEqual([{ id: 'a' }, undefined, undefined]);
    expect(client.mGet).toHaveBeenCalledWith(['ka', 'kb', 'kc']);
  });

  it('treats a non-array MGET reply as a full miss and warns exactly once', async () => {
    client.mGet.mockResolvedValue({ not: 'an-array' });

    await expect(cache.getMany(['ka', 'kb'])).resolves.toEqual([undefined, undefined]);
    await expect(cache.getMany(['kc'])).resolves.toEqual([undefined]);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('non-array'),
      expect.objectContaining({ replyType: 'object', constructorName: 'Object', keyCount: 2 }),
    );
  });

  it('short-circuits an empty batch without a round trip', async () => {
    await expect(cache.getMany([])).resolves.toEqual([]);
    await cache.setMany([]);
    await cache.delete([]);
    expect(client.mGet).not.toHaveBeenCalled();
    expect(client.multi).not.toHaveBeenCalled();
    expect(client.del).not.toHaveBeenCalled();
  });

  it('writes a batch through one pipeline, each key with its own TTL', async () => {
    await cache.setMany([
      ['ka', { id: 'a' }],
      ['kb', { id: 'b' }],
    ]);

    expect(client.multi).toHaveBeenCalledTimes(1);
    expect(pipeline.setEx).toHaveBeenCalledTimes(2);
    expect(pipeline.setEx).toHaveBeenCalledWith('ka', 30, JSON.stringify({ id: 'a' }));
    expect(pipeline.exec).toHaveBeenCalledTimes(1);
  });

  it('checks existence without pulling the payload', async () => {
    client.exists.mockResolvedValue(1);
    await expect(cache.has('k')).resolves.toBe(true);
    expect(client.get).not.toHaveBeenCalled();

    client.exists.mockRejectedValue(new Error('boom'));
    await expect(cache.has('k')).resolves.toBe(false);
  });

  it('deletes in one command and swallows a failure', async () => {
    await cache.delete(['ka', 'kb']);
    expect(client.del).toHaveBeenCalledWith(['ka', 'kb']);

    client.del.mockRejectedValue(new Error('boom'));
    await expect(cache.delete(['ka'])).resolves.toBeUndefined();
  });
});

describe('cache.getOrCompute', () => {
  const cache = createCache({ name: 'Test', ttlSeconds: 30 });

  it('serves a hit without computing', async () => {
    client.get.mockResolvedValue(JSON.stringify('cached'));
    const compute = vi.fn();

    await expect(cache.getOrCompute('k', compute)).resolves.toBe('cached');
    expect(compute).not.toHaveBeenCalled();
  });

  it('computes a miss and writes it with the instance TTL', async () => {
    await expect(cache.getOrCompute('k', async () => 'fresh')).resolves.toBe('fresh');
    expect(client.setEx).toHaveBeenCalledWith('k', 30, JSON.stringify('fresh'));
  });

  it('collapses concurrent misses for one key into a SINGLE computation', async () => {
    const gate = deferred<string>();
    const compute = vi.fn(() => gate.promise);

    // Every caller is launched before the computation is allowed to settle, so
    // the count below measures deduplication and not merely a warm cache.
    const callers = Array.from({ length: 10 }, () => cache.getOrCompute('k', compute));
    // Let every caller get past its cache READ (and therefore into the
    // single-flight map) before the one computation is allowed to settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    gate.resolve('once');

    await expect(Promise.all(callers)).resolves.toEqual(Array(10).fill('once'));
    expect(compute).toHaveBeenCalledTimes(1);
    expect(client.setEx).toHaveBeenCalledTimes(1);
  });

  it('deduplicates per key, not across keys', async () => {
    const compute = vi.fn(async () => 'v');

    await Promise.all([
      cache.getOrCompute('ka', compute),
      cache.getOrCompute('kb', compute),
    ]);

    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('coalesces a burst without becoming a memo — a later miss recomputes', async () => {
    const compute = vi.fn(async () => 'v');

    await cache.getOrCompute('k', compute);
    await cache.getOrCompute('k', compute);

    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('returns a value that ttlSecondsFor refuses, without caching it', async () => {
    const degraded = { username: '', displayName: 'Unknown user' };

    await expect(
      cache.getOrCompute('k', async () => degraded, { ttlSecondsFor: () => null }),
    ).resolves.toBe(degraded);
    expect(client.setEx).not.toHaveBeenCalled();
  });

  it('applies a value-dependent TTL', async () => {
    await cache.getOrCompute<string | null>('k', async () => null, {
      ttlSecondsFor: (value) => (value ? 3600 : 60),
    });
    expect(client.setEx).toHaveBeenCalledWith('k', 60, JSON.stringify(null));
  });

  it('propagates a computation failure to every sharing caller and caches nothing', async () => {
    const failure = new Error('upstream down');
    const compute = vi.fn(async () => {
      throw failure;
    });

    const callers = [cache.getOrCompute('k', compute), cache.getOrCompute('k', compute)];

    await expect(Promise.allSettled(callers)).resolves.toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ]);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(client.setEx).not.toHaveBeenCalled();
  });

  it('still computes when Redis is unavailable', async () => {
    client.isReady = false;
    await expect(cache.getOrCompute('k', async () => 'fresh')).resolves.toBe('fresh');
  });
});

describe('cache.getOrCompute with stale-while-revalidate', () => {
  const FRESH_MS = 5 * 60 * 1000;
  const cache = createCache({ name: 'Swr', ttlSeconds: 3600, staleAfterMs: FRESH_MS });

  const envelope = (value: unknown, ageMs: number) =>
    JSON.stringify({ value, cachedAt: Date.now() - ageMs });

  it('stores an envelope so an entry has a knowable age', async () => {
    await cache.set('k', 'v');
    const [, , body] = client.setEx.mock.calls[0];
    expect(JSON.parse(body as string)).toEqual({
      value: 'v',
      cachedAt: expect.any(Number),
    });
  });

  it('serves a fresh entry without computing', async () => {
    client.get.mockResolvedValue(envelope('cached', 1_000));
    const compute = vi.fn();

    await expect(cache.getOrCompute('k', compute)).resolves.toBe('cached');
    expect(compute).not.toHaveBeenCalled();
  });

  it('serves a stale entry immediately and refreshes it exactly once behind the response', async () => {
    client.get.mockResolvedValue(envelope('stale', FRESH_MS + 1_000));
    const gate = deferred<string>();
    const compute = vi.fn(() => gate.promise);

    const served = await Promise.all([
      cache.getOrCompute('k', compute),
      cache.getOrCompute('k', compute),
      cache.getOrCompute('k', compute),
    ]);

    expect(served).toEqual(['stale', 'stale', 'stale']);
    expect(compute).toHaveBeenCalledTimes(1);

    gate.resolve('refreshed');
    await gate.promise;
    await vi.waitFor(() => expect(client.setEx).toHaveBeenCalledTimes(1));
  });

  it('swallows a failed background refresh — the caller already has its answer', async () => {
    client.get.mockResolvedValue(envelope('stale', FRESH_MS + 1_000));
    const compute = vi.fn(async () => {
      throw new Error('upstream down');
    });

    await expect(cache.getOrCompute('k', compute)).resolves.toBe('stale');
    await vi.waitFor(() =>
      expect(logger.debug).toHaveBeenCalledWith('[Swr] Background refresh failed', {
        reason: 'upstream down',
      }),
    );
  });

  it('discards an entry written before the envelope existed', async () => {
    client.get.mockResolvedValue(JSON.stringify('raw-legacy-value'));

    await expect(cache.getOrCompute('k', async () => 'recomputed')).resolves.toBe('recomputed');
  });
});
