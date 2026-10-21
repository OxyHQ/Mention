import { negativePenalty } from './negativePenalty';
import type { RankingSignal } from './types';

/** Initial product bounds, not an empirically tuned engagement claim. */
export const ACTIVITY_SUBSCRIPTION_BOOST = {
  maxMultiplier: 2,
  halfLifeHours: 24,
  maxAgeHours: 72,
} as const;

export const activitySubscriptionSignal: RankingSignal = {
  id: 'activitySubscriptionBoost',
  group: 'relationship',
  score: (post, ctx) => {
    if (
      !ctx.userId ||
      !ctx.enabledSignals?.has('activitySubscriptionBoost') ||
      !ctx.activitySubscribedAuthorIdsSet?.size
    )
      return 1;
    if (
      !post.activitySubscriptionMatch &&
      !ctx.activitySubscribedAuthorIdsSet.has(post.oxyUserId ?? '')
    )
      return 1;
    // Explicit negative feedback and content safety always win over the bell.
    if (
      negativePenalty(
        post,
        ctx.userId,
        ctx.userBehavior,
        ctx.behaviorSets,
        ctx.showSensitiveContent,
      ) < 1
    )
      return 1;
    const ageHours =
      ((ctx.rankingAsOf ?? Date.now()) - new Date(post.createdAt ?? NaN).getTime()) / 3_600_000;
    if (
      !Number.isFinite(ageHours) ||
      ageHours < 0 ||
      ageHours > ACTIVITY_SUBSCRIPTION_BOOST.maxAgeHours
    )
      return 1;
    return (
      1 +
      (ACTIVITY_SUBSCRIPTION_BOOST.maxMultiplier - 1) *
        2 ** (-ageHours / ACTIVITY_SUBSCRIPTION_BOOST.halfLifeHours)
    );
  },
};
