import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalTtlCache } from '../../utils/localTtlCache';

describe('LocalTtlCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('expires entries and evicts only the least recently used on overflow', () => {
    const cache = new LocalTtlCache<number>({ ttlMs: 1000, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // a is now the most recent
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    vi.advanceTimersByTime(1000);
    expect(cache.get('a')).toBeUndefined();
  });

  it('shares one in-flight load, caches a fallback briefly and never caches a rejection', async () => {
    const cache = new LocalTtlCache<boolean>({ ttlMs: 10_000, negativeTtlMs: 100, maxEntries: 10 });
    const load = vi.fn().mockRejectedValue(new Error('429'));
    const fallback = () => false;

    const burst = await Promise.all([
      cache.getOrLoad('u', load, fallback),
      cache.getOrLoad('u', load, fallback),
    ]);
    expect(burst).toEqual([false, false]);
    expect(load).toHaveBeenCalledTimes(1);

    await cache.getOrLoad('u', load, fallback);
    expect(load).toHaveBeenCalledTimes(1); // negative answer is remembered
    vi.advanceTimersByTime(100);
    await cache.getOrLoad('u', load, fallback);
    expect(load).toHaveBeenCalledTimes(2);

    await expect(cache.getOrLoad('other', load)).rejects.toThrow('429');
    await expect(cache.getOrLoad('other', load)).rejects.toThrow('429');
    expect(load).toHaveBeenCalledTimes(4);
  });
});
