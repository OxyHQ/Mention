// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { FeedPostSlice } from '@mention/shared-types';
import type { TunerContext } from '../FeedTuner';

/**
 * Remove posts the user has explicitly hidden.
 */
export function filterHiddenPosts(slices: FeedPostSlice[], ctx: TunerContext): FeedPostSlice[] {
  const hidden = ctx.preferences.hiddenPostIds;
  if (!hidden || hidden.size === 0) return slices;

  return slices.filter((slice) => {
    const anchorPost = slice.items[0]?.post;
    if (!anchorPost) return true;
    return !hidden.has(anchorPost.id);
  });
}
