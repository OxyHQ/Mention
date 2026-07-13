/**
 * The contract every ranking signal implements, plus the combiner seam.
 *
 * A ranking signal is a PURE, named multiplier: given a candidate post and the
 * resolved {@link SignalContext}, it returns a factor (usually `> 0`, exactly
 * `1.0` when neutral, and `0` for a hard exclusion such as sensitive content).
 * `FeedRankingService.calculatePostScore` iterates the ordered registry, guards
 * each contribution against NaN/Infinity, and hands the `id → multiplier` map to
 * a {@link SignalCombiner} to produce the final score.
 */

import type { RankablePost, SignalContext } from '../signalContext';

/**
 * The six breakdown groups surfaced by `RankingExplainer.explainRanking`. Every
 * signal belongs to exactly one group; the orchestrator multiplies each group's
 * member contributions to reproduce the `_rank*` fields the explainer reads.
 */
export type SignalGroup =
  | 'engagement'
  | 'recency'
  | 'relationship'
  | 'personalization'
  | 'quality'
  | 'diversity';

/**
 * One ranking signal: a pure scorer plus the metadata the orchestrator needs to
 * combine it and to attribute it to an explainer group.
 */
export interface RankingSignal {
  /** Stable identifier; the key under which the contribution is collected. */
  id: string;
  /** Which explainer breakdown group this signal's multiplier folds into. */
  group: SignalGroup;
  /**
   * Marks a signal whose effect is entirely opt-in — it is exactly `1.0`
   * (neutral) unless the feed definition enabled it via `ctx.enabledSignals`.
   * The opt-in scorers live in `optIn.ts` and are composed there; this flag is
   * descriptive metadata (the composite is the sole opt-in-driven entry today).
   */
  optIn?: boolean;
  /**
   * The value substituted for this signal's contribution when its raw score is
   * NaN/Infinity. Defaults to `1.0` (neutral). Engagement uses `0` so a
   * corrupted engagement value zeroes the post rather than passing through.
   */
  fallback?: number;
  /** Compute this signal's multiplier for `post` under `ctx`. Pure. */
  score(post: RankablePost, ctx: SignalContext): number;
}

/**
 * Combines the per-signal `id → multiplier` contributions into a single scalar
 * score. `productCombiner` (the default, selected by `MtnConfig.ranking.combiner
 * === 'product'`) multiplies them; a future weighted / learning-to-rank model
 * can be swapped in behind this seam without touching any signal.
 */
export type SignalCombiner = (contributions: Map<string, number>) => number;
