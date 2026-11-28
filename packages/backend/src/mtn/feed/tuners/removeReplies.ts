// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { FeedPostSlice } from '@mention/shared-types';
import type { TunerContext } from '../FeedTuner';

/**
 * Remove reply-context slices when user has hideReplies enabled.
 */
export function removeReplies(slices: FeedPostSlice[], ctx: TunerContext): FeedPostSlice[] {
  if (!ctx.preferences.hideReplies) return slices;
  return slices.filter((slice) => slice.reason?.type !== 'replyContext');
}
