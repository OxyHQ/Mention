import { FeedPostSlice } from '@mention/shared-types';
import { TunerContext } from '../FeedTuner';

/**
 * Remove reply-context slices when user has hideReplies enabled.
 */
export function removeReplies(slices: FeedPostSlice[], ctx: TunerContext): FeedPostSlice[] {
  if (!ctx.preferences.hideReplies) return slices;
  return slices.filter((slice) => slice.reason?.type !== 'replyContext');
}
