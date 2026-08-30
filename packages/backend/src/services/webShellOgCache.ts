/**
 * Redis-backed resolution cache for the public web shell (`/@handle`, `/c/handle`,
 * `/p/:id`).
 *
 * Deep-link resolution is EXPENSIVE — a profile fetch to Oxy or a full post
 * hydration — and most of it is only needed for crawlers/unfurlers (real browsers
 * boot the SPA, which set their own meta on hydration). This cache lets a caller
 * pay that cost at most once per short window: entries are served fresh from
 * Redis, served STALE while a background refresh runs (stale-while-revalidate),
 * and resolved inline only on a genuine cold miss. Concurrent misses for the same
 * key share a single in-flight resolution.
 *
 * All of that — the SWR envelope, the single-flight, the TTL'd write and the
 * fail-open contract — is the shared {@link createCache} primitive. What stays
 * here is the policy: the key namespace, the three TTLs, and the decision that
 * an unresolved entity is cached NEGATIVELY while a FAILED resolution is not
 * cached at all.
 *
 * Generic in what it caches because the profile fetch now answers TWO questions
 * from one payload — the OG card, and whether the handle is a channel account
 * (which decides a redirect, so a browser needs it too). Caching the payload
 * rather than the rendered OG is what keeps that a single fetch.
 *
 * Everything here is FAIL-OPEN: any Redis hiccup degrades to a direct resolution
 * (and, ultimately, to nothing) — it must never break or slow the page.
 */
import { createCache } from '../utils/cache';
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
 * Shorter lifetime for a resolved-null entry (unknown entity) so a real entity
 * self-heals quickly once it exists AND a crawler storm on a bad URL cannot
 * repeatedly hammer the database/Oxy.
 */
const OG_NEGATIVE_TTL_SECONDS = 60;

const cache = createCache({
  name: 'webShellOgCache',
  ttlSeconds: OG_TTL_SECONDS,
  staleAfterMs: OG_FRESH_TTL_MS,
});

/**
 * Return a resolved deep-link payload, backed by the Redis SWR cache. A fresh
 * entry is served immediately; a stale one is served immediately while it
 * refreshes in the background; a cold miss resolves inline via `fetchFn` (so a
 * crawler always gets tags) and populates the cache. `cacheKey` should be a stable
 * per-entity key (e.g. `profile:<handle>` / `post:<id>`).
 *
 * A resolution that FAILS is never cached: the error propagates out of the
 * primitive (which writes nothing) and is absorbed here as "no tags", so the
 * next request retries instead of serving a minute of manufactured absence.
 */
export async function getShellCached<T>(
  cacheKey: string,
  fetchFn: () => Promise<T | null>,
): Promise<T | null> {
  try {
    return await cache.getOrCompute<T | null>(OG_CACHE_PREFIX + cacheKey, fetchFn, {
      ttlSecondsFor: (value) => (value ? OG_TTL_SECONDS : OG_NEGATIVE_TTL_SECONDS),
    });
  } catch (error) {
    logger.debug('[webShellOgCache] resolution failed', error);
    return null;
  }
}
