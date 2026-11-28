import type { FeedPostSlice } from '@mention/shared-types';
import type { TunerContext } from '../FeedTuner';
import { isRepostType } from '@mention/shared-types';

/**
 * Remove boost slices when user has hideBoosts enabled.
 */
export function removeReposts(slices: FeedPostSlice[], ctx: TunerContext): FeedPostSlice[] {
  if (!ctx.preferences.hideBoosts) return slices;
  return slices.filter((slice) => !isRepostType(slice.reason?.type));
}
