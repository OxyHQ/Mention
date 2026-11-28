/**
 * A small in-process cache: bounded, TTL'd, least-recently-used, with
 * per-process single-flight loading.
 *
 * `utils/cache.ts` is the shared Redis cache; this is the other half, for a
 * value that is cheap to keep in memory and costs an upstream call or a query
 * to recompute. It is per task, so callers keep the TTL short.
 *
 * - Insertion-ordered `Map`: the first key is the least recently used. A hit is
 *   re-inserted, and overflow evicts only that oldest entry (never a wholesale
 *   clear).
 * - {@link LocalTtlCache.getOrLoad} shares one in-flight load between
 *   concurrent callers of a key.
 * - A load that fails may be answered by a fallback, remembered for the shorter
 *   `negativeTtlMs`, so a struggling upstream is not retried on every request.
 *
 * Values are shared between callers and must be treated as read-only.
 */
export interface LocalTtlCacheOptions {
  ttlMs: number;
  maxEntries: number;
  /** How long a fallback answer from a failed load is kept. Defaults to `ttlMs`. */
  negativeTtlMs?: number;
}

export class LocalTtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<V>>();

  constructor(private readonly options: LocalTtlCacheOptions) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= Date.now()) return undefined;
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number = this.options.ttlMs): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    if (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /**
   * The cached value, else the result of `load`, shared by every concurrent
   * caller of `key`. When `load` rejects, `fallback` (if given) supplies the
   * answer and it is cached for `negativeTtlMs`; without one the rejection
   * propagates and nothing is cached.
   */
  getOrLoad(key: string, load: () => Promise<V>, fallback?: (error: unknown) => V): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const run = (async () => {
      try {
        const value = await load();
        this.set(key, value);
        return value;
      } catch (error) {
        if (!fallback) throw error;
        const value = fallback(error);
        this.set(key, value, this.options.negativeTtlMs ?? this.options.ttlMs);
        return value;
      }
    })().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, run);
    return run;
  }
}
