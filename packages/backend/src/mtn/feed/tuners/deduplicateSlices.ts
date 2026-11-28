// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { FeedPostSlice } from '@mention/shared-types';
import type { TunerContext } from '../FeedTuner';

/**
 * Remove duplicate posts across slices.
 */
export function deduplicateSlices(slices: FeedPostSlice[], _ctx: TunerContext): FeedPostSlice[] {
  const seen = new Set<string>();
  return slices.filter((slice) => {
    const key = slice._sliceKey;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
