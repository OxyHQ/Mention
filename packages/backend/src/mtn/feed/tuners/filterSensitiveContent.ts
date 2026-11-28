// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { FeedPostSlice } from '@mention/shared-types';
import type { TunerContext } from '../FeedTuner';

/**
 * Filter sensitive content based on user preferences.
 */
export function filterSensitiveContent(
  slices: FeedPostSlice[],
  ctx: TunerContext,
): FeedPostSlice[] {
  if (!ctx.preferences.hideSensitive) return slices;

  return slices.filter((slice) => {
    const anchorPost = slice.items[0]?.post;
    if (!anchorPost) return true;
    return !anchorPost.metadata?.isSensitive;
  });
}
