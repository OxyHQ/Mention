/**
 * The ordered ranking-signal registry.
 *
 * `FeedRankingService.calculatePostScore` iterates this array IN ORDER, guards
 * each contribution, and multiplies them (default combiner). The ORDER is
 * load-bearing: IEEE-754 multiplication is not associative, so it reproduces the
 * pre-refactor score expression byte-for-byte —
 *
 *   engagement · recency · relationship · authority · personalization ·
 *   quality · trendingVelocity · timeOfDay · threadBoost · negativePenalty · optIn
 *
 * (The pre-refactor product also carried a `diversityPenalty` factor here, but on
 * the `calculatePostScore` path it was ALWAYS `1.0` — the sequential diversity
 * pass in `rankPosts` runs against empty sets when scoring individual posts — so
 * it was dead and has been removed. The real diversity pass in `rankPosts` and
 * `diversifyByAuthor` is untouched.)
 *
 * Each signal's `group` maps its multiplier onto one of the six `_rank*`
 * explainer breakdown fields, so `RankingExplainer.explainRanking` is unchanged.
 */

import { authoritySignal } from './authority';
import { engagementSignal } from './engagement';
import { negativePenaltySignal } from './negativePenalty';
import { optInSignal } from './optIn';
import { personalizationSignal } from './personalization';
import { qualitySignal } from './quality';
import { recencySignal } from './recency';
import { relationshipSignal } from './relationship';
import { threadBoostSignal } from './threadBoost';
import { timeOfDaySignal } from './timeOfDay';
import { trendingVelocitySignal } from './trendingVelocity';
import type { RankingSignal, SignalGroup } from './types';

/**
 * The ordered signal registry. The array order defines both the multiplication
 * order of the product combiner and the Map insertion order of the collected
 * contributions.
 */
export const RANKING_SIGNALS: readonly RankingSignal[] = [
  engagementSignal,
  recencySignal,
  relationshipSignal,
  authoritySignal,
  personalizationSignal,
  qualitySignal,
  trendingVelocitySignal,
  timeOfDaySignal,
  threadBoostSignal,
  negativePenaltySignal,
  optInSignal,
];

/**
 * The neutral seed for each explainer breakdown group (multiplicative identity).
 * The orchestrator multiplies each signal's contribution into its group's slot,
 * in registry order, reproducing the pre-refactor `_rank*` fields:
 *   engagement, recency, relationship (author · authority),
 *   personalization (personalization · optIn),
 *   quality (quality · trendingVelocity · timeOfDay · threadBoost),
 *   diversity (negativePenalty).
 */
export function newGroupProducts(): Record<SignalGroup, number> {
  return {
    engagement: 1,
    recency: 1,
    relationship: 1,
    personalization: 1,
    quality: 1,
    diversity: 1,
  };
}
