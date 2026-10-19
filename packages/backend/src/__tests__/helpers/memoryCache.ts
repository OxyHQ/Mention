import type { Cache, CacheComputeOptions } from '../../utils/cache';

/**
 * An in-memory stand-in for `createCache`, for a test that has to observe a
 * cache hit — the suite runs without Redis, where every real cache is a miss.
 * Same contract as the real one where tests can see it: a computed value is
 * written unless `ttlSecondsFor` returns `null`, and `delete` evicts.
 */
export function createMemoryCache(store = new Map<string, unknown>()): Cache {
  return {
    async get<T>(key: string) {
      return store.get(key) as T | undefined;
    },
    async getMany<T>(keys: string[]) {
      return keys.map((key) => store.get(key) as T | undefined);
    },
    async has(key: string) {
      return store.has(key);
    },
    async set<T>(key: string, value: T) {
      store.set(key, value);
    },
    async setMany<T>(entries: Iterable<readonly [string, T]>) {
      for (const [key, value] of entries) store.set(key, value);
    },
    async delete(keys: string[]) {
      for (const key of keys) store.delete(key);
    },
    async getOrCompute<T>(
      key: string,
      compute: () => Promise<T>,
      options?: CacheComputeOptions<T>,
    ): Promise<T> {
      if (store.has(key)) return store.get(key) as T;
      const value = await compute();
      if (!options?.ttlSecondsFor || options.ttlSecondsFor(value) !== null) store.set(key, value);
      return value;
    },
  };
}
