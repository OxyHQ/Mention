import { FeedPostSlice } from '@mention/shared-types';
import { TunerContext } from '../FeedTuner';

/**
 * Inject "you're all caught up" breakpoint markers into the feed.
 * These are empty slices with a special reason that the frontend can render.
 *
 * Not included in the default pipeline — opt-in per feed type.
 */
export function injectBreakpoints(slices: FeedPostSlice[], _ctx: TunerContext): FeedPostSlice[] {
  // Placeholder: in future, detect time gaps or seen-post boundaries
  // and insert marker slices. For now, pass through.
  return slices;
}
