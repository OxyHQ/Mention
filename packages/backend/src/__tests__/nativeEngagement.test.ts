import { describe, it, expect } from 'vitest';
import { MtnConfig } from '@mention/shared-types';
import {
  nativeWeightedEngagement,
  type EngagementCounts,
  type EngagementWeights,
} from '../services/ranking/nativeEngagement';

/**
 * Unit tests for the shared native-weighted engagement composite (Phase 2).
 *
 * Two guarantees matter most:
 *  1. PARITY — with `federatedBoostWeight === boostWeight` the composite reproduces
 *     the EXACT prior formula (`boosts · boostWeight`) for any post, so wiring it
 *     in is behavior-neutral until the weight is actually lowered.
 *  2. DAMPENING — with the real `federatedBoostWeight = 0.5 < boostWeight`, a post
 *     whose boosts are ALL federated scores strictly lower than an identical post
 *     whose boosts are ALL native.
 */

const SHARE_WEIGHT = 2.0; // mirrors FeedRankingService.SHARE_WEIGHT

const REAL_WEIGHTS: EngagementWeights = MtnConfig.ranking.engagement;

/** Weights with the federated subset weighted IDENTICALLY to native boosts. */
const EQUAL_WEIGHTS: EngagementWeights = {
  ...MtnConfig.ranking.engagement,
  federatedBoostWeight: MtnConfig.ranking.engagement.boostWeight,
};

/**
 * The PRE-Phase-2 reference formula: a single flat boost term with no federated
 * split. Used to assert byte-for-byte parity under equal weights.
 */
function legacyEngagement(counts: EngagementCounts, w: EngagementWeights): number {
  return (
    (counts.likes || 0) * w.likeWeight +
    (counts.boosts || 0) * w.boostWeight +
    (counts.comments || 0) * w.commentWeight +
    (counts.saves || 0) * w.saveWeight +
    (counts.views || 0) * w.viewWeight +
    (counts.shares || 0) * SHARE_WEIGHT
  );
}

const SAMPLE_POSTS: EngagementCounts[] = [
  {},
  { likes: 3 },
  { likes: 10, boosts: 5, comments: 2, saves: 1, views: 200, shares: 4 },
  { likes: 0, boosts: 5, federatedBoosts: 5, comments: 0, views: 0 },
  { likes: 7, boosts: 8, federatedBoosts: 3, comments: 4, saves: 2, views: 50, shares: 1 },
  { boosts: 12, federatedBoosts: 12 },
];

describe('nativeWeightedEngagement — parity with equal weights', () => {
  it('reproduces the exact legacy formula for every sample post (boosts ≥ federatedBoosts)', () => {
    for (const counts of SAMPLE_POSTS) {
      const composite = nativeWeightedEngagement(counts, EQUAL_WEIGHTS, SHARE_WEIGHT);
      const legacy = legacyEngagement(counts, EQUAL_WEIGHTS);
      expect(composite).toBeCloseTo(legacy, 10);
    }
  });

  it('is a no-op for a post with NO federated boosts, even at the real (lower) federated weight', () => {
    // The pre-backfill guarantee: `federatedBoosts` absent (→ 0) collapses the
    // boost term back to `boosts · boostWeight` regardless of federatedBoostWeight.
    const counts: EngagementCounts = { likes: 4, boosts: 6, comments: 1, views: 30 };
    const dampened = nativeWeightedEngagement(counts, REAL_WEIGHTS, SHARE_WEIGHT);
    const legacy = legacyEngagement(counts, REAL_WEIGHTS);
    expect(dampened).toBeCloseTo(legacy, 10);
  });
});

describe('nativeWeightedEngagement — federated dampening', () => {
  it('scores an all-federated-boost post strictly below an identical all-native-boost post', () => {
    const nativeOnly: EngagementCounts = { boosts: 5, federatedBoosts: 0 };
    const federatedOnly: EngagementCounts = { boosts: 5, federatedBoosts: 5 };

    const nativeScore = nativeWeightedEngagement(nativeOnly, REAL_WEIGHTS, SHARE_WEIGHT);
    const federatedScore = nativeWeightedEngagement(federatedOnly, REAL_WEIGHTS, SHARE_WEIGHT);

    expect(federatedScore).toBeLessThan(nativeScore);
    // The federated post's boost term is exactly the federated:native weight ratio.
    expect(federatedScore / nativeScore).toBeCloseTo(
      REAL_WEIGHTS.federatedBoostWeight / REAL_WEIGHTS.boostWeight,
      10,
    );
  });

  it('weights the native and federated subsets of a mixed post independently', () => {
    // 8 boosts, 3 of them federated → 5 native·2.5 + 3 federated·0.5.
    const counts: EngagementCounts = { boosts: 8, federatedBoosts: 3 };
    const expected =
      5 * REAL_WEIGHTS.boostWeight + 3 * REAL_WEIGHTS.federatedBoostWeight;
    expect(nativeWeightedEngagement(counts, REAL_WEIGHTS, SHARE_WEIGHT)).toBeCloseTo(expected, 10);
  });

  it('guards the config invariant: federatedBoostWeight is below boostWeight and equals 0.5', () => {
    expect(REAL_WEIGHTS.federatedBoostWeight).toBeLessThan(REAL_WEIGHTS.boostWeight);
    expect(REAL_WEIGHTS.federatedBoostWeight).toBe(0.5);
  });
});

describe('nativeWeightedEngagement — null-safety & flooring', () => {
  it('treats a missing federatedBoosts field as 0 (pre-backfill safe)', () => {
    const withField: EngagementCounts = { boosts: 4, federatedBoosts: 0 };
    const withoutField: EngagementCounts = { boosts: 4 };
    expect(nativeWeightedEngagement(withoutField, REAL_WEIGHTS, SHARE_WEIGHT)).toBeCloseTo(
      nativeWeightedEngagement(withField, REAL_WEIGHTS, SHARE_WEIGHT),
      10,
    );
  });

  it('never lets the native boost term go negative when federatedBoosts exceeds boosts', () => {
    // Pathological over-count: 2 boosts but 5 federated → native floored at 0, so
    // the boost contribution is purely the federated subset (never negative).
    const counts: EngagementCounts = { boosts: 2, federatedBoosts: 5 };
    const score = nativeWeightedEngagement(counts, REAL_WEIGHTS, SHARE_WEIGHT);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeCloseTo(5 * REAL_WEIGHTS.federatedBoostWeight, 10);
  });

  it('returns 0 for an empty post', () => {
    expect(nativeWeightedEngagement({}, REAL_WEIGHTS, SHARE_WEIGHT)).toBe(0);
  });
});
