/**
 * Viewer feed-context assembly.
 *
 * The base {@link FeedEngineContext} a feed request runs against — following ids
 * (local + accepted federated), subscribed-list member ids, learned behavior,
 * dominant region, and the sensitive-content opt-in. Shared by the descriptor
 * feed controller (`/feed/mtn`) and the custom-feed timeline route so both build
 * an identical context (mutual-id resolution stays feed-specific in the controller).
 *
 * Every load is best-effort and soft-fails to a safe default: a lookup error must
 * never break a feed or relax the sensitivity gate.
 */

import type { OxyClient } from '../../utils/privacyHelpers';
import { extractFollowingIds } from '../../utils/privacyHelpers';
import FederatedFollow from '../../models/FederatedFollow';
import FederatedActor from '../../models/FederatedActor';
import UserSettings from '../../models/UserSettings';
import { listSubscriptionService } from '../../services/ListSubscriptionService';
import { userPreferenceService } from '../../services/UserPreferenceService';
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
 * Assemble the base viewer feed context (no mutual ids — that is resolved per
 * descriptor by the controller). Anonymous viewers get empty following/behavior.
 */
export async function loadViewerFeedContext(
  currentUserId: string | undefined,
  oxyClient: OxyClient | undefined,
): Promise<FeedEngineContext> {
  let followingIds: string[] = [];
  let subscribedListMemberIds: string[] = [];
  let userBehavior: IUserBehavior | undefined;
  let showSensitiveContent = false;

  if (currentUserId) {
    if (oxyClient) {
      try {
        followingIds = extractFollowingIds(await oxyClient.getUserFollowing(currentUserId));
      } catch (error) {
        logger.warn('[feedContext] Failed to load following list', error);
      }
    }

    try {
      await mergeFederatedFollowIds(currentUserId, followingIds);
    } catch (error) {
      logger.warn('[feedContext] Failed to load federated following', error);
    }

    try {
      subscribedListMemberIds = await listSubscriptionService.getSubscribedListMemberIds(currentUserId);
    } catch (error) {
      logger.warn('[feedContext] Failed to load subscribed-list members', error);
    }

    try {
      userBehavior = (await userPreferenceService.getUserBehavior(currentUserId)) ?? undefined;
    } catch (error) {
      logger.warn('[feedContext] Failed to load user behavior', error);
    }

    showSensitiveContent = await loadShowSensitiveContent(currentUserId);
  }

  return {
    currentUserId,
    followingIds,
    subscribedListMemberIds,
    userBehavior,
    oxyClient,
    showSensitiveContent,
    viewerRegion: userPreferenceService.getTopRegion(userBehavior),
  };
}
