/**
 * The single shared NATIVE-WEIGHTED engagement composite (JS side).
 *
 * Federated boosts (inbound ActivityPub Announces) are persisted as native boosts
 * (`stats.boostsCount`) but separately counted in `stats.federatedBoostsCount`. A
 * remote Announce is a much weaker relevance signal than a native repost, so this
 * composite splits the boost total into its two subsets and weights them
 * differently:
 *
 *   - the NATIVE subset — `max(0, boosts − federatedBoosts)`, floored at 0 so a
 *     stale / over-counted federated tally can never make the term negative — is
 *     weighted at `boostWeight` (2.5), and
 *   - the FEDERATED subset is weighted at the deliberately-lower
 *     `federatedBoostWeight` (0.5).
 *
 * Setting `federatedBoostWeight === boostWeight` reproduces the exact prior
 * behavior (`boosts · boostWeight`), and `federatedBoosts === 0` (every
 * pre-backfill post, where the field is absent → 0) does the same — so wiring this
 * in is a safe no-op until the corpus backfill runs.
 *
 * This is the ONE JS composite; `FeedRankingService` uses it for its engagement,
 * quality-rate and trending-density computations so the three can never drift.
 * (The Mongo side has its own single source of truth in
 * `engine/sources/discoverySources.ts` `engagementScoreExpr`.)
 */

/**
 * The engagement weights the composite reads — structurally the shape of
 * `MtnConfig.ranking.engagement`. Declared with plain `number` fields (rather than
 * the `as const` literal type) so callers can pass tuned copies (e.g. tests that
 * set `federatedBoostWeight === boostWeight` to assert parity).
 */
export interface EngagementWeights {
  likeWeight: number;
  boostWeight: number;
  federatedBoostWeight: number;
  commentWeight: number;
  saveWeight: number;
  viewWeight: number;
}

/**
 * Raw per-post engagement counts. Every field is optional and an absent /
 * non-positive value contributes 0, so a lean or partial post projection composes
 * safely. `views`/`shares` are opt-in per call site: the ranking engagement score
 * includes views while the quality-rate and trending-density composites
 * historically do not — omit `views` there to preserve that behavior exactly.
 */
export interface EngagementCounts {
  likes?: number;
  boosts?: number;
  /**
   * How many of `boosts` originated as inbound federated Announces
   * (`stats.federatedBoostsCount`). Weighted at `federatedBoostWeight`; the
   * remaining native boosts are weighted at `boostWeight`.
   */
  federatedBoosts?: number;
  comments?: number;
  saves?: number;
  views?: number;
  shares?: number;
}

/** Coerce a possibly-absent count to a non-negative number (matches `x || 0`). */
function toCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Compute the weighted native engagement of a post. Pure function of its inputs.
 *
 * @param counts     raw per-post engagement counts (absent ⇒ 0)
 * @param weights    the engagement weights (`MtnConfig.ranking.engagement`)
 * @param shareWeight weight for `shares` (kept separate — not in the engagement
 *                   config today)
 */
export function nativeWeightedEngagement(
  counts: EngagementCounts,
  weights: EngagementWeights,
  shareWeight: number,
): number {
  const boosts = toCount(counts.boosts);
  const federatedBoosts = toCount(counts.federatedBoosts);
  // Native boosts are the boosts that did NOT arrive as federated Announces,
  // floored at 0 so an over-count can never turn the term negative.
  const nativeBoosts = Math.max(0, boosts - federatedBoosts);

  return (
    toCount(counts.likes) * weights.likeWeight +
    nativeBoosts * weights.boostWeight +
    federatedBoosts * weights.federatedBoostWeight +
    toCount(counts.comments) * weights.commentWeight +
    toCount(counts.saves) * weights.saveWeight +
    toCount(counts.views) * weights.viewWeight +
    toCount(counts.shares) * shareWeight
  );
}
