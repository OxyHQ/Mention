/**
 * `relationship` signal — the viewer→author relationship multiplier. Follows and
 * learned author affinity lift; no relationship gets a slight penalty. Neutral
 * (1.0) for anonymous viewers.
 */

import { MtnConfig } from '@mention/shared-types';
import type { RankablePost, RankingUserBehavior, SignalContext } from '../signalContext';
import type { RankingSignal } from './types';

const R = MtnConfig.ranking;

/**
 * Calculate author relationship score.
 *
 * @param authorId - Oxy user ID of post author
 * @param userId - Oxy user ID of current user (or undefined)
 * @param followingIdsSet - Set of Oxy user IDs that current user follows
 * @param userBehavior - User behavior data from UserBehavior model
 */
export function authorRelationshipScore(
  authorId: string,
  userId: string | undefined,
  followingIdsSet: Set<string>,
  userBehavior: RankingUserBehavior | undefined,
): number {
  if (!userId) {
    return 1.0; // No personalization for anonymous users
  }

  // Check if following
  const isFollowing = followingIdsSet.has(authorId);
  if (isFollowing) {
    return R.relationship.followBoost;
  }

  // Check relationship strength from behavior data
  if (userBehavior?.preferredAuthors) {
    const authorPreference = userBehavior.preferredAuthors.find(
      (a) => a.authorId === authorId,
    );

    if (authorPreference) {
      // Strong relationship (weight > 0.7)
      if (authorPreference.weight > 0.7) {
        return R.relationship.strongRelation;
      }
      // Weak relationship (weight > 0.3)
      if (authorPreference.weight > 0.3) {
        return R.relationship.weakRelation;
      }
    }
  }

  // No relationship - slight penalty
  return R.relationship.noRelation;
}

export const relationshipSignal: RankingSignal = {
  id: 'relationship',
  group: 'relationship',
  score: (post: RankablePost, ctx: SignalContext) =>
    authorRelationshipScore(post.oxyUserId ?? '', ctx.userId, ctx.followingIdsSet, ctx.userBehavior),
};
