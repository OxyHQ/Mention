/**
 * The shared slice of a search overview, cached with stale-while-revalidate.
 *
 * ## What is cached, and what deliberately is not
 *
 * Only the lanes whose answer is the SAME for every viewer: hashtags, public
 * feeds and starter packs. Those have no viewer-dependent input at all — their
 * predicates are a text match plus `is_public`, with no blocked list, no mute
 * words, no follow graph.
 *
 * Everything else is computed per request:
 *
 * - **lists** mix public rows with the viewer's own, so a shared entry would
 *   show one viewer another's private list. The lane is cheap and indexed;
 *   caching it is not worth a key that has to carry an identity.
 * - **posts** and **saved** carry per-viewer state (liked, saved, blocked,
 *   muted) and, for saved, the viewer's own bookmarks. `postDetailCache` states
 *   the rule this follows: cache the record BEFORE per-viewer fields exist, or
 *   it can leak one viewer's state into another's response. The overview does
 *   not have a "before" to cache, so it does not cache them.
 *
 * That split is the whole design. A cache keyed per viewer would hit almost
 * never (a search term plus an identity is nearly unique), so it would add a
 * Redis round trip to every search and return nothing — worse than no cache.
 * Keyed on the shared lanes only, a trending term is served from one entry for
 * everyone, which is the case that actually repeats.
 *
 * ## Freshness
 *
 * 60s fresh, 300s retained. SWR so the first request after the fresh window
 * still answers immediately and the recompute happens behind it; a plain TTL
 * would make one unlucky viewer per minute pay the full cost. A search result
 * that is up to a minute stale is a search result; the alternative — a
 * just-published post missing from an overview for under a minute — is a
 * trade `anonFeedCache` and `postDetailCache` already make and document.
 */

import { createHash } from 'node:crypto';

import { createCache } from '../../utils/cache';
import { logger } from '../../utils/logger';

const OVERVIEW_TTL_SECONDS = 300;
const OVERVIEW_FRESH_MS = 60_000;

/**
 * Bumped on ANY change to the cached shape.
 *
 * `utils/cache.ts` requires it when turning SWR on, because the stored envelope
 * changes — and it matters for the payload too: a reader deserializing an older
 * lane shape would not fail, it would render wrongly.
 */
const OVERVIEW_PREFIX = 'searchOverview:v1:';

const cache = createCache({
  name: 'SearchOverviewCache',
  ttlSeconds: OVERVIEW_TTL_SECONDS,
  staleAfterMs: OVERVIEW_FRESH_MS,
});

/**
 * Normalise a query so trivially different spellings share an entry.
 *
 * Case-folded and whitespace-collapsed, then HASHED. The hash is not for
 * secrecy — it bounds the key length, because a search term is arbitrary user
 * input and an unbounded key is an unbounded Redis key. `sha256` truncated to
 * 32 hex characters: 128 bits, so a collision between two live search terms is
 * not a thing that happens. Same reasoning as `anonFeedCache`'s key.
 */
export function overviewCacheKey(query: string, limit: number): string {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ');
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 32);
  return `${OVERVIEW_PREFIX}${limit}:${digest}`;
}

/**
 * Serve the shared lanes for `query`, computing them only on a miss.
 *
 * `compute` is left UNCAUGHT inside `getOrCompute`: a rejection is never
 * written to the cache (`cache.ts`'s documented contract), only propagated, so
 * a transient failure costs one request instead of pinning a bad answer for the
 * whole TTL. The outer catch exists only so a REDIS problem cannot take search
 * down — `createCache` is already fail-open, and this is the belt to it.
 */
export async function getSharedLanes<T>(
  query: string,
  limit: number,
  compute: () => Promise<T>,
): Promise<{ value: T; fromCache: boolean }> {
  const key = overviewCacheKey(query, limit);
  // `fromCache` is derived from whether `compute` RAN, not from a `cache.get`
  // probe before it. Probing first looks equivalent and is not: under SWR a
  // stale entry is a HIT for `get`, so the probe would return it, report
  // `fromCache` and never trigger the background refresh — the entry would then
  // expire and the next request would pay the full cost inline, which is
  // exactly the behaviour SWR exists to avoid.
  let computed = false;
  try {
    const value = await cache.getOrCompute(key, async () => {
      computed = true;
      return compute();
    });
    return { value, fromCache: !computed };
  } catch (error) {
    logger.warn('[SearchOverviewCache] Falling back to an uncached computation', { error });
    return { value: await compute(), fromCache: false };
  }
}

/** Drop one entry. Exported for tests, which must not inherit another case's. */
export async function forgetSharedLanes(query: string, limit: number): Promise<void> {
  await cache.delete([overviewCacheKey(query, limit)]);
}
