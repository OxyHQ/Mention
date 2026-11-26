/**
 * Signal combiners — the pluggable seam that turns the per-signal `id →
 * multiplier` contributions into one scalar score.
 *
 * The current ranking contract is multiplicative. Keeping the fold in one
 * function lets a future, fully specified model replace it without spreading
 * score math through individual signals.
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
