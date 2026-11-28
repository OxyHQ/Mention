// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * `threadBoost` signal — a small lift for thread ROOT posts that sparked replies
 * (they render as grouped slices and are more valuable feed items). Neutral
 * (1.0) otherwise.
 */

import type { RankablePost } from '../signalContext';
import type { RankingSignal } from './types';

/**
 * Calculate thread boost for thread root posts with replies.
 * Thread roots that sparked conversation are more valuable feed items,
 * especially since they'll be displayed as grouped slices.
 */
export function threadBoost(post: RankablePost): number {
  const hasThread = post.threadId && !post.parentPostId;
  const hasReplies = (post.stats?.commentsCount || 0) > 0;

  if (hasThread && hasReplies) {
    return 1.1; // 10% boost for thread roots with conversation
  }
  return 1.0;
}

export const threadBoostSignal: RankingSignal = {
  id: 'threadBoost',
  group: 'quality',
  score: (post: RankablePost) => threadBoost(post),
};
