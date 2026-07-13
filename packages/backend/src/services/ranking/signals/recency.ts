/**
 * `recency` signal — time-decay score. Very recent posts score ~1.0; older posts
 * decay exponentially with a configurable half-life and cut off past a max age.
 */

import { MtnConfig } from '@mention/shared-types';
import type { RankablePost, SignalContext } from '../signalContext';
import type { RankingSignal } from './types';

const R = MtnConfig.ranking;

/**
 * Calculate recency score with time decay.
 *
 * @param createdAt - Post creation date
 * @param halfLifeHours - Optional custom half-life (from user settings)
 * @param maxAgeHours - Optional custom max age (from user settings)
 */
export function recencyScore(
  createdAt: Date | string | undefined,
  halfLifeHours?: number,
  maxAgeHours?: number,
): number {
  const postDate = new Date(createdAt ?? NaN);
  if (isNaN(postDate.getTime())) {
    return 0; // Invalid date, treat as very old post
  }
  const now = new Date();
  const ageHours = (now.getTime() - postDate.getTime()) / (1000 * 60 * 60);

  const maxAge = maxAgeHours || R.recency.maxAgeMs / (1000 * 60 * 60);
  // If post is older than max age, return 0
  if (ageHours > maxAge) {
    return 0;
  }

  const halfLife = halfLifeHours || R.recency.halfLifeMs / (1000 * 60 * 60);

  // Very recent posts (within 1 hour) get full score
  if (ageHours < 1) {
    return 1.0;
  }

  // Exponential decay with half-life: value = 0.5 ^ (age / halfLife)
  // This provides smooth decay that accelerates as posts age
  const decayFactor = Math.pow(0.5, ageHours / halfLife);

  // Ensure minimum value to prevent complete zero for recent posts
  return Math.max(0.05, decayFactor);
}

export const recencySignal: RankingSignal = {
  id: 'recency',
  group: 'recency',
  score: (post: RankablePost, ctx: SignalContext) =>
    recencyScore(
      post.createdAt,
      ctx.feedSettings?.recency?.halfLifeHours,
      ctx.feedSettings?.recency?.maxAgeHours,
    ),
};
