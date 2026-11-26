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
  revalidate: vi.fn(async (entry) => entry.page),
  redisSetEx: vi.fn(),
}));

vi.mock('../../services/feed/revalidateAnonymousFeed', () => ({
  revalidateAnonymousFeed: mocks.revalidate,
}));

vi.mock('../../utils/redis', () => ({
  getRedisClient: () => ({
    isReady: true,
    get: mocks.redisGet,
    setEx: mocks.redisSetEx,
  }),
}));

import { anonFeedCache } from '../../services/feed/anonFeedCache';

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
    const base = {
      type: 'mixed',
      sort: 'recent',
      limit: 20,
      cursor: 'c1',
      filters: { language: 'en' },
    };
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
    expect(key.startsWith('anonfeed:v3:mixed:default:20:first:')).toBe(true);
  });

  it('isolates keyspaces by namespace so overlapping type names never collide', () => {
    const legacy = anonFeedCache.buildKey({ type: 'for_you', limit: 20 });
    const mtn = anonFeedCache.buildKey({ namespace: 'mtn', type: 'for_you', limit: 20 });

    expect(legacy).not.toBe(mtn);
    expect(legacy.startsWith('anonfeed:v3:for_you:')).toBe(true);
    expect(mtn.startsWith('anonfeed:v3:mtn:for_you:')).toBe(true);
  });
});

describe('anonFeedCache.read', () => {
  it('returns the revalidated page on a hit', async () => {
    const payload = { items: [{ id: 'p1' }], hasMore: false, totalCount: 1 };
    const entry = { page: payload, revisions: { p1: 'r1' }, unratedMaterialAllowed: true };
    mocks.redisGet.mockResolvedValue(JSON.stringify({ cachedAt: Date.now(), entry }));

    const result = await anonFeedCache.read('k');
    expect(mocks.revalidate).toHaveBeenCalledWith(entry, undefined);
    expect(result).toEqual(payload);
  });

  it('does not serve a page older than the freshness window from read, but readStale does', async () => {
    const entry = { page: { items: [{ id: 'p1' }], hasMore: false, totalCount: 1 }, revisions: {} };
    mocks.redisGet.mockResolvedValue(JSON.stringify({ cachedAt: Date.now() - 60_000, entry }));

    expect(await anonFeedCache.read('k')).toBeNull();
    expect(await anonFeedCache.readStale('k')).toEqual(entry.page);
    expect(mocks.revalidate).toHaveBeenCalledTimes(1);
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

describe('degraded pages (an author Oxy could not resolve)', () => {
  const page = { items: [{ id: 'p1' }], hasMore: false, totalCount: 1 };
  const entry = { page, revisions: {} };

  it('are never served as fresh, only as the stale page of last resort', async () => {
    mocks.redisGet.mockResolvedValue(
      JSON.stringify({ cachedAt: Date.now(), entry, degraded: true }),
    );

    expect(await anonFeedCache.read('k')).toBeNull();
    expect(await anonFeedCache.readStale('k')).toEqual(page);
  });

  it('are stored flagged, but never over a page that is already kept', async () => {
    mocks.redisGet.mockResolvedValueOnce(null);
    await anonFeedCache.write('k', entry, { degraded: true });
    expect(JSON.parse(mocks.redisSetEx.mock.calls[0][2]).degraded).toBe(true);

    mocks.redisSetEx.mockClear();
    mocks.redisGet.mockResolvedValueOnce(JSON.stringify({ cachedAt: Date.now(), entry }));
    await anonFeedCache.write('k', entry, { degraded: true });
    expect(mocks.redisSetEx).not.toHaveBeenCalled();
  });
});

describe('anonFeedCache.write', () => {
  it('persists the response with its build time, kept far longer than it is fresh', async () => {
    const payload = { page: { items: [], hasMore: false, totalCount: 0 }, revisions: {} };
    await anonFeedCache.write('k', payload);

    expect(mocks.redisSetEx).toHaveBeenCalledTimes(1);
    const [key, ttl, body] = mocks.redisSetEx.mock.calls[0];
    expect(key).toBe('k');
    expect(ttl).toBe(15 * 60);
    const stored = JSON.parse(body);
    expect(stored.entry).toEqual(payload);
    expect(Math.abs(stored.cachedAt - Date.now())).toBeLessThan(5_000);
  });

  it('does not throw (fail-soft) when Redis write fails', async () => {
    mocks.redisSetEx.mockRejectedValue(new Error('redis down'));
    await expect(
      anonFeedCache.write('k', {
        page: { items: [], hasMore: false, totalCount: 0 },
        revisions: {},
      }),
    ).resolves.toBeUndefined();
  });
});
