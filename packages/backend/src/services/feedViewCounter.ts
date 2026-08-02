import mongoose from 'mongoose';
import { MtnConfig, PostVisibility } from '@mention/shared-types';
import { Post } from '../models/Post';
import { getRedisClient } from '../utils/redis';
import { withRedisFallback } from '../utils/redisHelpers';
import { logger } from '../utils/logger';

/**
 * Deduplicated post-view counting for feed impressions.
 *
 * A feed impression (a post that was actually on screen long enough to count)
 * should increment `Post.stats.viewsCount` AT MOST ONCE per viewer within a
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
  if (!postId || !mongoose.isValidObjectId(postId)) {
    return false;
  }

  const post = await Post.exists({
    _id: postId,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
  });

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
 * The count comes back on the increment's OWN round trip (`findOneAndUpdate`
 * with `new: true`), not a follow-up read: the client that reported the
 * impression is the one surface that cannot derive this number for itself — the
 * dedupe window, the self-view guard and the eligibility filter all live here —
 * so throwing away a value we already hold forces the whole UI to wait for the
 * next feed fetch to learn what it just caused.
 *
 * Resolves `postId` defensively: a non-ObjectId `postId` (e.g. a federated URI
 * that is not a local post) is ignored rather than throwing. The Mongo write is
 * awaited so callers can surface failures, but never throws — it logs at debug.
 */
export async function recordDedupedView(postId: string, viewerId: string): Promise<number | null> {
  if (!postId || !viewerId || !mongoose.isValidObjectId(postId)) {
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
    const updated = await Post.findOneAndUpdate(
      { _id: postId, visibility: PostVisibility.PUBLIC, status: 'published' },
      { $inc: { 'stats.viewsCount': 1 } },
      { new: true, projection: { 'stats.viewsCount': 1 } },
    ).lean();
    return updated?.stats?.viewsCount ?? null;
  } catch (error) {
    logger.debug('[FeedViewCounter] viewsCount increment failed', {
      postId,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
}
