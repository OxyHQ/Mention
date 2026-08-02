/**
 * Which STORY a post belongs to, if any.
 *
 * The trend batch already answers a question the feed has no other way to ask.
 * Ranking's diversity pass penalizes a repeated author and a repeated hashtag,
 * and a hashtag is a poor stand-in for a subject: five accounts posting the
 * same news item under different tags — or under none, which is most federated
 * posts — penalize each other not at all. What makes a feed feel broken is
 * rarely a second post about politics; it is the fifth telling of one event.
 *
 * Co-occurrence clustering computes exactly that grouping every batch, for the
 * terms the network is actually converging on. This module is the seam that
 * lets ranking read it, and it is deliberately ONE-WAY: trending knows nothing
 * about the feed, and the feed asks a question rather than reaching into the
 * collection itself.
 *
 * Everything here is best-effort. A post in no story, an empty index, a failed
 * read — all mean "no penalty", which is precisely the behaviour before this
 * existed. Diversity is a nicety; it must never be able to cost a feed.
 */

import Trending from '../../models/Trending';
import { logger } from '../../utils/logger';

/**
 * How long a loaded index is reused.
 *
 * The batch recomputes every 30 minutes, so this is refreshed far more often
 * than the data behind it changes. Nothing is invalidated on write: an index a
 * few minutes stale groups a post under the story it belonged to slightly
 * earlier, which is not a wrong answer to a question about repetition.
 */
const INDEX_TTL_MS = 5 * 60 * 1000;

/**
 * Deliberately in-process rather than in Redis.
 *
 * It is small, derived, read-only, and every task can rebuild it from one
 * indexed query — so a shared cache would buy consistency nobody can observe at
 * the cost of a network round trip on the feed's hot path. No timer either: a
 * module-level `setInterval` would hold the event loop open (see AGENTS.md), and
 * a lazy refresh on read costs nothing when nobody is reading.
 */
let cached: { map: Map<string, string>; expiresAt: number } | null = null;
let refreshing = false;

/** Drop the memo. Tests only — production refreshes on its own. */
export function resetStoryIndexCache(): void {
  cached = null;
  refreshing = false;
}

/**
 * Read the current index. NEVER waits.
 *
 * A stale or missing index costs one page its story penalty, and diversity is a
 * nicety — it must never be able to cost a feed, which an `await` on this path
 * would let it do. Mongoose buffers commands while a connection is down, so a
 * database in trouble would not fail fast here; it would hold every feed
 * request open until the buffer timeout, turning a ranking refinement into an
 * outage. The first request after a cold start therefore ranks without stories
 * and every one after it has them.
 */
export function getStoryIndex(now: number = Date.now()): ReadonlyMap<string, string> {
  if (!cached || cached.expiresAt <= now) void refreshStoryIndex(now);
  return cached?.map ?? EMPTY;
}

const EMPTY: ReadonlyMap<string, string> = new Map();

/**
 * Rebuild the index from the newest batch, in the background.
 *
 * Never rejects and never runs twice at once: this is called from a hot path
 * that ignores its result, so an unhandled rejection or a thundering herd of
 * identical queries would be the only ways it could hurt.
 */
export async function refreshStoryIndex(now: number = Date.now()): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    // The most recent batch only. `calculatedAt` descending with a small limit
    // rides the same index the trend list itself is served from, and a batch is
    // at most `maxTrends` rows.
    const rows = await Trending.find({ terms: { $exists: true } })
      .select({ name: 1, terms: 1, calculatedAt: 1 })
      .sort({ calculatedAt: -1 })
      .limit(100)
      .maxTimeMS(1000)
      .lean<{ name: string; terms?: string[]; calculatedAt: Date }[]>();

    const map = new Map<string, string>();
    const newest = rows[0]?.calculatedAt?.getTime();
    for (const row of rows) {
      // Rows from older batches describe a story that may since have been
      // reshaped; mixing two batches would let a term belong to two stories.
      if (newest && row.calculatedAt?.getTime() !== newest) continue;
      for (const term of row.terms ?? []) map.set(term, row.name);
    }

    cached = { map, expiresAt: now + INDEX_TTL_MS };
  } catch (error) {
    logger.warn('[Feed] Story index unavailable; diversity falls back to author and tag', {
      error,
    });
    // Memoize the empty answer too, so a database in trouble is not retried on
    // every request for the next five minutes.
    cached = { map: new Map(), expiresAt: now + INDEX_TTL_MS };
  } finally {
    refreshing = false;
  }
}

/**
 * The story a post belongs to, or `null`.
 *
 * A post can carry terms from more than one story — a comparison, a thread that
 * touches two events. The FIRST match in the post's own term order wins rather
 * than a "best" one: term order is stable for a given post, so the same post
 * always lands in the same story, and a rule that reshuffled it per request
 * would make the penalty depend on which posts happened to share a page.
 */
export function storyOf(
  terms: readonly string[] | undefined,
  index: ReadonlyMap<string, string>,
): string | null {
  if (!terms || index.size === 0) return null;
  for (const term of terms) {
    const story = index.get(term);
    if (story) return story;
  }
  return null;
}
