import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit coverage for {@link anonFeedCache} — the fail-soft Redis cache for the
 * anonymous main-feed page.
 *
 * Redis is stubbed with a driveable get/setEx so key derivation, read hits/
 * misses, TTL, and the fail-soft error paths are exercised without a real
 * server. Only anonymous pages are ever cached; the controller gates that.
 */

const mocks = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSetEx: vi.fn(),
}));

vi.mock('../../utils/redis', () => ({
  getRedisClient: () => ({
    isReady: true,
    get: mocks.redisGet,
    setEx: mocks.redisSetEx,
  }),
}));

import { anonFeedCache } from '../../services/anonFeedCache';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('anonFeedCache.buildKey', () => {
  it('is stable and independent of filter key order', () => {
    const a = anonFeedCache.buildKey({
      type: 'mixed',
      limit: 20,
      filters: { language: 'en', authors: 'x,y' },
    });
    const b = anonFeedCache.buildKey({
      type: 'mixed',
      limit: 20,
      filters: { authors: 'x,y', language: 'en' },
    });
    expect(a).toBe(b);
  });

  it('changes when the descriptor, sort, limit, cursor, or filters change', () => {
    const base = { type: 'mixed', sort: 'recent', limit: 20, cursor: 'c1', filters: { language: 'en' } };
    const key = anonFeedCache.buildKey(base);

    expect(key).not.toBe(anonFeedCache.buildKey({ ...base, type: 'posts' }));
    expect(key).not.toBe(anonFeedCache.buildKey({ ...base, sort: 'best' }));
    expect(key).not.toBe(anonFeedCache.buildKey({ ...base, limit: 40 }));
    expect(key).not.toBe(anonFeedCache.buildKey({ ...base, cursor: 'c2' }));
    expect(key).not.toBe(anonFeedCache.buildKey({ ...base, filters: { language: 'es' } }));
  });

  it('uses a stable "none" fingerprint when there are no filters', () => {
    const key = anonFeedCache.buildKey({ type: 'mixed', limit: 20 });
    expect(key).toContain(':none');
    expect(key.startsWith('anonfeed:v1:mixed:default:20:first:')).toBe(true);
  });

  it('isolates keyspaces by namespace so overlapping type names never collide', () => {
    const legacy = anonFeedCache.buildKey({ type: 'for_you', limit: 20 });
    const mtn = anonFeedCache.buildKey({ namespace: 'mtn', type: 'for_you', limit: 20 });

    expect(legacy).not.toBe(mtn);
    expect(legacy.startsWith('anonfeed:v1:for_you:')).toBe(true);
    expect(mtn.startsWith('anonfeed:v1:mtn:for_you:')).toBe(true);
  });
});

describe('anonFeedCache.read', () => {
  it('returns the parsed payload on a hit', async () => {
    const payload = { items: [{ id: 'p1' }], hasMore: false, totalCount: 1 };
    mocks.redisGet.mockResolvedValue(JSON.stringify(payload));

    const result = await anonFeedCache.read('k');
    expect(result).toEqual(payload);
  });

  it('returns null on a miss', async () => {
    mocks.redisGet.mockResolvedValue(null);
    expect(await anonFeedCache.read('k')).toBeNull();
  });

  it('returns null (fail-soft) when Redis throws', async () => {
    mocks.redisGet.mockRejectedValue(new Error('redis down'));
    expect(await anonFeedCache.read('k')).toBeNull();
  });
});

describe('anonFeedCache.write', () => {
  it('persists the response with the short TTL', async () => {
    const payload = { items: [], hasMore: false, totalCount: 0 };
    await anonFeedCache.write('k', payload);

    expect(mocks.redisSetEx).toHaveBeenCalledTimes(1);
    const [key, ttl, body] = mocks.redisSetEx.mock.calls[0];
    expect(key).toBe('k');
    expect(ttl).toBe(45);
    expect(JSON.parse(body)).toEqual(payload);
  });

  it('does not throw (fail-soft) when Redis write fails', async () => {
    mocks.redisSetEx.mockRejectedValue(new Error('redis down'));
    await expect(anonFeedCache.write('k', { items: [], hasMore: false, totalCount: 0 })).resolves.toBeUndefined();
  });
});
