import { FeedPostSlice } from '@mention/shared-types';
import { TunerContext } from '../FeedTuner';

/**
 * Remove repost slices when user has hideReposts enabled.
 */
export function removeReposts(slices: FeedPostSlice[], ctx: TunerContext): FeedPostSlice[] {
  if (!ctx.preferences.hideReposts) return slices;
  return slices.filter((slice) => slice.reason?.type !== 'repost');
}
