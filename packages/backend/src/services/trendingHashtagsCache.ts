/**
 * `GET /hashtags/` — the trending-tag list, cached with stale-while-revalidate.
 *
 * ## What this replaces, and why a cache rather than a table
 *
 * The endpoint runs THREE full aggregates per request, each an `unnest` over
 * every public tagged post in its window with a `GROUP BY` on top: the trending
 * window itself, plus the two 24h windows that give each tag its up/down/flat
 * direction. The two direction maps carry no `LIMIT` at all — they materialize
 * a count for every tag in the window to compare two of them.
 *
 * Measured on 400k posts (380k of them public and tagged): 325.79 ms for the
 * window aggregate and 63.94 ms for each direction map, so ~454 ms per request,
 * all of it a sequential scan. The search screen subscribes to this on mount
 * and polls it every five minutes, so it is competing with the viewer's first
 * search for the same database.
 *
 * A denormalized `hashtag_stats` table was the planned fix — a generation-stamped
 * recompute on the leader-elected scheduler. Measuring first changed the answer.
 * A table earns its keep when the aggregate must be QUERIED: filtered, sorted,
 * paginated, joined. Hashtag SEARCH would need that — and hashtag search is
 * already index-served (32 ms, `posts_hashtags_trgm_gin` narrows candidates
 * before the aggregate; measured, not assumed). What is left is one GLOBAL,
 * slow-changing list that every caller reads identically, which is exactly what
 * a cache is for. A table plus a scheduler job plus a backfill script plus an
 * equivalence gate, to serve that, is more machinery than the problem has.
 *
 * ## Why caching this is SAFE, which is the part worth checking
 *
 * The response is viewer-INDEPENDENT. Its only predicate is
 * `visibility = 'public'` plus the not-collapsed-crosspost rule and a
 * `created_at` floor; no blocked list, no mute words, no follow graph, no
 * per-account language. Two viewers asking with the same `limit` and `days` must
 * receive byte-identical bodies, so one entry can serve everyone — unlike a
 * feed or a search result, which `postDetailCache` explains must cache the
 * record BEFORE per-viewer fields exist for exactly this reason.
 *
 * `limit` and `days` are therefore the whole key. Both are already bounded by
 * the route (`limit` is clamped to `TRENDING_HASHTAG_LIMIT`, `days` is a parsed
 * integer or absent), so the key space is small and an attacker cannot mint
 * unbounded entries by varying the query string.
 *
 * ## Freshness
 *
 * A trending list that is up to a minute old is still a trending list; nobody
 * acts on a tag's exact rank. SWR means the first request after the fresh
 * window still gets an immediate answer and the recompute happens behind it, so
 * no viewer ever waits 454 ms for a refresh — which is the property a plain TTL
 * would not give.
 */

import { createCache } from '../utils/cache';
import { logger } from '../utils/logger';

/** How long an entry is retained. Beyond this, a request recomputes inline. */
const TRENDING_TTL_SECONDS = 300;

/**
 * How long an entry is served without a refresh. Past it the entry is STILL
 * served immediately and refreshed behind the response.
 */
const TRENDING_FRESH_MS = 60_000;

/**
 * Bumped on any change to the cached SHAPE.
 *
 * `cache.ts` requires it when turning SWR on, because the stored envelope
 * changes — but it matters for the payload too: this holds a serialized list of
 * tag rows, and a reader deserializing an older shape would not fail, it would
 * render wrongly.
 */
const TRENDING_PREFIX = 'trendingHashtags:v1:';

const cache = createCache({
  name: 'TrendingHashtagsCache',
  ttlSeconds: TRENDING_TTL_SECONDS,
  staleAfterMs: TRENDING_FRESH_MS,
});

/** One trending row, as the route serializes it. */
export interface TrendingHashtagRow {
  id: string;
  text: string;
  hashtag: string;
  count: number;
  /** ISO string, NOT a `Date`: this round-trips through JSON in Redis. */
  created_at: string;
  direction?: 'up' | 'down' | 'flat';
}

/**
 * `days` is part of the key as a STRING, including the absent case.
 *
 * `undefined` (no window — all-time counts) and a number are different answers,
 * and collapsing them would serve a 7-day list to an all-time caller. The
 * literal `'all'` is used rather than an empty segment so the two cannot
 * accidentally produce the same key.
 */
function keyFor(limit: number, days: number | undefined): string {
  return `${TRENDING_PREFIX}${limit}:${days === undefined ? 'all' : days}`;
}

/**
 * Serve the trending list for `(limit, days)`, computing it only when no
 * usable entry exists.
 *
 * `compute` is left UNCAUGHT inside `getOrCompute`: a rejection is never
 * written to the cache (`cache.ts`'s documented contract), only propagated, so
 * a transient database failure costs one request rather than pinning a bad
 * answer for the whole TTL. The outer catch exists only so a REDIS problem
 * cannot take the endpoint down — `createCache` is already fail-open, and this
 * is the belt to that braces.
 */
export async function getTrendingHashtags(
  limit: number,
  days: number | undefined,
  compute: () => Promise<TrendingHashtagRow[]>,
): Promise<TrendingHashtagRow[]> {
  try {
    return await cache.getOrCompute(keyFor(limit, days), compute);
  } catch (error) {
    logger.warn('[TrendingHashtagsCache] Falling back to an uncached computation', { error });
    return compute();
  }
}

/**
 * Drop the cached list for one `(limit, days)` pair.
 *
 * Exported for tests, which must not see another case's entry: the key carries
 * no scope token, precisely because the value is global. Takes the pair rather
 * than clearing everything because `Cache` exposes `delete(keys)` and no
 * prefix scan — a deliberate limit of that primitive, since a prefix scan on
 * Redis is either `KEYS` (blocking) or `SCAN` (a loop the caller must own).
 */
export async function forgetTrendingHashtags(
  limit: number,
  days: number | undefined,
): Promise<void> {
  await cache.delete([keyFor(limit, days)]);
}
