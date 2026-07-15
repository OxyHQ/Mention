/**
 * MTN Feed Controller
 *
 * Clean orchestrator replacing the 2186-line monolith.
 * Flow: parse descriptor → resolve FeedAPI → fetch → apply tuner → respond.
 */

import { Request, Response } from 'express';
import { isValidFeedDescriptor, MtnConfig, createPostUri, parseFeedDescriptor } from '@mention/shared-types';
import type { FeedDescriptor, SlicedFeedResponse } from '@mention/shared-types';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { resolveDefinition } from '../feed/definitions/resolveDefinition';
import { forYouUsesSocialProof } from '../feed/definitions/presets';
import { feedEngine } from '../feed/engine/FeedEngine';
import type { FeedEngineContext } from '../feed/engine/types';
import { loadViewerFeedContext, mergeFederatedFollowIds } from '../feed/feedContext';
import { resolveDiscoveryGateBucket } from '../feed/discoveryGateExperiment';
import { FeedGeneratorFeed } from '../feed/feeds/FeedGeneratorFeed';
import type { FeedAPI } from '../feed/FeedAPI';
import { FeedTuner } from '../feed/FeedTuner';
import { planInterstitials } from '../feed/interstitials/planInterstitials';
import { parseInterstitialEvent, recordInterstitialEvent } from '../feed/interstitials/interstitialTelemetry';
import { FeedResponseBuilder } from '../../utils/FeedResponseBuilder';
import { queryString } from '../../utils/queryParams';
import { UserPrivacyManager } from '../UserPrivacyManager';
import { trackFeedInteraction } from '../feed/FeedInteractionTracker';
import { federatedProfileSync } from '../../connectors/federatedProfileSync';
import { logger } from '../../utils/logger';
import { oxy as oxyClient } from '../../../server';
import { extractFollowingIds } from '../../utils/privacyHelpers';
import FederatedFollow from '../../models/FederatedFollow';
import FederatedActor from '../../models/FederatedActor';
import { MuteWord } from '../../models/MuteWord';
import { listSubscriptionService } from '../../services/ListSubscriptionService';
import { anonFeedCache } from '../../services/anonFeedCache';
import type { TunerContext } from '../feed/FeedTuner';

type MutePreference = NonNullable<TunerContext['preferences']['muteWords']>;

function syncFlattenedItemsWithSlices(response: Pick<SlicedFeedResponse, 'slices' | 'items' | 'totalCount'>): void {
  response.items = FeedResponseBuilder.flattenSlicesToItems(response.slices);
  response.totalCount = response.items.length;
}

/**
 * Load the user's muted words/hashtags and map them into the tuner-preference
 * shape consumed by `filterMuteWords`. One query per feed request — no N+1.
 * Returns an empty array for anonymous viewers or on load failure (fail-open:
 * a muted-word lookup error must never break the feed).
 */
async function loadMuteWordsForUser(userId: string | undefined): Promise<MutePreference> {
  if (!userId) return [];
  try {
    const docs = await MuteWord.find(
      { userId },
      { value: 1, targets: 1 },
    ).lean();
    return docs.map((doc) => ({ value: doc.value, targets: doc.targets }));
  } catch (error) {
    logger.warn('[MtnFeedController] Failed to load muted words', error);
    return [];
  }
}

/** Hard cap on the mutual-id set threaded into the Mutuals feed context. */
const MAX_MUTUAL_IDS = 5000;

/**
 * Federated mutuals: remote actors the viewer both follows (accepted outbound)
 * AND is followed by (accepted inbound), mapped to their linked Oxy user ids.
 */
async function getFederatedMutualIds(localUserId: string): Promise<string[]> {
  const [outbound, inbound] = await Promise.all([
    FederatedFollow.distinct('remoteActorUri', { localUserId, direction: 'outbound', status: 'accepted' }),
    FederatedFollow.distinct('remoteActorUri', { localUserId, direction: 'inbound', status: 'accepted' }),
  ]);
  const outboundSet = new Set(outbound as string[]);
  const mutualUris = (inbound as string[]).filter((uri) => outboundSet.has(uri));
  if (mutualUris.length === 0) return [];

  const actors = await FederatedActor.find(
    { uri: { $in: mutualUris }, oxyUserId: { $ne: null } },
    { oxyUserId: 1 },
  ).lean();
  return actors
    .map((actor) => actor.oxyUserId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * The viewer's mutual-follow author ids for the Mutuals feed: Oxy graph mutuals
 * (via `@oxyhq/core` `getMutualUserIds`) ∪ federated mutuals. Both branches
 * soft-fail to `[]`, so a failure in either source degrades the Mutuals feed to
 * the other rather than erroring. Deduped and capped.
 */
async function computeMutualIds(currentUserId: string): Promise<string[]> {
  let oxyMutualIds: string[] = [];
  try {
    const ids = await oxyClient.getMutualUserIds({ limit: MAX_MUTUAL_IDS });
    oxyMutualIds = ids.filter((id) => id.length > 0);
  } catch (error) {
    logger.warn('[MtnFeedController] Failed to load Oxy mutual ids', error);
  }

  let federatedMutualIds: string[] = [];
  try {
    federatedMutualIds = await getFederatedMutualIds(currentUserId);
  } catch (error) {
    logger.warn('[MtnFeedController] Failed to load federated mutual ids', error);
  }

  return Array.from(new Set([...oxyMutualIds, ...federatedMutualIds])).slice(0, MAX_MUTUAL_IDS);
}

/** Hard cap on the friends-of-friends id set threaded into the feed context. */
const MAX_FOF_IDS = 5000;

/**
 * Structural capability for the Oxy follows-of-follows endpoint. The SDK method
 * is not shipped yet (upstream, handled separately), so it is invoked via a
 * runtime capability check rather than a hard dependency — exactly the mutuals
 * upstream pattern. When the method lands on `@oxyhq/core`, this guard passes and
 * the feed goes live with no further Mention change.
 */
interface FollowsOfFollowsCapable {
  getFollowsOfFollowsIds(params?: { limit?: number }): Promise<string[]>;
}

function supportsFollowsOfFollows(client: unknown): client is FollowsOfFollowsCapable {
  return typeof (client as { getFollowsOfFollowsIds?: unknown }).getFollowsOfFollowsIds === 'function';
}

/**
 * The viewer's friends-of-friends author ids for the Friends-of-Friends feed.
 * Resolved via the Oxy follows-of-follows endpoint (guarded optional call: the
 * SDK method does not exist yet, so this soft-fails to `[]` until it ships).
 * Bounded + deduped by the endpoint contract (excludes the viewer's own follows
 * and self).
 */
async function computeFriendsOfFriendsIds(): Promise<string[]> {
  if (!supportsFollowsOfFollows(oxyClient)) return [];
  try {
    const ids = await oxyClient.getFollowsOfFollowsIds({ limit: MAX_FOF_IDS });
    return ids.filter((id) => typeof id === 'string' && id.length > 0).slice(0, MAX_FOF_IDS);
  } catch (error) {
    logger.warn('[MtnFeedController] Failed to load friends-of-friends ids', error);
    return [];
  }
}


/**
 * Resolve the one descriptor still served by a legacy FeedAPI: `feedgen|uri`
 * (external generator stub). Custom feeds are engine-owned (via
 * `resolveDefinition`); everything else returns `null`.
 */
function resolveLegacyFeed(descriptor: FeedDescriptor): FeedAPI | null {
  const { source, params } = parseFeedDescriptor(descriptor);
  if (source === 'feedgen') return new FeedGeneratorFeed(params[0]);
  return null;
}

/**
 * Keyspace isolator for {@link anonFeedCache}. The MTN controller emits a
 * `SlicedFeedResponse`, whereas the legacy feed controller caches a flat
 * `FeedResponse` under the same key helper — namespacing guarantees the two
 * never read each other's entries for an overlapping descriptor name.
 */
const ANON_FEED_CACHE_NAMESPACE = 'mtn';

/**
 * An author feed served EMPTY on its FIRST page is how a federated profile gets
 * discovered: nobody has imported that actor's posts yet. Hand the author to the
 * federation layer, which syncs their outbox in the background and tells us
 * whether to report the page as `pending` (client shows a loading state and
 * refetches shortly, instead of rendering a permanently empty profile).
 *
 * Nothing here blocks on remote I/O — `syncOnProfileView` awaits one indexed
 * lookup and detaches the network work. A later page (`cursor` present) is a
 * genuine end-of-feed, and a page WITH items needs no sync.
 */
async function resolveAuthorFeedPending(
  descriptor: FeedDescriptor,
  cursor: string | undefined,
  response: SlicedFeedResponse,
): Promise<boolean> {
  if (cursor || response.items.length > 0) return false;
  const { source, params } = parseFeedDescriptor(descriptor);
  if (source !== 'author') return false;
  const authorId = params[0];
  if (!authorId) return false;
  return federatedProfileSync.syncOnProfileView(authorId);
}

function parseVideoFeedFilters(
  descriptor: FeedDescriptor,
  query: AuthRequest['query'],
): FeedEngineContext['videoFilters'] | undefined {
  if (parseFeedDescriptor(descriptor).source !== 'videos') return undefined;

  const orientationRaw = typeof query.orientation === 'string' ? query.orientation.trim().toLowerCase() : '';
  const orientation = orientationRaw === 'portrait'
    || orientationRaw === 'landscape'
    || orientationRaw === 'square'
    || orientationRaw === 'all'
    ? orientationRaw
    : undefined;

  const minDurationRaw = typeof query.minDuration === 'string' ? parseInt(query.minDuration, 10) : NaN;
  const minDurationSec = Number.isFinite(minDurationRaw) && minDurationRaw > 0
    ? minDurationRaw
    : undefined;

  if (!orientation && minDurationSec === undefined) return undefined;
  return { orientation, minDurationSec };
}

class MtnFeedController {
  /**
   * GET /api/feed?descriptor=for_you&cursor=...&limit=30
   *
   * Unified feed endpoint. Resolves any feed descriptor.
   */
  async getFeed(req: AuthRequest, res: Response): Promise<void> {
    try {
      // Read query params through `queryString`, never through a cast: a tampered
      // `?cursor[]=a&cursor[]=b` arrives as an ARRAY, and the interstitial planner
      // hashes the cursor character by character — an array there is an unhandled
      // TypeError, i.e. a 500 from a crafted URL.
      const descriptorParam = queryString(req.query.descriptor);
      if (!descriptorParam || !isValidFeedDescriptor(descriptorParam)) {
        res.status(400).json({ success: false, error: 'Invalid or missing feed descriptor' });
        return;
      }

      // `isValidFeedDescriptor` is a type guard, so this is already a FeedDescriptor.
      const descriptor: FeedDescriptor = descriptorParam;
      const cursor = queryString(req.query.cursor);
      const limit = Math.min(
        Math.max(parseInt(queryString(req.query.limit) ?? '', 10) || MtnConfig.feed.defaultLimit, 1),
        MtnConfig.feed.maxLimit
      );
      const videoFilters = parseVideoFeedFilters(descriptor, req.query);

      const currentUserId = req.user?.id;

      // Anonymous feeds are identical for every logged-out viewer (no per-user
      // following/blocked/muted/seen state — see loadViewerFeedContext), so the
      // fully built page is cached in Redis for a short window. Reading here
      // short-circuits the entire context load + engine run + hydration. The key
      // captures everything that varies an anon result (descriptor, limit,
      // cursor); it is namespaced so it never collides with the legacy
      // controller's differently-shaped cache. Fail-soft: a miss/error falls
      // straight through to a live build. Authenticated feeds are personalized
      // and must never be cached.
      const anonCacheKey = !currentUserId
        ? anonFeedCache.buildKey({
            namespace: ANON_FEED_CACHE_NAMESPACE,
            type: descriptor,
            limit,
            cursor,
            ...(videoFilters ? { filters: videoFilters as Record<string, unknown> } : {}),
          })
        : undefined;
      if (anonCacheKey) {
        const cached = await anonFeedCache.read(anonCacheKey);
        if (cached) {
          res.json({ success: true, data: cached });
          return;
        }
      }

      // Everything the feed needs before the engine runs is INDEPENDENT, so it
      // loads CONCURRENTLY instead of in a serial waterfall (this was ~4 sequential
      // round trips of pure latency on the hottest path):
      //   - privacy state (blocked/muted authors) — applied to the response below;
      //   - the viewer feed context (following/followers/subscribed lists/learned
      //     behavior/region/sensitive opt-in), assembled by the shared loader;
      //   - the descriptor-scoped mutual / friends-of-friends id sets (below);
      //   - the viewer's muted words (prefetched; only awaited if the page has
      //     slices — see the tuner block).
      // Each branch already soft-fails to a safe default, so one failure can't
      // break the feed.
      const feedSource = parseFeedDescriptor(descriptor).source;

      // The Mutuals feed ALWAYS needs the viewer's mutual-follow id set; For You
      // needs it too, but ONLY when the `socialProof` signal is active (Phase 5) —
      // it widens the network-engager set to `following ∪ mutuals`, so mutuals are
      // worth the extra Oxy round trip only then. Resolved for exactly those
      // descriptors so no other feed pays for it.
      const needsMutuals = !!currentUserId
        && (feedSource === 'mutuals' || (feedSource === 'for_you' && forYouUsesSocialProof()));
      // The Friends-of-Friends feed needs the viewer's follows-of-follows id set
      // (guarded Oxy optional call). Resolved ONLY for that descriptor.
      const needsFof = !!currentUserId && feedSource === 'friends_of_friends';

      // Prefetched here so it runs in parallel with the context load; only consumed
      // (awaited) below if the built page actually has slices. `loadMuteWordsForUser`
      // never rejects (soft-fails to `[]`), so leaving it un-awaited on a blank page
      // cannot surface an unhandled rejection.
      const muteWordsPromise = loadMuteWordsForUser(currentUserId);

      const [privacyState, context, mutualIds, fofIds] = await Promise.all([
        currentUserId
          ? UserPrivacyManager.loadPrivacyState(currentUserId)
          : Promise.resolve(null),
        loadViewerFeedContext(currentUserId, oxyClient),
        // `computeMutualIds` soft-fails each branch to `[]`, so a lookup failure
        // never breaks the feed.
        needsMutuals && currentUserId
          ? computeMutualIds(currentUserId)
          : Promise.resolve<string[] | null>(null),
        needsFof
          ? computeFriendsOfFriendsIds()
          : Promise.resolve<string[] | null>(null),
      ]);

      if (videoFilters) {
        context.videoFilters = videoFilters;
      }
      if (mutualIds) {
        context.mutualIds = mutualIds;
      }
      if (fofIds) {
        context.fofIds = fofIds;
      }

      // Phase 7 discovery-gate A/B: assign this For You viewer a stable cohort so
      // the gate is enforced (`gate-on`) or measure-only (`gate-off`) for them,
      // letting the two be compared before full enforcement. `undefined` (the
      // default — experiment off, or non-For-You) leaves gate behavior on the
      // global shadow config.
      if (currentUserId && feedSource === 'for_you') {
        const bucket = resolveDiscoveryGateBucket(currentUserId);
        if (bucket) {
          context.discoveryGateBucket = bucket;
        }
      }

      // Resolve the descriptor to a composable feed DEFINITION and run it through
      // the engine. Custom feeds resolve via the viewer context (owner/visibility
      // checked); `feedgen|uri` (external stub) is the only remaining legacy path.
      const definition = await resolveDefinition(descriptor, context);
      let response: SlicedFeedResponse;
      if (definition) {
        response = await feedEngine.run(definition, context, { cursor, limit });
      } else {
        const feedApi = resolveLegacyFeed(descriptor);
        if (!feedApi) {
          res.status(400).json({ success: false, error: `Unsupported feed descriptor: ${descriptor}` });
          return;
        }
        response = await feedApi.fetch({ cursor, limit }, context);
      }

      // Filter out posts from blocked/muted users
      if (privacyState && privacyState.excludedUserIds.size > 0) {
        response.items = response.items.filter((item) => {
          const authorId = item.user?.id;
          return !authorId || !privacyState.excludedUserIds.has(authorId);
        });
        response.slices = response.slices.filter((slice) => {
          const anchorAuthor = slice.items?.[0]?.post?.user?.id;
          return !anchorAuthor || !privacyState.excludedUserIds.has(anchorAuthor);
        });
        syncFlattenedItemsWithSlices(response);
      }

      // Apply tuner pipeline
      if (response.slices.length > 0) {
        const muteWords = await muteWordsPromise;
        const tuner = FeedTuner.default();
        response.slices = tuner.apply(response.slices, {
          viewerId: currentUserId,
          preferences: {
            muteWords,
            hideBoosts: false,
            hideReplies: false,
            hideSensitive: false,
          },
        });
        syncFlattenedItemsWithSlices(response);
      }

      // A profile feed with nothing in it may be a federated author nobody has
      // imported yet — hand it to the federation layer (background sync) and
      // report `pending` so the client polls rather than showing an empty
      // profile. No-op for every other descriptor and for pages that have items.
      const pending = await resolveAuthorFeedPending(descriptor, cursor, response);
      if (pending) {
        response.pending = true;
      }

      // Plan this page's recommendation-card placements. Pure, synchronous, and
      // I/O-free (it reads the already-truncated slices and the follow count the
      // context loaded anyway), so the feed never waits on recommendation data —
      // the client fetches each card's contents lazily. Planned LAST, after the
      // tuner has settled the final slice list, so a slot can only ever anchor to
      // a slice that actually shipped.
      //
      // Slots live at the TOP LEVEL of the response and NEVER inside
      // `slices[].items` — that array is flattened into `items[]`, which must stay
      // strictly posts for every existing client.
      //
      // Authenticated viewers only: slots are personalized (they key off the
      // viewer's graph), and an anonymous page is shared via `anonFeedCache`.
      if (currentUserId) {
        response.interstitials = planInterstitials({
          descriptor,
          slices: response.slices,
          // An unresolved follow list reads as an empty graph — the coldest
          // temperature, which is the right default: it bootstraps discovery.
          followingCount: context.followingIds?.length ?? 0,
          isFirstPage: !cursor,
          cursor,
          // The viewer, so the profile card is dropped on their own profile.
          currentUserId,
        });
      }

      // Persist the freshly built anonymous page (fail-soft; no-op for
      // authenticated requests). Written after the tuner pipeline so the cached
      // value is identical to what a live build returns.
      //
      // A `pending` page is NEVER cached: it is a transient "posts are still
      // importing" answer, and serving it from cache for the TTL would pin the
      // client in a poll loop against a profile whose posts have already landed.
      if (anonCacheKey && !response.pending) {
        await anonFeedCache.write(anonCacheKey, response);
      }

      res.json({
        success: true,
        data: response,
      });
    } catch (error) {
      logger.error('[MtnFeedController] getFeed error', error);
      res.status(500).json({ success: false, error: 'Failed to fetch feed' });
    }
  }

  /**
   * GET /api/feed/peek?descriptor=following
   *
   * "New posts" indicator — peek at the latest item without consuming cursor.
   */
  async peekLatest(req: AuthRequest, res: Response): Promise<void> {
    try {
      // Same boundary narrowing as getFeed: a query param can arrive as an array.
      const descriptorParam = queryString(req.query.descriptor);
      if (!descriptorParam || !isValidFeedDescriptor(descriptorParam)) {
        res.status(400).json({ success: false, error: 'Invalid or missing feed descriptor' });
        return;
      }

      const descriptor: FeedDescriptor = descriptorParam;
      const currentUserId = req.user?.id;

      const privacyState = currentUserId
        ? await UserPrivacyManager.loadPrivacyState(currentUserId)
        : null;

      let followingIds: string[] = [];
      let subscribedListMemberIds: string[] = [];
      if (currentUserId) {
        try {
          const followingRes = await oxyClient.getUserFollowing(currentUserId);
          followingIds = extractFollowingIds(followingRes);
        } catch (error) {
          logger.warn('[MtnFeedController] Failed to load following list', error);
        }

        try {
          await mergeFederatedFollowIds(currentUserId, followingIds);
        } catch (error) {
          logger.warn('[MtnFeedController] Failed to load federated following', error);
        }

        try {
          subscribedListMemberIds = await listSubscriptionService.getSubscribedListMemberIds(currentUserId);
        } catch (error) {
          logger.warn('[MtnFeedController] Failed to load subscribed-list members', error);
        }
      }

      const context: FeedEngineContext = {
        currentUserId,
        followingIds,
        subscribedListMemberIds,
        oxyClient,
      };

      if (currentUserId && parseFeedDescriptor(descriptor).source === 'mutuals') {
        context.mutualIds = await computeMutualIds(currentUserId);
      }

      if (currentUserId && parseFeedDescriptor(descriptor).source === 'friends_of_friends') {
        context.fofIds = await computeFriendsOfFriendsIds();
      }

      const definition = await resolveDefinition(descriptor, context);
      let latest;
      if (definition) {
        latest = await feedEngine.peekLatest(definition, context);
      } else {
        const feedApi = resolveLegacyFeed(descriptor);
        if (!feedApi) {
          res.status(400).json({ success: false, error: `Unsupported feed descriptor: ${descriptor}` });
          return;
        }
        latest = await feedApi.peekLatest(context);
      }
      res.json({
        success: true,
        data: latest ? { uri: createPostUri(String(latest.user?.id), String(latest.id)), post: latest } : null,
      });
    } catch (error) {
      logger.error('[MtnFeedController] peekLatest error', error);
      res.status(500).json({ success: false, error: 'Failed to peek feed' });
    }
  }

  /**
   * POST /api/feed/interactions
   *
   * Record feed interaction data (impressions, clicks, engagement).
   */
  async recordInteraction(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      // Optional auth: this route runs under `optionalAuth`, so anonymous public
      // browse reaches it too (the web feed reports impression telemetry for
      // everyone). There is no viewer to attribute an anonymous interaction to,
      // and ranking must never ingest anonymous signal — so silently no-op with a
      // 200 rather than 401. A 401 here spammed anonymous feeds with failed
      // requests and console errors.
      if (!userId) {
        res.json({ success: true });
        return;
      }

      const { feedDescriptor, postUri, event, durationMs } = req.body;
      if (!feedDescriptor || !postUri || !event) {
        res.status(400).json({ success: false, error: 'Missing required fields' });
        return;
      }

      const validEvents = ['impression', 'click', 'like', 'reply', 'boost', 'save', 'report'];
      if (!validEvents.includes(event)) {
        res.status(400).json({ success: false, error: `Invalid event: ${event}` });
        return;
      }

      await trackFeedInteraction({
        userId,
        feedDescriptor,
        postUri,
        event,
        durationMs,
        timestamp: new Date(),
      });

      res.json({ success: true });
    } catch (error) {
      logger.error('[MtnFeedController] recordInteraction error', error);
      res.status(500).json({ success: false, error: 'Failed to record interaction' });
    }
  }

  /**
   * POST /api/feed/mtn/interstitial-events
   *
   * What a viewer did with a recommendation CARD (impression / click / follow /
   * subscribe / use / dismiss / see-more).
   *
   * Deliberately NOT `recordInteraction` above: that route requires a `postUri`
   * and feeds POST ranking through `trackFeedInteraction`, so card engagement
   * sent there would corrupt author/topic affinity with engagement that never
   * touched a post. Card events land as low-cardinality counters and nothing
   * else — no ranking signal, no per-row documents.
   *
   * Synchronous: recording is an in-process counter increment, so telemetry can
   * never add latency or an I/O failure mode to the feed.
   */
  recordInterstitialEvent(req: AuthRequest, res: Response): void {
    try {
      // Same optional-auth contract as `recordInteraction`: the route runs under
      // `optionalAuth`, and a 401 here would spam anonymous feeds with failed
      // requests. Cards are only ever planned for authenticated viewers, so an
      // anonymous report has nothing to measure — no-op with a 200.
      if (!req.user?.id) {
        res.json({ success: true });
        return;
      }

      const parsed = parseInterstitialEvent(req.body);
      if (!parsed.ok) {
        res.status(400).json({ success: false, error: parsed.error });
        return;
      }

      recordInterstitialEvent(parsed.input);
      res.json({ success: true });
    } catch (error) {
      logger.error('[MtnFeedController] recordInterstitialEvent error', error);
      res.status(500).json({ success: false, error: 'Failed to record interstitial event' });
    }
  }
}

export const mtnFeedController = new MtnFeedController();
