// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { FeedPostSlice } from '@mention/shared-types';
import type { TunerContext } from '../FeedTuner';
import {
  NO_FOLLOWED_AUTHORS,
  compileMuteWords,
  isMutedSubject,
} from '../../../services/moderation/safety/muteWordMatcher';

/**
 * Drop feed slices whose anchor post the viewer muted.
 *
 * The matching rule itself lives in `services/moderation/safety/muteWordMatcher` — the same
 * one search and notifications call — so a muted word means the same thing on every
 * surface. This tuner only adapts the feed's slice shape to it.
 */
export function filterMuteWords(slices: FeedPostSlice[], ctx: TunerContext): FeedPostSlice[] {
  const compiled = compileMuteWords(ctx.preferences.muteWords);
  if (!compiled) return slices;

  // Indexing the follow list is worth it only for an `exclude-following` rule, which
  // most viewers do not have — every other viewer pays nothing for the scope.
  const followedAuthorIds = compiled.needsFollowState
    ? new Set(ctx.followedAuthorIds ?? [])
    : NO_FOLLOWED_AUTHORS;

  return slices.filter((slice) => {
    const anchorPost = slice.items[0]?.post;
    if (!anchorPost) return true;

    return !isMutedSubject(
      compiled,
      {
        text: anchorPost.content?.text,
        hashtags: anchorPost.metadata.hashtags,
        authorId: anchorPost.user?.id,
      },
      followedAuthorIds,
    );
  });
}
