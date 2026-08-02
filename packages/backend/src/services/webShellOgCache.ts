/**
 * Redis-backed resolution cache for the public web shell (`/@handle`, `/c/handle`,
 * `/p/:id`).
 *
 * Deep-link resolution is EXPENSIVE — a profile fetch to Oxy or a full Mongo post
 * hydration — and most of it is only needed for crawlers/unfurlers (real browsers
 * boot the SPA, which set their own meta on hydration). This cache lets a caller
 * pay that cost at most once per short window: entries are served fresh from
 * Redis, served STALE while a background refresh runs (stale-while-revalidate),
 * and resolved inline only on a genuine cold miss. Concurrent misses for the same
 * key share a single in-flight resolution.
 *
 * Generic in what it caches because the profile fetch now answers TWO questions
 * from one payload — the OG card, and whether the handle is a channel account
 * (which decides a redirect, so a browser needs it too). Caching the payload
 * rather than the rendered OG is what keeps that a single fetch.
 *
 * Everything here is FAIL-OPEN: any Redis hiccup degrades to a direct resolution
 * (and, ultimately, to nothing) — it must never break or slow the page.
 */
import { getRedisClient } from '../utils/redis';
import { logger } from '../utils/logger';

/**
 * Namespaced, versioned key prefix so a shape change can be rolled without stale
 * reads. Bumped to `v2` when the `profile:` key started holding the raw Oxy
 * profile payload instead of the rendered OG.
 */
const OG_CACHE_PREFIX = 'webshell:og:v2:';
/** Age below which a cached entry is served as-is, with no background refresh. */
const OG_FRESH_TTL_MS = 5 * 60 * 1000;
/** Redis lifetime of a RESOLVED entry — past OG_FRESH it is served stale + refreshed. */
const OG_TTL_SECONDS = 60 * 60;
/**
 * Shorter lifetime for a resolved-null entry (unknown entity / transient failure)
 * so a real entity self-heals quickly once it exists AND a crawler storm on a bad
 * URL cannot repeatedly hammer Mongo/Oxy.
 */
const OG_NEGATIVE_TTL_SECONDS = 60;

interface CachedEntry<T> {
  /** The resolved payload, or `null` for a known-absent entity (negative cache). */
  value: T | null;
  /** Epoch ms the entry was resolved — drives the fresh/stale decision. */
  cachedAt: number;
}

/**
 * Coalesces concurrent cold-miss / refresh resolutions for the same key into one.
 *
 * Keyed by the FULL cache key, which is namespaced per resolution kind
 * (`profile:` / `post:`), so the untyped promise here can never be handed to a
 * caller expecting the other shape.
 */
const inFlight = new Map<string, Promise<unknown>>();

/** Read a cached entry. Returns null on a miss OR any Redis/parse failure (fail-open). */
async function readCache<T>(key: string): Promise<CachedEntry<T> | null> {
  try {
    const redis = getRedisClient();
    if (!redis.isReady) return null;
    const raw = await redis.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedEntry<T>;
    return parsed && typeof parsed.cachedAt === 'number' ? parsed : null;
  } catch (error) {
    logger.debug('[webShellOgCache] cache read failed', error);
    return null;
  }
}

/** Persist a resolved entry. Best-effort — a write failure is swallowed (fail-open). */
async function writeCache<T>(key: string, value: CachedEntry<T>, ttlSeconds: number): Promise<void> {
  try {
    const redis = getRedisClient();
    if (!redis.isReady) return;
    await redis.setEx(key, ttlSeconds, JSON.stringify(value));
  } catch (error) {
    logger.debug('[webShellOgCache] cache write failed', error);
  }
}

/** Resolve via `fetchFn`, populate the cache, and return it. Deduped per key. */
function refresh<T>(key: string, fetchFn: () => Promise<T | null>): Promise<T | null> {
  const existing = inFlight.get(key) as Promise<T | null> | undefined;
  if (existing) return existing;

  const pending = (async () => {
    try {
      const value = await fetchFn();
      await writeCache(
        key,
        { value, cachedAt: Date.now() },
        value ? OG_TTL_SECONDS : OG_NEGATIVE_TTL_SECONDS,
      );
      return value;
    } catch (error) {
      logger.debug('[webShellOgCache] resolution failed', error);
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, pending);
  return pending;
}

/**
 * Return a resolved deep-link payload, backed by the Redis SWR cache. A fresh
 * entry is served immediately; a stale one is served immediately while it
 * refreshes in the background; a cold miss resolves inline via `fetchFn` (so a
 * crawler always gets tags) and populates the cache. `cacheKey` should be a stable
 * per-entity key (e.g. `profile:<handle>` / `post:<id>`).
 */
export async function getShellCached<T>(
  cacheKey: string,
  fetchFn: () => Promise<T | null>,
): Promise<T | null> {
  const key = OG_CACHE_PREFIX + cacheKey;

  const cached = await readCache<T>(key);
  if (cached) {
    if (Date.now() - cached.cachedAt < OG_FRESH_TTL_MS) {
      return cached.value;
    }
    void refresh(key, fetchFn);
    return cached.value;
  }

  return refresh(key, fetchFn);
}
