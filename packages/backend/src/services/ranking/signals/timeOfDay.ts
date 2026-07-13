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
): number {
  const activeHours = userBehavior?.activeHours;
  if (!activeHours || activeHours.length === 0) {
    return 1.0; // No preference data
  }

  const postDate = new Date(post.createdAt ?? NaN);
  const postHour = postDate.getHours();

  // Check if post was created during user's active hours
  if (activeHours.includes(postHour)) {
    return 1.2; // Boost for posts created during active hours
  }

  // Check adjacent hours (within 1 hour of active time)
  const adjacentHours = [
    (postHour + 23) % 24, // Previous hour
    (postHour + 1) % 24   // Next hour
  ];

  if (adjacentHours.some(h => activeHours.includes(h))) {
    return 1.1; // Slight boost for adjacent hours
  }

  return 1.0; // No boost
}

export const timeOfDaySignal: RankingSignal = {
  id: 'timeOfDay',
  group: 'quality',
  score: (post: RankablePost, ctx: SignalContext) => timeOfDayScore(post, ctx.userBehavior),
};
