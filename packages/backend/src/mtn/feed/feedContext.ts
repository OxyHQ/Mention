/**
 * Viewer feed-context assembly.
 *
 * The base {@link FeedEngineContext} a feed request runs against — following ids
 * (local + accepted federated), subscribed-list member ids, learned behavior,
 * dominant region, account languages, and the sensitive-content opt-in. Shared by
 * the descriptor feed controller (`/feed/mtn`) and the custom-feed timeline route
 * so both build an identical context (mutual-id resolution stays feed-specific in
 * the controller).
 *
 * Every load is best-effort and soft-fails to a safe default: a lookup error must
 * never break a feed or relax the sensitivity gate.
 */

import type { FeedTuning } from '@mention/shared-types';
import type { OxyClient } from '../../utils/privacyHelpers';
import { extractFollowingIds, extractFollowersIds } from '../../utils/privacyHelpers';
import FederatedFollow from '../../models/FederatedFollow';
import FederatedActor from '../../models/FederatedActor';
import UserSettings from '../../models/UserSettings';
import { listSubscriptionService } from '../../services/ListSubscriptionService';
import { userPreferenceService } from '../../services/UserPreferenceService';
import { resolveUserSummaries } from '../../services/PostHydrationService';
import type { IUserBehavior } from '../../models/UserBehavior';
import { logger } from '../../utils/logger';
import type { FeedEngineContext } from './engine/types';

/**
 * Merge oxyUserIds from accepted federated (ActivityPub) outbound follows into
 * `followingIds`, deduplicating in-place.
 */
export async function mergeFederatedFollowIds(localUserId: string, followingIds: string[]): Promise<void> {
  const fedFollowUris = await FederatedFollow.distinct('remoteActorUri', {
    localUserId,
    direction: 'outbound',
    status: 'accepted',
  });
  if (fedFollowUris.length === 0) return;

  const fedActors = await FederatedActor.find(
    { uri: { $in: fedFollowUris }, oxyUserId: { $ne: null } },
    { oxyUserId: 1 },
  ).lean();

  const existing = new Set(followingIds);
  for (const actor of fedActors) {
    const id = actor.oxyUserId;
    if (id && !existing.has(id)) {
      followingIds.push(id);
      existing.add(id);
    }
  }
}

/**
 * The viewer's account languages — canonical BCP-47 locales (`es-ES`, `en-US`),
 * primary first — for the `languageMismatchPenalty` ranking signal. The Oxy
 * account is the SINGLE source of truth here: languages are never derived from
 * behavior and never defaulted to a UI locale.
 *
 * The viewer's Oxy user is resolved through the SAME Redis-cached identity path
 * the feed already uses for post authors ({@link resolveUserSummaries}: batched
 * cache read, one bulk Oxy fetch for a miss), so an authenticated feed request
 * adds NO new Oxy round trip — the viewer is typically already warm in the cache.
 * `CachedUserSummary.languages` is normalized by the SDK's `getUserLanguages`
 * when the entry is filled.
 *
 * Fail-soft: an anonymous viewer, an unresolvable user, or any lookup error
 * yields `[]`, which keeps the penalty neutral rather than breaking the feed.
 */
export async function loadViewerLanguages(userId: string | undefined): Promise<string[]> {
  if (!userId) return [];
  try {
    const summaries = await resolveUserSummaries([userId]);
    return summaries.get(userId)?.languages ?? [];
  } catch (error) {
    logger.warn('[feedContext] Failed to load viewer languages', error);
    return [];
  }
}

/**
 * The viewer's "show sensitive/NSFW content" opt-in. `false` for anonymous
 * viewers, viewers with no settings, or on any load failure — only an explicit
 * stored `true` opts in.
 */
export async function loadShowSensitiveContent(userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  try {
    const doc = await UserSettings.findOne({ oxyUserId: userId }, { 'privacy.showSensitiveContent': 1 }).lean();
    return doc?.privacy?.showSensitiveContent === true;
  } catch (error) {
    logger.warn('[feedContext] Failed to load showSensitiveContent preference', error);
    return false;
  }
}

/**
 * The viewer's Mention-local per-user feed tuning (`UserSettings.feedTuning`,
 * Phase 4B). `undefined` for anonymous viewers, viewers with no stored tuning, or
 * on any load failure — so the For You gate falls back to its config defaults.
 * Read-only hot path: the value was validated on write, so it is returned as-is.
 */
export async function loadFeedTuning(userId: string | undefined): Promise<FeedTuning | undefined> {
  if (!userId) return undefined;
  try {
    const doc = await UserSettings.findOne({ oxyUserId: userId }, { feedTuning: 1 }).lean();
    return doc?.feedTuning ?? undefined;
  } catch (error) {
    logger.warn('[feedContext] Failed to load feed tuning', error);
    return undefined;
  }
}

/**
 * Assemble the base viewer feed context (no mutual ids — that is resolved per
 * descriptor by the controller). Anonymous viewers get empty following/behavior.
 */
export async function loadViewerFeedContext(
  currentUserId: string | undefined,
  oxyClient: OxyClient | undefined,
): Promise<FeedEngineContext> {
  let followingIds: string[] = [];
  let followerIds: string[] = [];
  let subscribedListMemberIds: string[] = [];
  let userBehavior: IUserBehavior | undefined;
  let showSensitiveContent = false;
  let feedTuning: FeedTuning | undefined;
  let viewerLanguages: string[] = [];

  if (currentUserId) {
    // Every branch is INDEPENDENT except the federated-follow merge, which chains
    // off the Oxy following list. Run them concurrently — a serial chain here was
    // ~5 sequential round trips of pure latency on the hottest feed path. Each
    // branch keeps its own best-effort soft-fail: a lookup error degrades that one
    // signal to its safe default (empty list / undefined / false) and never rejects
    // the aggregate, so one failure can't blank the feed.
    const followingPromise = (async (): Promise<string[]> => {
      let ids: string[] = [];
      if (oxyClient) {
        try {
          ids = extractFollowingIds(await oxyClient.getUserFollowing(currentUserId));
        } catch (error) {
          logger.warn('[feedContext] Failed to load following list', error);
        }
      }
      // Chained (not independent): the federated merge appends onto the Oxy list.
      try {
        await mergeFederatedFollowIds(currentUserId, ids);
      } catch (error) {
        logger.warn('[feedContext] Failed to load federated following', error);
      }
      return ids;
    })();

    // Follower ids — resolved here (in parallel) instead of later during hydration,
    // so the viewer graph is resolved ONCE per request and threaded downstream
    // (PostHydrationService no longer re-fetches getUserFollowing/getUserFollowers).
    const followerPromise = (async (): Promise<string[]> => {
      if (!oxyClient) return [];
      try {
        return extractFollowersIds(await oxyClient.getUserFollowers(currentUserId));
      } catch (error) {
        logger.warn('[feedContext] Failed to load followers list', error);
        return [];
      }
    })();

    const subscribedPromise = listSubscriptionService
      .getSubscribedListMemberIds(currentUserId)
      .catch((error): string[] => {
        logger.warn('[feedContext] Failed to load subscribed-list members', error);
        return [];
      });

    const behaviorPromise = userPreferenceService
      .getUserBehavior(currentUserId)
      .then((behavior): IUserBehavior | undefined => behavior ?? undefined)
      .catch((error): IUserBehavior | undefined => {
        logger.warn('[feedContext] Failed to load user behavior', error);
        return undefined;
      });

    // Already soft-fails to `false` internally.
    const sensitivePromise = loadShowSensitiveContent(currentUserId);

    // Already soft-fails to `undefined` internally.
    const tuningPromise = loadFeedTuning(currentUserId);

    // Already soft-fails to `[]` internally; served from the Redis identity cache.
    const languagesPromise = loadViewerLanguages(currentUserId);

    [
      followingIds,
      followerIds,
      subscribedListMemberIds,
      userBehavior,
      showSensitiveContent,
      feedTuning,
      viewerLanguages,
    ] = await Promise.all([
      followingPromise,
      followerPromise,
      subscribedPromise,
      behaviorPromise,
      sensitivePromise,
      tuningPromise,
      languagesPromise,
    ]);
  }

  return {
    currentUserId,
    followingIds,
    followerIds,
    subscribedListMemberIds,
    userBehavior,
    oxyClient,
    showSensitiveContent,
    feedTuning,
    viewerRegion: userPreferenceService.getTopRegion(userBehavior),
    // The viewer's Oxy account locales (BCP-47, primary first) — `[]` for an
    // anonymous viewer, an account with no languages, or any lookup failure, in
    // which case `languageMismatchPenalty` stays neutral.
    viewerLanguages,
  };
}
