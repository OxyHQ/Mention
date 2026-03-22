import { FeedPostSlice } from '@mention/shared-types';
import { TunerContext } from '../FeedTuner';

/**
 * Remove duplicate posts across slices.
 */
export function deduplicateSlices(slices: FeedPostSlice[], _ctx: TunerContext): FeedPostSlice[] {
  const seen = new Set<string>();
  return slices.filter((slice) => {
    const key = slice._sliceKey;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
