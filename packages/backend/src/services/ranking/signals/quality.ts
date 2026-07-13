/**
 * `quality` signal — content quality × engagement velocity. When a post carries
 * a trusted AI/baseline `quality` score it drives the content factor; otherwise
 * the engagement-rate heuristic (robust at low view counts) is used. A freshness
 * velocity multiplier always applies.
 */

import { MtnConfig } from '@mention/shared-types';
import { nativeWeightedEngagement } from '../nativeEngagement';
import type { RankablePost } from '../signalContext';
import { getClassifiedScores } from './classification';
import { SHARE_WEIGHT } from './engagement';
import type { RankingSignal } from './types';

const R = MtnConfig.ranking;

/**
 * AI QUALITY multiplier from the classified `quality` score (0..1).
 *
 * Returns `null` when there is no usable AI signal so the caller falls back to
 * the engagement-rate quality heuristic. When present: a modest `highBoost`
 * for quality ≥ `highThreshold`, a modest `lowPenalty` for quality ≤
 * `lowThreshold`, and neutral `1.0` in between. Bounded by config, so the AI
 * quality signal nudges — never dominates — the multiplicative score.
 */
function aiQualityMultiplier(post: RankablePost): number | null {
  const scores = getClassifiedScores(post);
  if (!scores) {
    return null; // No usable AI signal → defer to engagement-rate quality.
  }

  const { highThreshold, lowThreshold, highBoost, lowPenalty } = R.aiQuality.quality;
  if (scores.quality >= highThreshold) {
    return highBoost;
  }
  if (scores.quality <= lowThreshold) {
    return lowPenalty;
  }

  return 1.0;
}

/**
 * Calculate content quality score with improved metrics.
 *
 * Combines two orthogonal factors, both bounded:
 * 1. CONTENT quality — the AI `quality` score when the post is classified
 *    ({@link aiQualityMultiplier}); otherwise the engagement-rate heuristic
 *    preserved below (rewarding genuine high-rate posts, penalizing
 *    high-view/no-engagement ones). An unscored post falls back to the exact
 *    prior engagement-rate behavior — it is never penalized for lacking AI.
 * 2. VELOCITY — recent engagement is more relevant (freshness multiplier).
 *
 * VELOCITY always applies; the AI quality signal, when present, REPLACES the
 * engagement-rate tier (they measure the same thing — content quality — so we
 * trust the AI judgment over the noisy engagement ratio rather than stacking
 * them).
 */
export function qualityScore(post: RankablePost): number {
  const stats = post.stats || {};
  const viewsCount = stats.viewsCount || 0;

  // Engagement velocity: posts with recent engagement are more relevant.
  const createdAtMs = new Date(post.createdAt ?? NaN).getTime();
  const postAge = isNaN(createdAtMs) ? Infinity : (Date.now() - createdAtMs) / (1000 * 60 * 60); // hours
  const velocityBoost = postAge < 6 ? 1.2 : postAge < 24 ? 1.1 : 1.0;

  // Prefer the AI content-quality signal when this post is classified. It is
  // bounded by config and replaces the engagement-rate tier (same concept,
  // higher-fidelity signal). `null` → no usable AI signal → fall through to the
  // engagement-rate heuristic below so unscored posts behave exactly as before.
  const aiQuality = aiQualityMultiplier(post);
  if (aiQuality !== null) {
    return aiQuality * velocityBoost;
  }

  // Raw engagement (before log scaling for rate calculation) via the shared
  // native-weighted composite. Views are intentionally omitted here (they are the
  // rate DENOMINATOR below, never a numerator term) — matching the prior behavior.
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

  // ROBUST engagement rate at low view counts: a post with only a few views
  // must not be promoted to "high quality" off a tiny denominator (2 views,
  // 1 like = rate 0.5). Below `minViewsForRate` we cannot trust the rate at
  // all, so quality is neutral (only velocity applies). At/above it we divide
  // by the ACTUAL view count.
  const minViewsForRate = R.quality.minViewsForRate;
  if (viewsCount < minViewsForRate) {
    return 1.0 * velocityBoost; // Not enough views to judge quality — neutral.
  }

  const engagementRate = rawEngagement / viewsCount;

  // High engagement rate = quality content
  if (engagementRate > 0.5) {
    return R.quality.highEngagement * velocityBoost;
  }

  // Medium engagement rate = decent quality
  if (engagementRate > 0.2) {
    return 1.0 * velocityBoost;
  }

  // Low engagement rate = lower quality (only once the post has enough views
  // to make that judgment — the gate was lowered 100 → config.lowEngagementMinViews).
  if (engagementRate < 0.1 && viewsCount > R.quality.lowEngagementMinViews) {
    return R.quality.lowEngagement;
  }

  return 1.0;
}

export const qualitySignal: RankingSignal = {
  id: 'quality',
  group: 'quality',
  score: (post: RankablePost) => qualityScore(post),
};
