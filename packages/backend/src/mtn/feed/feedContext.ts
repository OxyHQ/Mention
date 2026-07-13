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

import type { FeedTuning } from '@mention/shared-types';
import type { OxyClient } from '../../utils/privacyHelpers';
import { extractFollowingIds, extractFollowersIds } from '../../utils/privacyHelpers';
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
 * Extract the viewer's account content-languages (ISO 639-1 codes) from their Oxy
 * user DTO, for the `languageMismatchPenalty` ranking signal.
 *
 * UPSTREAM-READY: the Oxy account is the SINGLE source of truth for the viewer's
 * languages (never derived from behavior, never defaulted to a locale). This pure
 * reader normalizes a plural `languages: string[]` field off the Oxy user — the
 * moment oxy-api/oxy-core expose it, wiring this into {@link loadViewerFeedContext}
 * lights the penalty up with zero further changes. Reads via the DTO index
 * signature (no `as any`), lowercases, trims, dedupes, and drops non-strings;
 * returns `[]` when the field is absent so the signal stays neutral.
 */
export function resolveViewerLanguages(user: Record<string, unknown> | null | undefined): string[] {
  const raw = user?.languages;
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const code = entry.trim().toLowerCase();
    if (code.length > 0) seen.add(code);
  }
  return Array.from(seen);
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

    [followingIds, followerIds, subscribedListMemberIds, userBehavior, showSensitiveContent, feedTuning] =
      await Promise.all([
        followingPromise,
        followerPromise,
        subscribedPromise,
        behaviorPromise,
        sensitivePromise,
        tuningPromise,
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
    // Viewer content-languages — UPSTREAM-BLOCKED, left empty (→ neutral penalty).
    //
    // The Oxy user DTO the Mention backend receives (serialized by
    // `formatUserResponse` in oxy-api) exposes ONLY a singular UI-locale
    // `language` (default 'en'), NOT a plural account content-`languages`
    // preference. Reading that singular default-'en' locale as the viewer's
    // content languages would penalize ALL non-English discovery for essentially
    // every account — exactly the "assume en" behavior this design forbids. No
    // plural `languages`/`contentLanguages` field exists anywhere in Oxy today.
    //
    // FIX-UPSTREAM (oxy-api User model + `formatUserResponse`; oxy-core `User`
    // interface): add an account `languages: string[]`. Once it lands on the DTO,
    // resolve the viewer's own Oxy user (e.g. via `resolveUserSummaries([
    // currentUserId])`, Redis-cached) and set:
    //   viewerLanguages: resolveViewerLanguages(viewerUser)
    // Until then this stays empty and `languageMismatchPenalty` is neutral for all.
    viewerLanguages: [],
  };
}
