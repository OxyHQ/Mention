import { FeedPostSlice } from '@mention/shared-types';
import { TunerContext } from '../FeedTuner';
import {
  NO_FOLLOWED_AUTHORS,
  compileMuteWords,
  isMutedSubject,
} from '../../../services/safety/muteWordMatcher';

/**
 * Drop feed slices whose anchor post the viewer muted.
 *
 * The matching rule itself lives in `services/safety/muteWordMatcher` — the same
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
