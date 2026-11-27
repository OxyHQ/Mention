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

/**
 * How long a page is KEPT after it stops being fresh, to be served while one
 * build refreshes it. A build is the whole gather-rank-hydrate pipeline: on the
 * Explore feed it scores a day of posts and runs 4 to 15 s against a 15 s
 * statement timeout, so an entry that simply vanished after 45 s sent every
 * reader that arrived next into a build of their own, and a loaded database
 * answered those with 503s. A stale page is a shared page a minute or so old;
 * a 503 is nothing.
 */
export const ANON_KEEP_SECONDS = 15 * 60;

/**
 * How long Explore's FIRST page is kept: one score half-life.
 *
 * Fifteen minutes is not enough for it. With the shared database out of EBS I/O
 * balance (2026-11-26 and 27, `EBSIOBalance%` 0 for most of the day) a cold
 * Explore build took 15 to 45 s, past the app's 15 s request timeout, and the
 * leader's warm-up failed and rested. Any language nobody had read in the last
 * 15 minutes then had no page at all: the reader saw skeletons and nothing else
 * (the browser release gate failed on exactly that, blocking every merge). Kept
 * for a day, such a reader is answered at once with the last page built, re-
 * authorized on read like every cached page, while one request rebuilds it.
 *
 * Only the first page: a later page is keyed on its cursor, which belongs to one
 * reader's scroll session and is never asked for again once that session ends.
 */
const EXPLORE_FIRST_PAGE_KEEP_SECONDS = 24 * 60 * 60;

/** How long the anonymous page of `descriptor` at `cursor` is kept, in seconds. */
export function anonKeepSecondsFor(descriptor: string, cursor: string | undefined): number {
  return descriptor === 'explore' && !cursor ? EXPLORE_FIRST_PAGE_KEEP_SECONDS : ANON_KEEP_SECONDS;
}
