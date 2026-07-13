/**
 * `trendingVelocity` signal — a boost for young posts with high engagement
 * DENSITY (engagement per hour). Federated Announces are dampened by the shared
 * native-weighted composite, so a burst of remote boosts no longer inflates a
 * post into "trending".
 */

import { MtnConfig } from '@mention/shared-types';
import { nativeWeightedEngagement } from '../nativeEngagement';
import type { RankablePost } from '../signalContext';
import { SHARE_WEIGHT } from './engagement';
import type { RankingSignal } from './types';

const R = MtnConfig.ranking;

/**
 * Calculate trending boost for posts with accelerating engagement.
 * Detects posts that are gaining traction rapidly.
 */
export function trendingBoost(post: RankablePost): number {
  const stats = post.stats || {};
  const createdAtMs = new Date(post.createdAt ?? NaN).getTime();
  const postAge = isNaN(createdAtMs) ? Infinity : (Date.now() - createdAtMs) / (1000 * 60 * 60); // hours

  // Only consider posts less than 24 hours old for trending
  if (postAge > 24) {
    return 1.0;
  }

  // Calculate engagement density (engagement per hour) via the shared
  // native-weighted composite, so a burst of federated Announces no longer
  // inflates a post into a trending boost. Views omitted (density is over the
  // active engagement signals, as before).
  const rawEngagement = nativeWeightedEngagement(
    {
      likes: stats.likesCount,
      boosts: stats.boostsCount,
      federatedBoosts: stats.federatedBoostsCount,
      comments: stats.commentsCount,
      saves: Array.isArray(post.metadata?.savedBy) ? post.metadata.savedBy.length : 0,
      shares: stats.sharesCount,
    },
    R.engagement,
    SHARE_WEIGHT,
  );

  const engagementPerHour = rawEngagement / Math.max(postAge, 0.1);

  // Boost posts with high engagement density (trending)
  if (engagementPerHour > 50) {
    return 1.5; // Strong trending boost
  } else if (engagementPerHour > 20) {
    return 1.3; // Moderate trending boost
  } else if (engagementPerHour > 10) {
    return 1.15; // Light trending boost
  }

  return 1.0; // No trending boost
}

export const trendingVelocitySignal: RankingSignal = {
  id: 'trendingVelocity',
  group: 'quality',
  score: (post: RankablePost) => trendingBoost(post),
};
