/**
 * How long a shared anonymous feed page counts as FRESH: the anon feed is shared,
 * so this collapses a burst of anonymous requests into one recompute, while new
 * posts still appear within ~1 minute. Kept apart from `anonFeedCache` so the
 * controller can ask for a descriptor's window without importing the cache.
 */
export const ANON_FRESH_MS = 45 * 1000;

/**
 * How long an Explore page counts as fresh. Its build reads ~45,000 heap blocks
 * (23 s of I/O on 2026-11-25, EXPLAIN ANALYZE on production), and at 45 s that
 * was one such build per language every 45 s on a database sitting at its EBS
 * I/O ceiling: up to about a fifth of its ~4,700 read IOPS if none of it is
 * cached, for a page whose score halves over 24 hours and cannot be told apart
 * from one five minutes older.
 */
const EXPLORE_FRESH_MS = 5 * 60 * 1000;

/** The freshness window of the anonymous page of `descriptor`. */
export function anonFreshMsFor(descriptor: string): number {
  return descriptor === 'explore' ? EXPLORE_FRESH_MS : ANON_FRESH_MS;
}
