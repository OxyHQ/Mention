/**
 * The shared Redis cache primitive.
 *
 * Every genuine cache in this backend was re-implementing the SAME three
 * concerns by hand — JSON in/out, a TTL'd write, and "a Redis failure must
 * degrade to computing the value, never to an error reaching the caller" — and
 * each one drifted: some swallowed every failure, some re-threw anything that
 * was not a connection error, only one deduplicated concurrent misses, and only
 * one guarded against the non-array `MGET` reply that ElastiCache Valkey can
 * hand back. This module is the ONE implementation of those concerns.
 *
 * What it deliberately does NOT own:
 *
 *  - **Key derivation.** Each cache builds its own key (a SHA-256 fingerprint of
 *    a long URL, a versioned prefix, a lowercased handle). That is domain logic
 *    and it is where the cache's *versioning* lives, so callers pass FULL Redis
 *    keys here.
 *  - **What is worth caching.** `getOrCompute` writes only what `ttlSecondsFor`
 *    says to write, so a caller can compute a value, return it, and still refuse
 *    to persist it (author hydration's degraded `'Unknown user'` summary is
 *    returned to the renderer and must NEVER reach Redis).
 *  - **Locking.** {@link Cache.getOrCompute}'s stampede protection is
 *    per-PROCESS single-flight, not a distributed lock: N concurrent callers in
 *    ONE process share one computation. Distributed mutual exclusion belongs to
 *    `services/LeaderElection.ts`, which is not a cache.
 *
 * FAIL-OPEN CONTRACT: no method here ever rejects because of Redis. A read
 * degrades to a miss and a write degrades to a no-op, so the caller behaves
 * exactly as it would with no cache at all. A CONNECTION failure is reported to
 * the client supervisor ({@link reportRedisConnectionFailure}) and logged at
 * `debug` — the supervisor already logs the outage once. Any OTHER failure is
 * unexpected (a corrupt reply, a serialization bug) and is logged at `warn` so
 * it stays visible instead of hiding behind a degraded cache.
 */
import { logger } from './logger';
import { getRedisClient, reportRedisConnectionFailure } from './redis';
import { isRedisConnectionError } from './redisHelpers';

/** How a cache instance stores its values; see {@link CacheConfig.staleAfterMs}. */
interface StoredEnvelope<T> {
  /** The cached payload. */
  value: T;
  /** Epoch ms the entry was written — drives the fresh/stale decision. */
  cachedAt: number;
}

/** A decoded entry. `cachedAt` is `null` for a cache that stores values raw. */
interface DecodedEntry<T> {
  value: T;
  cachedAt: number | null;
}

export interface CacheConfig {
  /**
   * Log label for this cache, e.g. `UserSummaryCache`. Appears as `[name]` in
   * every diagnostic so an operator can tell which cache degraded.
   */
  name: string;
  /**
   * Default lifetime, in seconds, applied by every write that does not override
   * it. Must be positive — a zero/negative TTL is a permanent entry in disguise.
   */
  ttlSeconds: number;
  /**
   * Opt into stale-while-revalidate for {@link Cache.getOrCompute}: an entry
   * younger than this is served as-is; an older one is STILL served immediately
   * while a single background recomputation refreshes it. Omitted ⇒ a cache hit
   * is always served and only a miss computes.
   *
   * This is an instance-wide STORAGE decision, not a per-call one: an SWR cache
   * wraps every value in a `{ value, cachedAt }` envelope (that timestamp is the
   * only way to know an entry's age), and every method on the instance reads and
   * writes that same shape. Turning it on for an existing cache therefore
   * requires a key-prefix version bump, exactly like any other value-shape change.
   */
  staleAfterMs?: number;
}

/** Per-write TTL override; omitted ⇒ {@link CacheConfig.ttlSeconds}. */
export interface CacheWriteOptions {
  ttlSeconds?: number;
}

export interface CacheComputeOptions<T> {
  /**
   * Decide the lifetime of a freshly computed value from the value itself —
   * a shorter negative TTL for a resolved-absent entity, or `null` to skip the
   * write entirely (a degraded result that must be returned but never cached).
   * Omitted ⇒ every computed value is written with the instance TTL.
   */
  ttlSecondsFor?: (value: T) => number | null;
}

export interface Cache {
  /** Read one key. Resolves `undefined` on a miss, a corrupt entry, or any Redis failure. */
  get<T>(key: string): Promise<T | undefined>;
  /**
   * Read many keys in ONE round trip, POSITIONALLY: `result[i]` is the value for
   * `keys[i]`, or `undefined` for a miss. Positional (rather than a keyed map)
   * so a caller that keyed by a domain id — a user id, not the Redis key — can
   * zip the answers back without re-deriving keys.
   */
  getMany<T>(keys: string[]): Promise<(T | undefined)[]>;
  /**
   * Existence check for a cache whose KEY is the whole signal (a negative-cache
   * marker). Cheaper than {@link Cache.get} — the payload never crosses the
   * wire. Degrades to `false` (a miss) on any Redis failure.
   */
  has(key: string): Promise<boolean>;
  /** Write one key with a TTL. Degrades to a no-op on any Redis failure. */
  set<T>(key: string, value: T, options?: CacheWriteOptions): Promise<void>;
  /**
   * Write many keys in ONE pipeline, each with its own atomic `SETEX` so a
   * crash mid-batch can never leave a TTL-less entry behind.
   */
  setMany<T>(entries: Iterable<readonly [string, T]>, options?: CacheWriteOptions): Promise<void>;
  /** Evict keys so the next read recomputes. Degrades to a no-op (entries age out on TTL). */
  delete(keys: string[]): Promise<void>;
  /**
   * Serve `key` from the cache, computing it at most once per key across all
   * concurrent callers in this process.
   *
   * A rejection from `compute` is NOT swallowed: it propagates to every caller
   * sharing that computation and nothing is written, so the caller's own domain
   * fallback decides what a failed computation means. A rejection during a
   * BACKGROUND stale refresh has no caller to propagate to and is logged instead.
   */
  getOrCompute<T>(
    key: string,
    compute: () => Promise<T>,
    options?: CacheComputeOptions<T>,
  ): Promise<T>;
}

/**
 * One-time latch for the non-array `MGET` diagnostic. Redis handing back a
 * non-array reply for `MGET` (observed against ElastiCache Valkey) is a property
 * of the CLIENT, not of any one cache, so the escalation is process-wide: the
 * `debug` line fires on every occurrence, the `warn` with the reply's runtime
 * shape fires exactly once. An unbounded `warn` here would flood the logs — the
 * path can fire on every feed hydration.
 */
let nonArrayReplyWarned = false;

function reportNonArrayMgetReply(name: string, reply: unknown, keyCount: number): void {
  logger.debug(`[${name}] mGet returned a non-array reply; treating as cache miss`, {
    replyType: typeof reply,
    keyCount,
  });

  if (nonArrayReplyWarned) return;
  nonArrayReplyWarned = true;

  let sample: string;
  try {
    sample = JSON.stringify(reply)?.slice(0, 200) ?? String(reply);
  } catch {
    // A value that can't be serialized (e.g. a circular structure) still yields
    // a useful hint via its string coercion — never let diagnostics throw.
    sample = String(reply).slice(0, 200);
  }
  const constructorName =
    reply === null || reply === undefined ? undefined : reply.constructor?.name;

  logger.warn(
    `[${name}] mGet returned a non-array reply (one-time diagnostic); treating as cache miss`,
    {
      replyType: typeof reply,
      constructorName,
      sample,
      keyCount,
    },
  );
}

export function createCache(config: CacheConfig): Cache {
  if (!Number.isFinite(config.ttlSeconds) || config.ttlSeconds <= 0) {
    throw new Error(`[${config.name}] cache ttlSeconds must be a positive number`);
  }

  const { name, ttlSeconds: defaultTtlSeconds, staleAfterMs } = config;
  const storesEnvelope = staleAfterMs !== undefined;

  /**
   * Concurrent computations for the same key, shared so N callers cause ONE
   * computation. The promise is untyped because one map serves every value
   * shape; the key is a full Redis key, which already namespaces the shape, so
   * a caller can never be handed another shape's promise.
   */
  const inFlight = new Map<string, Promise<unknown>>();

  /**
   * Run a Redis operation under the fail-open contract. The shared client is
   * connected and recovered by its own supervisor, so a hot path never PINGs,
   * connects, or waits for a cooldown — an unready client is simply a miss.
   */
  async function withFallback<T>(
    operation: string,
    fallback: T,
    run: (client: ReturnType<typeof getRedisClient>) => Promise<T>,
  ): Promise<T> {
    const client = getRedisClient();
    if (!client.isReady) return fallback;

    try {
      return await run(client);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : 'unknown';
      if (isRedisConnectionError(error)) {
        reportRedisConnectionFailure(client, error);
        logger.debug(`[${name}] Redis unavailable for ${operation}, using fallback`, { reason });
      } else {
        logger.warn(`[${name}] ${operation} failed`, { reason });
      }
      return fallback;
    }
  }

  /** Decode a stored string. Returns `undefined` for a corrupt or mis-shaped entry. */
  function decode<T>(raw: string): DecodedEntry<T> | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.debug(`[${name}] Discarding a corrupt cache entry`);
      return undefined;
    }

    if (!storesEnvelope) {
      // The single place a stored payload is asserted back to its caller's type.
      // Redis holds text, so this assertion is what every hand-rolled cache did
      // inline; the key's VERSIONED prefix is what keeps it honest across a
      // value-shape change.
      return { value: parsed as T, cachedAt: null };
    }

    const envelope = parsed as Partial<StoredEnvelope<T>> | null;
    if (!envelope || typeof envelope.cachedAt !== 'number') {
      logger.debug(`[${name}] Discarding a cache entry written in an older shape`);
      return undefined;
    }
    return { value: envelope.value as T, cachedAt: envelope.cachedAt };
  }

  function encode<T>(value: T): string {
    return JSON.stringify(storesEnvelope ? { value, cachedAt: Date.now() } : value);
  }

  async function readEntry<T>(key: string): Promise<DecodedEntry<T> | undefined> {
    return withFallback<DecodedEntry<T> | undefined>('get', undefined, async (client) => {
      const raw = await client.get(key);
      return raw ? decode<T>(raw) : undefined;
    });
  }

  async function write<T>(key: string, value: T, ttl: number): Promise<void> {
    if (!Number.isFinite(ttl) || ttl <= 0) {
      logger.warn(`[${name}] Refusing a cache write with a non-positive TTL`, { ttl });
      return;
    }
    await withFallback('set', undefined, async (client) => {
      await client.setEx(key, Math.floor(ttl), encode(value));
    });
  }

  /**
   * Compute `key` exactly once across concurrent callers, persisting the result
   * per `ttlSecondsFor`. The in-flight entry is released as soon as the
   * computation settles — this coalesces a burst, it is not a memo.
   */
  function compute<T>(
    key: string,
    computeValue: () => Promise<T>,
    options: CacheComputeOptions<T> | undefined,
  ): Promise<T> {
    const existing = inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    const pending = (async () => {
      try {
        const value = await computeValue();
        const ttl = options?.ttlSecondsFor ? options.ttlSecondsFor(value) : defaultTtlSeconds;
        if (ttl !== null) {
          await write(key, value, ttl);
        }
        return value;
      } finally {
        inFlight.delete(key);
      }
    })();

    inFlight.set(key, pending);
    return pending;
  }

  return {
    async get<T>(key: string): Promise<T | undefined> {
      const entry = await readEntry<T>(key);
      return entry?.value;
    },

    async getMany<T>(keys: string[]): Promise<(T | undefined)[]> {
      if (keys.length === 0) return [];

      return withFallback<(T | undefined)[]>('mGet', new Array(keys.length).fill(undefined), async (client) => {
        const values = await client.mGet(keys);

        // A non-array reply would make the map below throw a TypeError, which
        // would surface as a 500 on whatever hot path is reading the cache.
        // Treat it as a full miss so the caller degrades to a cold computation.
        if (!Array.isArray(values)) {
          reportNonArrayMgetReply(name, values, keys.length);
          return new Array<T | undefined>(keys.length).fill(undefined);
        }

        return values.map((raw) => (raw ? decode<T>(raw)?.value : undefined));
      });
    },

    async has(key: string): Promise<boolean> {
      return withFallback('exists', false, async (client) => (await client.exists(key)) === 1);
    },

    async set<T>(key: string, value: T, options?: CacheWriteOptions): Promise<void> {
      await write(key, value, options?.ttlSeconds ?? defaultTtlSeconds);
    },

    async setMany<T>(
      entries: Iterable<readonly [string, T]>,
      options?: CacheWriteOptions,
    ): Promise<void> {
      const ttl = Math.floor(options?.ttlSeconds ?? defaultTtlSeconds);
      if (ttl <= 0) {
        logger.warn(`[${name}] Refusing a cache write with a non-positive TTL`, { ttl });
        return;
      }

      const pairs = [...entries];
      if (pairs.length === 0) return;

      await withFallback('mSet', undefined, async (client) => {
        const pipeline = client.multi();
        for (const [key, value] of pairs) {
          pipeline.setEx(key, ttl, encode(value));
        }
        await pipeline.exec();
      });
    },

    async delete(keys: string[]): Promise<void> {
      if (keys.length === 0) return;
      await withFallback('del', undefined, async (client) => {
        await client.del(keys);
      });
    },

    async getOrCompute<T>(
      key: string,
      computeValue: () => Promise<T>,
      options?: CacheComputeOptions<T>,
    ): Promise<T> {
      const entry = await readEntry<T>(key);
      if (!entry) {
        return compute(key, computeValue, options);
      }

      if (
        staleAfterMs === undefined ||
        entry.cachedAt === null ||
        Date.now() - entry.cachedAt < staleAfterMs
      ) {
        return entry.value;
      }

      // Stale: answer from the cache NOW and refresh behind the response. The
      // refresh has no caller to receive its failure, so it is logged here.
      void compute(key, computeValue, options).catch((error: unknown) => {
        logger.debug(`[${name}] Background refresh failed`, {
          reason: error instanceof Error ? error.message : 'unknown',
        });
      });
      return entry.value;
    },
  };
}
