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
 * window. Returns `true` when this call counted a NEW view (and thus performed
 * the increment), `false` when it was a duplicate or Redis was unavailable.
 *
 * Resolves `postId` defensively: an id that is not a local post (e.g. a
 * federated URI) simply matches no row and is ignored rather than throwing. The
 * increment is fire-and-forget at the call site's discretion (this function
 * awaits it so callers can surface failures, but never throws — it logs at
 * debug).
 */
export async function recordDedupedView(postId: string, viewerId: string): Promise<boolean> {
  if (!postId || !viewerId) {
    return false;
  }

  const eligible = await isPostEligibleForViewTelemetry(postId);
  if (!eligible) {
    return false;
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
    return false;
  }

  try {
    // The visibility/status predicate stays on the WRITE as well as the
    // eligibility read above: a post that was unpublished between the two must
    // not have its counter moved.
    await getDb()
      .update(posts)
      .set({ statsViewsCount: sql`${posts.statsViewsCount} + 1` })
      .where(and(
        eq(posts.id, postId),
        eq(posts.visibility, PostVisibility.PUBLIC),
        eq(posts.status, 'published'),
      ));
    return true;
  } catch (error) {
    logger.debug('[FeedViewCounter] viewsCount increment failed', {
      postId,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }
}
