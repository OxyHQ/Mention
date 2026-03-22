import { FeedPostSlice } from '@mention/shared-types';
import { TunerContext } from '../FeedTuner';

/**
 * Filter sensitive content based on user preferences.
 */
export function filterSensitiveContent(slices: FeedPostSlice[], ctx: TunerContext): FeedPostSlice[] {
  if (!ctx.preferences.hideSensitive) return slices;

  return slices.filter((slice) => {
    const anchorPost = slice.items[0]?.post;
    if (!anchorPost) return true;
    return !anchorPost.metadata?.isSensitive;
  });
}
