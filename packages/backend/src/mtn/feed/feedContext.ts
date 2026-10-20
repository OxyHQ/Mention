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

import { MtnConfig, toBaseLanguages, type FeedTuning } from '@mention/shared-types';
import type { FeedRankingSettings } from '../../services/ranking/signalContext';
import type { OxyClient } from '../../utils/privacyHelpers';
import { getFollowingIds, getFollowerIds } from '../../utils/privacyHelpers';
import { loadUserSettings } from '../../db/userProfile/userSettingsRepository';
import { listSubscriptionService } from '../../services/ListSubscriptionService';
import { userPreferenceService } from '../../services/UserPreferenceService';
import { getUserLanguages } from '@oxy.so/core';
import { mergeFederatedFollowIds } from '../../services/viewerFollowGraph';
import { loadMutedLaneIds } from '../../services/safety/viewerSafety';
import type { UserBehaviorRecord } from '../../db/userProfile/userBehaviorRecord';
import { logger } from '../../utils/logger';
import type { FeedEngineContext } from './engine/types';

/**
 * How many untrusted request languages reach a query. This bounds two things
 * that would otherwise grow with an
 * attacker-supplied `Accept-Language`: the width of the `&&` array overlap on
 * the discovery lanes, and the cardinality of the anonymous feed cache, whose
 * key now carries this set.
 */
const MAX_VIEWER_LANGUAGES = MtnConfig.feed.discoveryLanguage.maxViewerLanguages;

/**
 * The reader's READABILITY set: which languages they can read at all, as ISO
 * 639-1 BASE subtags, primary first. Only request fallback locales are capped.
 *
 * Deliberately SEPARATE from {@link loadViewerLanguages}, which answers a
 * different question with a different unit, and conflating the two is a real bug
 * rather than a tidiness point:
 *
 *   - "which RENDITION of this post do I show?" is `viewerLanguages` — canonical
 *     BCP-47, ordered, region-SIGNIFICANT. `selectVariantForTag` matches the
 *     exact locale before falling back to the base subtag, so a `pt-BR` reader
 *     gets the Brazilian variant rather than the Portuguese one. Feed the base
 *     subtag in and that preference silently disappears.
 *   - "can this reader read this post AT ALL?" is this — base only, region
 *     IRRELEVANT. A Mexican Spanish reader reads Spain's Spanish.
 *
 * Both are resolved from the same two rungs in the same order (Oxy account, else
 * the request), so they can never disagree about WHO the reader is — only about
 * how precisely the answer is needed.
 */
export function resolveViewerBaseLanguages(
  accountLanguages: readonly string[],
  requestLanguages: readonly string[],
): string[] {
  const account = toBaseLanguages(accountLanguages);
  if (account.length > 0) return account;
  return toBaseLanguages(requestLanguages).slice(0, MAX_VIEWER_LANGUAGES);
}

/**
 * Read the viewer's ordered locales from Oxy's owner profile. Public author
 * summaries omit languages, so they cannot supply account feed preferences.
 * The client carries this request's user credential; these private preferences
 * never enter the shared public-user cache. Delegated clients without a self
 * read and failed lookups fall back to the request's languages downstream.
 */
export async function loadViewerLanguages(
  userId: string | undefined,
  oxyClient?: OxyClient,
): Promise<string[]> {
  if (!userId || !oxyClient?.users) return [];
  try {
    const user = await oxyClient.users.me();
    if (user.id !== userId) return [];
    return getUserLanguages(user);
  } catch (error) {
    logger.warn('[feedContext] Failed to load viewer languages', error);
    return [];
  }
}

/**
 * The viewer's two Mention-local feed preference documents, from ONE read.
 *
 * They live on the same `UserSettings` row and were loaded separately — except
 * that `feedSettings` was never loaded at all. It is validated on write
 * (`routes/profileSettings.ts`), stored, typed, and read by
 * `FeedRankingService` for the recency half-life, the max age and the diversity
 * penalties — but `loadViewerFeedContext` never put it on the context, so every
 * reader in production got `undefined` and the config defaults. A viewer who
 * lengthened their recency half-life or turned diversity off in `/settings/feed`
 * changed nothing about their feed.
 *
 * Both are read here together because they are one row: adding the second one as
 * its own loader would have doubled the reads on the hottest feed path to fetch
 * two fields of the same document.
 *
 * Fail-soft: an anonymous viewer, no stored settings, or any load failure yields
 * `{}`, so both fall back to their config defaults. Read-only hot path — the
 * values were validated on write and are returned as-is.
 */
export async function loadFeedPreferences(userId: string | undefined): Promise<{
  feedTuning?: FeedTuning;
  feedSettings?: FeedRankingSettings;
  showSensitiveContent: boolean;
}> {
  if (!userId) return { showSensitiveContent: false };
  try {
    const doc = await loadUserSettings(userId);
    return {
      feedTuning: doc?.feedTuning ?? undefined,
      feedSettings: doc?.feedSettings ?? undefined,
      // Only an explicit stored `true` opts in — the same rule
      // `loadShowSensitiveContent` states for the surfaces that read it on its
      // own (search, notifications). Folded in here rather than loaded beside
      // this: it is a THIRD field of the row this already reads in full, and the
      // separate loader made the feed path issue a second query for one column
      // of a document it was holding.
      showSensitiveContent: doc?.privacy?.showSensitiveContent === true,
    };
  } catch (error) {
    logger.warn('[feedContext] Failed to load feed preferences', error);
    return { showSensitiveContent: false };
  }
}

/**
 * Assemble the base viewer feed context (no mutual ids — that is resolved per
 * descriptor by the controller). Anonymous viewers get empty following/behavior,
 * but NOT empty languages: `requestLanguages` (`?lang=`, then `Accept-Language`)
 * is their only declaration and it is honored.
 *
 * `acceptedOutboundFollowUris` is an OPTIONAL in-flight read of the viewer's
 * accepted outbound federated follows, threaded straight to
 * {@link mergeFederatedFollowIds}. A caller that needs the same set anyway (the
 * descriptor controller, which also intersects it for mutuals) passes it so the
 * request issues that statement ONCE; a caller that does not omits it and the
 * merge reads it itself.
 */
export async function loadViewerFeedContext(
  currentUserId: string | undefined,
  oxyClient: OxyClient | undefined,
  acceptedOutboundFollowUris?: Promise<string[]>,
  requestLanguages: readonly string[] = [],
): Promise<FeedEngineContext> {
  let followingIds: string[] = [];
  let followerIds: string[] = [];
  let subscribedListMemberIds: string[] = [];
  let userBehavior: UserBehaviorRecord | undefined;
  let feedPreferences: Awaited<ReturnType<typeof loadFeedPreferences>> = {
    showSensitiveContent: false,
  };
  let viewerLanguages: string[] = [];
  let mutedLaneIds: string[] = [];

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
          ids = await getFollowingIds(currentUserId, oxyClient);
        } catch (error) {
          logger.warn('[feedContext] Failed to load following list', error);
        }
      }
      // Chained (not independent): the federated merge appends onto the Oxy list.
      // `acceptedOutboundFollowUris`, when the caller passes it, is the SAME
      // in-flight read the caller already needed for its own reasons, so the
      // merge costs one `federated_actors` lookup instead of two statements.
      try {
        await mergeFederatedFollowIds(currentUserId, ids, acceptedOutboundFollowUris);
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
        return await getFollowerIds(currentUserId, oxyClient);
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
      .then((behavior): UserBehaviorRecord | undefined => behavior ?? undefined)
      .catch((error): UserBehaviorRecord | undefined => {
        logger.warn('[feedContext] Failed to load user behavior', error);
        return undefined;
      });

    // Already soft-fails to `{}` internally. ONE read for both documents — they
    // are two fields of the same `UserSettings` row.
    const preferencesPromise = loadFeedPreferences(currentUserId);

    // Owner-only Oxy read, concurrent with the other context lookups.
    const languagesPromise = loadViewerLanguages(currentUserId, oxyClient);

    // Already soft-fails to `[]` internally. One small indexed read, and `[]` for
    // almost every reader — the engine's predicate is then `undefined`, i.e. free.
    const mutedLanesPromise = loadMutedLaneIds(currentUserId);

    [
      followingIds,
      followerIds,
      subscribedListMemberIds,
      userBehavior,
      feedPreferences,
      viewerLanguages,
      mutedLaneIds,
    ] = await Promise.all([
      followingPromise,
      followerPromise,
      subscribedPromise,
      behaviorPromise,
      preferencesPromise,
      languagesPromise,
      mutedLanesPromise,
    ]);
  }

  return {
    currentUserId,
    followingIds,
    followerIds,
    subscribedListMemberIds,
    userBehavior,
    oxyClient,
    showSensitiveContent: feedPreferences.showSensitiveContent,
    feedTuning: feedPreferences.feedTuning,
    // The viewer's own ranking knobs from `/settings/feed`. Loaded alongside
    // `feedTuning` from the same row; `undefined` leaves every knob at its
    // `MtnConfig.ranking` default.
    feedSettings: feedPreferences.feedSettings,
    viewerRegion: userPreferenceService.getTopRegion(userBehavior),
    // The viewer's Oxy account locales (BCP-47, primary first) — `[]` for an
    // anonymous viewer, an account with no languages, or any lookup failure.
    // Consumed by hydration's VARIANT selection, where the region matters.
    viewerLanguages,
    // The readability set, from the SAME two rungs as `viewerLanguages` but in
    // base form. Resolved for an ANONYMOUS reader too — they have no account, but
    // they do have a request, and a signed-out For You was the surface with no
    // language signal at all (measured 48% `de` on a 6.8%-`de` corpus).
    viewerBaseLanguages: resolveViewerBaseLanguages(viewerLanguages, requestLanguages),
    // Lanes this reader silenced. Applied by `FeedEngine` as an in-memory
    // predicate — EMPTY for almost everybody, in which case it costs nothing.
    mutedLaneIds,
  };
}
