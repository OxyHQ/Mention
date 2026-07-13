/**
 * `authority` signal — a viewer-independent popularity FLOOR from the author's
 * follower count. Small / unresolved authors sit at ~1.0 (no penalty); large
 * accounts get a modest, logarithmically-bounded lift.
 */

import { MtnConfig } from '@mention/shared-types';
import type { RankablePost, SignalContext } from '../signalContext';
import type { RankingSignal } from './types';

const R = MtnConfig.ranking;

/**
 * Calculate author-authority score from the author's follower count.
 *
 * Philosophy: a POPULARITY FLOOR, not domination. Small creators (and authors
 * whose follower count we couldn't resolve) sit at ~1.0 — no penalty — while
 * established accounts get a MODEST, logarithmically-bounded lift. The log
 * curve means going from 0→1k followers matters far more than 100k→101k, so a
 * handful of mega-accounts never crowd out everyone else.
 *
 * Shape: `1 + k * log1p(followers)`, clamped to `[min, max]`.
 *
 * @param followerCount - author's follower count, or `undefined` when unknown.
 * @returns a multiplier in `[min, max]`; exactly `1.0` (neutral) when unknown.
 */
export function authorityScore(followerCount: number | undefined): number {
  // Unknown follower count → neutral. Never penalize an unresolved author.
  if (typeof followerCount !== 'number' || !Number.isFinite(followerCount) || followerCount < 0) {
    return 1.0;
  }

  const { logScale, min, max } = R.authority;
  const raw = 1 + logScale * Math.log1p(followerCount);
  return Math.min(max, Math.max(min, raw));
}

export const authoritySignal: RankingSignal = {
  id: 'authority',
  group: 'relationship',
  score: (post: RankablePost, ctx: SignalContext) =>
    authorityScore(ctx.authorFollowerCounts?.get(String(post.oxyUserId))),
};
