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
import { feedEngine } from '../feed/engine/FeedEngine';
import { CustomFeed } from '../feed/feeds/CustomFeed';
import { FeedGeneratorFeed } from '../feed/feeds/FeedGeneratorFeed';
import type { FeedAPI } from '../feed/FeedAPI';
import { FeedTuner } from '../feed/FeedTuner';
import { FeedResponseBuilder } from '../../utils/FeedResponseBuilder';
import { UserPrivacyManager } from '../UserPrivacyManager';
import { trackFeedInteraction } from '../feed/FeedInteractionTracker';
import { logger } from '../../utils/logger';
import { oxy as oxyClient } from '../../../server';
import { extractFollowingIds } from '../../utils/privacyHelpers';
import FederatedFollow from '../../models/FederatedFollow';
import FederatedActor from '../../models/FederatedActor';
import { MuteWord } from '../../models/MuteWord';
import UserSettings from '../../models/UserSettings';
import { listSubscriptionService } from '../../services/ListSubscriptionService';
import { userPreferenceService } from '../../services/UserPreferenceService';
import type { IUserBehavior } from '../../models/UserBehavior';
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

/**
 * Load the viewer's "show sensitive/NSFW content" preference from their
 * UserSettings. Returns `false` (safe-for-work — today's behavior) for an
 * anonymous viewer, a viewer with no settings doc yet, or on any load failure:
 * a settings lookup error must never relax the sensitivity gate. Only an
 * explicit stored `true` opts the viewer in.
 */
async function loadShowSensitiveContent(userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  try {
    const doc = await UserSettings.findOne(
      { oxyUserId: userId },
      { 'privacy.showSensitiveContent': 1 },
    ).lean();
    return doc?.privacy?.showSensitiveContent === true;
  } catch (error) {
    logger.warn('[MtnFeedController] Failed to load showSensitiveContent preference', error);
    return false;
  }
}

/**
 * Merge oxyUserIds from accepted federated (ActivityPub) follows into the
 * given followingIds array, deduplicating in-place.
 */
async function mergeFederatedFollowIds(
  localUserId: string,
  followingIds: string[],
): Promise<void> {
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
 * Resolve the descriptors NOT owned by the engine in Phase 1 to their legacy
 * FeedAPI implementation: `custom|id` (the stored CustomFeed, migrated to a
 * definition in Phase 3) and `feedgen|uri` (external generator stub). Returns
 * `null` for anything else.
 */
function resolveLegacyFeed(descriptor: FeedDescriptor): FeedAPI | null {
  const { source, params } = parseFeedDescriptor(descriptor);
  if (source === 'custom') return new CustomFeed(params[0]);
  if (source === 'feedgen') return new FeedGeneratorFeed(params[0]);
  return null;
}

class MtnFeedController {
  /**
   * GET /api/feed?descriptor=for_you&cursor=...&limit=30
   *
   * Unified feed endpoint. Resolves any feed descriptor.
   */
  async getFeed(req: AuthRequest, res: Response): Promise<void> {
    try {
      const descriptorParam = req.query.descriptor as string;
      if (!descriptorParam || !isValidFeedDescriptor(descriptorParam)) {
        res.status(400).json({ success: false, error: 'Invalid or missing feed descriptor' });
        return;
      }

      const descriptor = descriptorParam as FeedDescriptor;
      const cursor = req.query.cursor as string | undefined;
      const limit = Math.min(
        Math.max(parseInt(req.query.limit as string, 10) || MtnConfig.feed.defaultLimit, 1),
        MtnConfig.feed.maxLimit
      );

      const currentUserId = req.user?.id;

      // Load privacy state, following IDs, and the viewer's learned behavior in
      // parallel. `userBehavior` feeds personalized candidate generation
      // (For You multi-source) and ranking; it soft-fails to undefined.
      let followingIds: string[] = [];
      let subscribedListMemberIds: string[] = [];
      let userBehavior: IUserBehavior | undefined;
      // The viewer's sensitive-content opt-in. Anonymous → false; loaded
      // soft-failing to false below so a settings error never relaxes the gate.
      let showSensitiveContent = false;
      const privacyState = currentUserId
        ? await UserPrivacyManager.loadPrivacyState(currentUserId)
        : null;

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

        try {
          userBehavior = (await userPreferenceService.getUserBehavior(currentUserId)) ?? undefined;
        } catch (error) {
          logger.warn('[MtnFeedController] Failed to load user behavior', error);
        }

        showSensitiveContent = await loadShowSensitiveContent(currentUserId);
      }

      // Resolve the viewer's DOMINANT learned region once (best-effort; usually
      // undefined because post region is sparse). Threaded into context so the
      // For You region candidate source and the Explore relevance boost can use
      // it. A missing region is a strict no-op downstream.
      const viewerRegion = userPreferenceService.getTopRegion(userBehavior);

      // Build context
      const context = {
        currentUserId,
        followingIds,
        subscribedListMemberIds,
        userBehavior,
        oxyClient,
        showSensitiveContent,
        viewerRegion,
      };

      // Resolve the descriptor to a composable feed DEFINITION and run it through
      // the engine. `custom|id` (legacy CustomFeed) and `feedgen|uri` (external
      // stub) are not engine-owned in Phase 1 and fall back to the FeedAPI
      // registry.
      const definition = resolveDefinition(descriptor);
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
        response.items = response.items.filter((item: any) => {
          const authorId = item.author?.id || item.oxyUserId;
          return !authorId || !privacyState.excludedUserIds.has(authorId);
        });
        response.slices = response.slices.filter((slice: any) => {
          const anchorPost = slice.items?.[0]?.post ?? slice.items?.[0];
          const anchorAuthor = anchorPost?.author?.id || anchorPost?.oxyUserId;
          return !anchorAuthor || !privacyState.excludedUserIds.has(anchorAuthor);
        });
        syncFlattenedItemsWithSlices(response);
      }

      // Apply tuner pipeline
      if (response.slices.length > 0) {
        const muteWords = await loadMuteWordsForUser(currentUserId);
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
      const descriptorParam = req.query.descriptor as string;
      if (!descriptorParam || !isValidFeedDescriptor(descriptorParam)) {
        res.status(400).json({ success: false, error: 'Invalid or missing feed descriptor' });
        return;
      }

      const descriptor = descriptorParam as FeedDescriptor;
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

      const context = {
        currentUserId,
        followingIds,
        subscribedListMemberIds,
        oxyClient,
      };

      const definition = resolveDefinition(descriptor);
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
      if (!userId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const { feedDescriptor, postUri, event, durationMs } = req.body;
      if (!feedDescriptor || !postUri || !event) {
        res.status(400).json({ success: false, error: 'Missing required fields' });
        return;
      }

      const validEvents = ['impression', 'click', 'like', 'reply', 'boost', 'save'];
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
}

export const mtnFeedController = new MtnFeedController();
