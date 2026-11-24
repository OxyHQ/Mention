/**
 * `promotion` signal: the lift a paid promotion gives its post while it is behind
 * its schedule (`services/promotion/pacing`). Neutral (1.0) for every other post
 * and for every feed that did not enable it, so enabling the feature cannot move
 * an unpromoted post by a single point.
 */

import type { RankablePost } from '../signalContext';
import type { RankingSignal } from './types';

export const promotionSignal: RankingSignal = {
  id: 'promotion',
  group: 'quality',
  optIn: true,
  score: (post: RankablePost, ctx) =>
    ctx.enabledSignals?.has('promotion') && post.promotionBoost ? post.promotionBoost : 1,
};
