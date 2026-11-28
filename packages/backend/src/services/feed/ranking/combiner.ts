// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
