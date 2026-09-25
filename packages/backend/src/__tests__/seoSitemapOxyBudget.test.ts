import { beforeEach, describe, expect, it, vi } from 'vitest';

const { makeServiceRequest, store } = vi.hoisted(() => ({
  makeServiceRequest: vi.fn(),
  store: new Map<string, unknown>(),
}));

vi.mock('../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ makeServiceRequest }),
}));

// An in-memory stand-in for the Redis cache: enough to observe what the sitemap
// persists (the built artifact, the failure cooldown marker) without Redis.
vi.mock('../utils/cache', () => ({
  createCache: () => ({
    has: async (key: string) => store.has(key),
    set: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    getOrCompute: async <T>(key: string, compute: () => Promise<T>): Promise<T> => {
      if (store.has(key)) return store.get(key) as T;
      const value = await compute();
      store.set(key, value);
      return value;
    },
  }),
}));

import { bulkUsers } from '../services/seoSitemap';

const rateLimited = (): Error => Object.assign(new Error('HTTP 429: Too Many Requests'), { status: 429 });

describe('sitemap Oxy budget protection', () => {
  beforeEach(() => {
    makeServiceRequest.mockReset();
    store.clear();
  });

  it('resolves users in bounded bulk batches', async () => {
    makeServiceRequest.mockImplementation(async (_method: string, _url: string, body: { ids: string[] }) =>
      body.ids.map((id) => ({ id, username: `u${id}` })));
    const ids = Array.from({ length: 250 }, (_, index) => String(index));

    const users = await bulkUsers([...ids, ...ids]);

    expect(users).toHaveLength(250);
    expect(makeServiceRequest).toHaveBeenCalledTimes(3);
    expect(makeServiceRequest).toHaveBeenCalledWith('POST', '/users/by-ids', { ids: ids.slice(0, 100) });
  });

  it('stops fanning out to Oxy after the first failed batch', async () => {
    makeServiceRequest.mockRejectedValue(rateLimited());
    const ids = Array.from({ length: 14_500 }, (_, index) => String(index));

    await expect(bulkUsers(ids)).rejects.toThrow('HTTP 429');
    // Two concurrent workers: each issues at most one call before the abort.
    expect(makeServiceRequest.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
