/**
 * `engagement` signal — the base engagement score from a post's stats, with
 * logarithmic normalization so extremely popular posts cannot dominate.
 */

import { MtnConfig } from '@mention/shared-types';
import { nativeWeightedEngagement } from '../nativeEngagement';
import type { RankablePost, SignalContext } from '../signalContext';
import type { RankingSignal } from './types';

const R = MtnConfig.ranking;

/**
 * Weight for `shares` in the engagement composites. Not in `MtnConfig` yet, so
 * it is kept here as the single local constant the three composites share.
 */
export const SHARE_WEIGHT = 2.0;

/**
 * Calculate engagement score from post stats with logarithmic normalization.
 * Uses log scaling to prevent extremely popular posts from dominating.
 */
export function engagementScore(post: RankablePost): number {
  const stats = post.stats || {};
  const metadata = post.metadata || {};

  // Get saves count from metadata.savedBy array
  const savesCount = Array.isArray(metadata.savedBy)
    ? metadata.savedBy.length
    : 0;

  // Raw engagement via the shared native-weighted composite, so the federated
  // boost subset (`federatedBoostsCount`) is dampened to `federatedBoostWeight`
  // instead of the full native `boostWeight`. Includes views (the ranking
  // engagement score always has).
  const rawScore = nativeWeightedEngagement(
    {
      likes: stats.likesCount,
      boosts: stats.boostsCount,
      federatedBoosts: stats.federatedBoostsCount,
      comments: stats.commentsCount,
      saves: savesCount,
      views: stats.viewsCount,
      shares: stats.sharesCount,
    },
    R.engagement,
    SHARE_WEIGHT,
  );

  // Apply logarithmic scaling to prevent extremely popular posts from dominating
  // log(1 + x) normalizes the score, +1 prevents log(0)
  // Scale factor of 10 provides good normalization range
  return Math.log1p(rawScore / 10);
}

/**
 * Resolve the engagement multiplier for a post, preferring the request-scoped
 * pre-computed cache when the caller supplied one (populated in `rankPosts`),
 * otherwise computing it fresh. This mirrors the pre-refactor orchestrator's
 * cache-or-compute branch exactly.
 */
export function resolveEngagementScore(post: RankablePost, ctx: SignalContext): number {
  const postId = post._id?.toString() || '';
  const cache = ctx.engagementScoreCache;
  if (cache && cache.has(postId)) {
    const cached = cache.get(postId);
    if (typeof cached === 'number') {
      return cached;
    }
  }
  return engagementScore(post);
}

export const engagementSignal: RankingSignal = {
  id: 'engagement',
  group: 'engagement',
  // A NaN/Infinity engagement value zeroes the post (fallback 0), matching the
  // pre-refactor `safe(engagementScore, 0)` guard.
  fallback: 0,
  score: resolveEngagementScore,
};
