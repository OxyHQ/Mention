/**
 * Signal combiners — the pluggable seam that turns the per-signal `id →
 * multiplier` contributions into one scalar score.
 *
 * `MtnConfig.ranking.combiner` selects the strategy; today it is `'product'`, so
 * {@link productCombiner} is used. The seam exists so a future weighted /
 * learning-to-rank model can replace the multiplicative model WITHOUT touching
 * any individual signal — the signals keep returning bounded multipliers and
 * only the combiner changes.
 */

import type { SignalCombiner } from './signals/types';

/**
 * The DEFAULT combiner: the product of every contribution. Iterates the map in
 * insertion order (which the orchestrator seeds in registry order) and folds
 * from `1.0`, reproducing the pre-refactor left-to-right product exactly.
 */
export const productCombiner: SignalCombiner = (contributions) => {
  let score = 1;
  for (const multiplier of contributions.values()) {
    score *= multiplier;
  }
  return score;
};

/**
 * DOCUMENTED STUB — reserved for a future weighted / learning-to-rank swap; NOT
 * wired (config selects `'product'`). A weighted-sum model treats each signal's
 * multiplier as evidence in log space: `exp(Σ weight_i · ln(m_i))`. With uniform
 * unit weights (as here, since no per-signal weights are configured yet) this is
 * mathematically the product, so the stub is a correct, safe placeholder that
 * demonstrates the seam. A real model would source `weight_i` from config /
 * a trained ranker and could add a bias term. `m ≤ 0` (e.g. a hard-exclusion
 * `0`) collapses the score to `0`, preserving hard exclusions.
 */
export const weightedSumCombiner: SignalCombiner = (contributions) => {
  let logSum = 0;
  for (const multiplier of contributions.values()) {
    if (multiplier <= 0) {
      return 0;
    }
    logSum += Math.log(multiplier);
  }
  return Math.exp(logSum);
};

/**
 * Resolve the combiner selected by `MtnConfig.ranking.combiner`. Defaults to the
 * product combiner for any unknown value so ranking never silently breaks.
 */
export function resolveCombiner(strategy: string): SignalCombiner {
  return strategy === 'weightedSum' ? weightedSumCombiner : productCombiner;
}
