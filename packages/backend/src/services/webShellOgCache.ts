/**
 * Redis-backed OpenGraph cache for the public web shell (`/@handle`, `/p/:id`).
 *
 * Deep-link OG resolution is EXPENSIVE — a profile fetch to Oxy or a full Mongo
 * post hydration — and only crawlers/unfurlers actually need it server-side (real
 * browsers boot the SPA, which sets its own meta on hydration). This cache lets a
 * crawler pay that cost at most once per short window: entries are served fresh
 * from Redis, served STALE while a background refresh runs (stale-while-
 * revalidate), and resolved inline only on a genuine cold miss. Concurrent misses
 * for the same key share a single in-flight resolution.
 *
 * Everything here is FAIL-OPEN: any Redis hiccup degrades to a direct resolution
 * (and, ultimately, to no OG) — it must never break or slow the page.
 */
import { getRedisClient } from '../utils/redis';
import { ensureRedisConnected } from '../utils/redisHelpers';
import { logger } from '../utils/logger';
import type { OgData } from './webShellRenderer';

/** Namespaced, versioned key prefix so a shape change can be rolled without stale reads. */
const OG_CACHE_PREFIX = 'webshell:og:v1:';
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

interface CachedOg {
  /** The resolved OG payload, or `null` for a known-absent entity (negative cache). */
  og: OgData | null;
  /** Epoch ms the entry was resolved — drives the fresh/stale decision. */
  cachedAt: number;
}

/** Coalesces concurrent cold-miss / refresh resolutions for the same key into one. */
const inFlight = new Map<string, Promise<OgData | null>>();

/** Read a cached entry. Returns null on a miss OR any Redis/parse failure (fail-open). */
async function readCache(key: string): Promise<CachedOg | null> {
  try {
    const redis = getRedisClient();
    if (!(await ensureRedisConnected(redis))) return null;
    const raw = await redis.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedOg;
    return parsed && typeof parsed.cachedAt === 'number' ? parsed : null;
  } catch (error) {
    logger.debug('[webShellOgCache] cache read failed', error);
    return null;
  }
}

/** Persist a resolved entry. Best-effort — a write failure is swallowed (fail-open). */
async function writeCache(key: string, value: CachedOg, ttlSeconds: number): Promise<void> {
  try {
    const redis = getRedisClient();
    if (!(await ensureRedisConnected(redis))) return;
    await redis.setEx(key, ttlSeconds, JSON.stringify(value));
  } catch (error) {
    logger.debug('[webShellOgCache] cache write failed', error);
  }
}

/** Resolve OG via `fetchFn`, populate the cache, and return it. Deduped per key. */
function refresh(key: string, fetchFn: () => Promise<OgData | null>): Promise<OgData | null> {
  const existing = inFlight.get(key);
  if (existing) return existing;

  const pending = (async () => {
    try {
      const og = await fetchFn();
      await writeCache(key, { og, cachedAt: Date.now() }, og ? OG_TTL_SECONDS : OG_NEGATIVE_TTL_SECONDS);
      return og;
    } catch (error) {
      logger.debug('[webShellOgCache] OG resolution failed', error);
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, pending);
  return pending;
}

/**
 * Return the OG data for a deep-link, backed by the Redis SWR cache. A fresh entry
 * is served immediately; a stale one is served immediately while it refreshes in
 * the background; a cold miss resolves inline via `fetchFn` (so a crawler always
 * gets tags) and populates the cache. `cacheKey` should be a stable per-entity key
 * (e.g. `profile:<handle>` / `post:<id>`).
 */
export async function getOgCached(
  cacheKey: string,
  fetchFn: () => Promise<OgData | null>,
): Promise<OgData | null> {
  const key = OG_CACHE_PREFIX + cacheKey;

  const cached = await readCache(key);
  if (cached) {
    if (Date.now() - cached.cachedAt < OG_FRESH_TTL_MS) {
      return cached.og;
    }
    void refresh(key, fetchFn);
    return cached.og;
  }

  return refresh(key, fetchFn);
}
