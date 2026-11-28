import { createCache } from '../../utils/cache';
import { ANON_KEEP_SECONDS } from './anonFeedFreshness';

/**
 * When every anonymous feed page built so far stopped being servable as fresh.
 *
 * An identity projection (an actor's posts moving to another Oxy user) used to
 * DELETE every `anonfeed:*` key, with a SCAN over the whole keyspace. Federation
 * refreshes run it many times an hour, so a kept page rarely lived long enough
 * to be served stale, and a reader of a page nobody had read since the last
 * refresh waited for a full build. On Explore, with the shared database out of
 * I/O on 2026-11-27, that build ran past the app's 15 s timeout and the reader
 * saw no posts at all (measured: a page written at 19:23 UTC with a 24 h TTL was
 * gone by 19:44, with no Redis evictions).
 *
 * Marking keeps what the deletion was for: no page built before the change is
 * served as fresh. Such a page is still the stale page of last resort, served
 * while one request rebuilds it, and a stale read re-authorizes every post on it
 * against its current record (`revalidateAnonymousFeed`), whose revision covers
 * the owner and authorship a projection moves, so a moved post is re-hydrated
 * before it is served.
 */
export const ANON_FEED_STALE_MARKER_KEY = 'anonfeed:v3:stale-before';

/**
 * Kept at least as long as any page can be fresh (5 minutes at most), so a page
 * built before the mark can never read as fresh once the mark expires.
 */
const markerCache = createCache({ name: 'AnonFeedStaleMarker', ttlSeconds: ANON_KEEP_SECONDS });

/** Stop serving every anonymous page built until now as fresh. Fail-soft. */
export async function markAnonymousFeedsStale(): Promise<void> {
  await markerCache.set(ANON_FEED_STALE_MARKER_KEY, Date.now());
}
