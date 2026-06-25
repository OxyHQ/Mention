/**
 * MTN Feed Controller
 *
 * Clean orchestrator replacing the 2186-line monolith.
 * Flow: parse descriptor → resolve FeedAPI → fetch → apply tuner → respond.
 */

import { Request, Response } from 'express';
import { isValidFeedDescriptor, MtnConfig } from '@mention/shared-types';
import type { FeedDescriptor } from '@mention/shared-types';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { feedAPIRegistry } from '../feed/FeedAPIRegistry';
import { FeedTuner } from '../feed/FeedTuner';
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
 * Merge member oxyUserIds from lists the user SUBSCRIBES to (a 'list' EntityFollow)
 * into the given followingIds array, deduplicating in-place.
 *
 * Following a list is a subscription, NOT a follow: this only changes which posts
 * the viewer SEES in their main feed (the author candidate set). It does not create
 * any follow relationship and does not alter follower/following counts.
 *
 * Excludes the viewer's own id and any id already present in followingIds.
 */
async function mergeSubscribedListMemberIds(
  localUserId: string,
  followingIds: string[],
): Promise<void> {
  const memberIds = await listSubscriptionService.getSubscribedListMemberIds(localUserId);
  if (memberIds.length === 0) return;

  const existing = new Set(followingIds);
  existing.add(localUserId);
  for (const id of memberIds) {
    if (!existing.has(id)) {
      followingIds.push(id);
      existing.add(id);
    }
  }
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
          await mergeSubscribedListMemberIds(currentUserId, followingIds);
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
        userBehavior,
        oxyClient,
        showSensitiveContent,
        viewerRegion,
      };

      // Resolve feed
      const feedApi = feedAPIRegistry.resolve(descriptor, context);
      if (!feedApi) {
        res.status(400).json({ success: false, error: `Unsupported feed descriptor: ${descriptor}` });
        return;
      }

      // Fetch
      const response = await feedApi.fetch({ cursor, limit }, context);

      // Filter out posts from blocked/muted users
      if (privacyState && privacyState.excludedUserIds.size > 0) {
        response.items = response.items.filter((item: any) => {
          const authorId = item.author?.id || item.oxyUserId;
          return !authorId || !privacyState.excludedUserIds.has(authorId);
        });
        response.slices = response.slices.filter((slice: any) => {
          const anchorAuthor = slice.items?.[0]?.author?.id || slice.items?.[0]?.oxyUserId;
          return !anchorAuthor || !privacyState.excludedUserIds.has(anchorAuthor);
        });
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
          await mergeSubscribedListMemberIds(currentUserId, followingIds);
        } catch (error) {
          logger.warn('[MtnFeedController] Failed to load subscribed-list members', error);
        }
      }

      const context = {
        currentUserId,
        followingIds,
        oxyClient,
      };

      const feedApi = feedAPIRegistry.resolve(descriptor, context);
      if (!feedApi) {
        res.status(400).json({ success: false, error: `Unsupported feed descriptor: ${descriptor}` });
        return;
      }

      const latest = await feedApi.peekLatest(context);
      res.json({
        success: true,
        data: latest ? { uri: `mtn://${latest.user?.id}/mtn.social.post/${latest.id}`, post: latest } : null,
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
