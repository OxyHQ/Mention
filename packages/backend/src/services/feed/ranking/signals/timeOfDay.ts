/**
 * `timeOfDay` signal — a small boost for posts created during the viewer's
 * learned active hours (and a smaller one for adjacent hours). Neutral (1.0)
 * when there is no active-hours preference data.
 */

import type { RankablePost, RankingUserBehavior, SignalContext } from '../signalContext';
import type { RankingSignal } from './types';

/**
 * Calculate time-of-day relevance score.
 * Boosts posts created during user's active hours.
 */
export function timeOfDayScore(
  post: RankablePost,
  userBehavior: RankingUserBehavior | undefined,
  activeHourSet?: ReadonlySet<number>,
): number {
  const activeHours = activeHourSet ?? new Set(userBehavior?.activeHours ?? []);
  if (activeHours.size === 0) {
    return 1.0; // No preference data
  }

  // BOTH clocks are the server's, deliberately. `UserPreferenceService` records
  // `new Date().getHours()` when an interaction arrives and this reads the same
  // call on the post's timestamp, so the two shift together and a reader active
  // at 20:00 local matches a post made at 20:00 local whatever the server's zone
  // is. Converting ONE side to the viewer's timezone — the obvious-looking fix —
  // is what would break the match.
  const postHour = new Date(post.createdAt ?? NaN).getHours();

  if (activeHours.has(postHour)) {
    return 1.2; // Boost for posts created during active hours
  }

  // Adjacent hours (within one hour of an active one).
  if (activeHours.has((postHour + 23) % 24) || activeHours.has((postHour + 1) % 24)) {
    return 1.1; // Slight boost for adjacent hours
  }

  return 1.0; // No boost
}

export const timeOfDaySignal: RankingSignal = {
  id: 'timeOfDay',
  group: 'quality',
  score: (post: RankablePost, ctx: SignalContext) =>
    timeOfDayScore(post, ctx.userBehavior, ctx.behaviorSets?.activeHours),
};
