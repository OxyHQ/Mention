import mongoose from 'mongoose';
import { MtnConfig, PostVisibility } from '@mention/shared-types';
import { Post } from '../models/Post';
import { getRedisClient } from '../utils/redis';
import { withRedisFallback, ensureRedisConnected } from '../utils/redisHelpers';
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
 * Mirrors the design of {@link ./mediaCache/negativeCache} and
 * {@link ./linkPreviewCache}: shared Redis singleton, graceful fallback, TTL set
 * atomically with the marker.
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
 * window. Returns `true` when this call counted a NEW view (and thus performed
 * the increment), `false` when it was a duplicate or Redis was unavailable.
 *
 * Resolves `postId` defensively: a non-ObjectId `postId` (e.g. a federated URI
 * that is not a local post) is ignored rather than throwing. The Mongo `$inc`
 * is fire-and-forget at the call site's discretion (this function awaits it so
 * callers can surface failures, but never throws — it logs at debug).
 */
export async function recordDedupedView(postId: string, viewerId: string): Promise<boolean> {
  if (!postId || !viewerId || !mongoose.isValidObjectId(postId)) {
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
      const connected = await ensureRedisConnected(redis);
      if (!connected) return false;
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
    await Post.updateOne(
      { _id: postId, visibility: PostVisibility.PUBLIC, status: 'published' },
      { $inc: { 'stats.viewsCount': 1 } },
    );
    return true;
  } catch (error) {
    logger.debug('[FeedViewCounter] viewsCount increment failed', {
      postId,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }
}
