import { MtnConfig, PostVisibility } from '@mention/shared-types';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { getRedisClient } from '../utils/redis';
import { withRedisFallback } from '../utils/redisHelpers';
import { logger } from '../utils/logger';

/**
 * Deduplicated post-view counting for feed impressions.
 *
 * A feed impression (a post that was actually on screen long enough to count)
 * should increment `posts.stats_views_count` AT MOST ONCE per viewer within a
 * rolling window — otherwise re-scrolling or refreshing the same feed inflates
 * the count and pollutes the ranking view signal.
 *
 * De-duplication uses a short-lived Redis marker per (viewer, post). `SET key NX`
 * is the atomic claim: the FIRST impression for a pair sets the key and returns
 * "OK" → we increment; subsequent impressions find the key present → no-op. When
 * Redis is unavailable the whole thing degrades to a no-op (no double counting,
 * no count at all) rather than risking unbounded inflation — view counting is a
 * best-effort ranking signal, never a correctness-critical write.
 *
 * Mirrors the design of {@link ./mediaCache/negativeCache}: shared Redis
 * singleton, graceful fallback, TTL set atomically with the marker.
 */

/** Redis key prefix for per-(viewer, post) view-seen markers. */
const VIEW_SEEN_PREFIX = 'viewseen:';

/** Dedupe window, derived from the shared MTN config (24h by default). */
const DEDUPE_TTL_SECONDS = Math.ceil(MtnConfig.preferences.viewDedupeTtlMs / 1000);

function keyFor(postId: string, viewerId: string): string {
  return `${VIEW_SEEN_PREFIX}${postId}:${viewerId}`;
}

/**
 * Verify a client-reported impression references a real post that is safe to
 * count as feed-visible telemetry. Telemetry is client-controlled, so this
 * intentionally only accepts public, published local posts before creating any
 * Redis dedupe marker or updating ranking/view statistics.
 */
export async function isPostEligibleForViewTelemetry(postId: string): Promise<boolean> {
  if (!postId) {
    return false;
  }

  // No id-shape guard: `posts.id` is `text` (ObjectId hex before the cutover,
  // uuid v7 after), so an id of any shape — a federated URI included — is a
  // parameter that simply matches no row. An `isValidObjectId` test here would
  // have made every post created since the cutover permanently ineligible for
  // view telemetry, which is invisible: the counter just stops moving.
  const [post] = await getDb()
    .select({ id: posts.id })
    .from(posts)
    .where(and(
      eq(posts.id, postId),
      eq(posts.visibility, PostVisibility.PUBLIC),
      eq(posts.status, 'published'),
    ))
    .limit(1);

  return Boolean(post);
}

/**
 * Increment a post's view count for `viewerId`, deduped within the configured
 * window. Returns the post's NEW `stats.viewsCount` when this call counted a new
 * view, and `null` when it did not — a duplicate inside the window, an
 * ineligible post, or Redis being unavailable. A returned number therefore also
 * means "this post exists and was counted"; callers that only care whether the
 * view landed test for `!== null`.
 *
 * The count comes back on the increment's OWN round trip (`UPDATE … RETURNING`),
 * not a follow-up read: the client that reported the impression is the one
 * surface that cannot derive this number for itself — the dedupe window, the
 * self-view guard and the eligibility filter all live here — so throwing away a
 * value we already hold forces the whole UI to wait for the next feed fetch to
 * learn what it just caused. `RETURNING` also makes the answer the value the row
 * actually holds after the increment rather than a racing re-read.
 *
 * Resolves `postId` defensively: an id that is not a local post (e.g. a
 * federated URI) simply matches no row and is ignored rather than throwing. The
 * increment is awaited so callers can surface failures, but never throws — it
 * logs at debug.
 */
export async function recordDedupedView(postId: string, viewerId: string): Promise<number | null> {
  if (!postId || !viewerId) {
    return null;
  }

  const eligible = await isPostEligibleForViewTelemetry(postId);
  if (!eligible) {
    return null;
  }

  const redis = getRedisClient();

  // Atomically claim the (viewer, post) pair. Only the first claimant counts.
  const claimed = await withRedisFallback(
    redis,
    async () => {
      // SET key value NX EX ttl → "OK" when newly set, null when it already exists.
      const result = await redis.set(keyFor(postId, viewerId), '1', {
        NX: true,
        EX: DEDUPE_TTL_SECONDS,
      });
      return result === 'OK';
    },
    false,
    'feedViewCounterClaim',
  );

  if (!claimed) {
    return null;
  }

  try {
    // The visibility/status predicate stays on the WRITE as well as the
    // eligibility read above: a post that was unpublished between the two must
    // not have its counter moved. A row that no longer matches returns nothing,
    // which is the same "did not count" answer a duplicate gets.
    const [updated] = await getDb()
      .update(posts)
      .set({ statsViewsCount: sql`${posts.statsViewsCount} + 1` })
      .where(and(
        eq(posts.id, postId),
        eq(posts.visibility, PostVisibility.PUBLIC),
        eq(posts.status, 'published'),
      ))
      .returning({ viewsCount: posts.statsViewsCount });
    return updated?.viewsCount ?? null;
  } catch (error) {
    logger.debug('[FeedViewCounter] viewsCount increment failed', {
      postId,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
}
