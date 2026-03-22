import { FeedPostSlice } from '@mention/shared-types';
import { TunerContext } from '../FeedTuner';

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
