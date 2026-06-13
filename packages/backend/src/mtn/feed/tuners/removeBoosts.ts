import { FeedPostSlice } from '@mention/shared-types';
import { TunerContext } from '../FeedTuner';

/**
 * Remove boost slices when user has hideBoosts enabled.
 */
export function removeBoosts(slices: FeedPostSlice[], ctx: TunerContext): FeedPostSlice[] {
  if (!ctx.preferences.hideBoosts) return slices;
  return slices.filter((slice) => slice.reason?.type !== 'boost');
}
