/**
 * MTN Feed Controller
 *
 * Clean orchestrator replacing the 2186-line monolith.
 * Flow: parse descriptor → resolve FeedAPI → fetch → apply tuner → respond.
 */

import { Request, Response } from 'express';
import { isValidFeedDescriptor, MtnConfig } from '@mention/shared-types';
import type { FeedDescriptor } from '@mention/shared-types';
import { AuthRequest } from '../../types/auth';
import { feedAPIRegistry } from '../feed/FeedAPIRegistry';
import { FeedTuner } from '../feed/FeedTuner';
import { UserPrivacyManager } from '../UserPrivacyManager';
import { trackFeedInteraction } from '../feed/FeedInteractionTracker';
import { logger } from '../../utils/logger';
import { oxy as oxyClient } from '../../../server';
import { extractFollowingIds } from '../../utils/privacyHelpers';

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

      // Load privacy state and following IDs in parallel
      let followingIds: string[] = [];
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
      }

      // Build context
      const context = {
        currentUserId,
        followingIds,
        oxyClient,
      };

      // Resolve feed
      const feedApi = feedAPIRegistry.resolve(descriptor, context);
      if (!feedApi) {
        res.status(400).json({ success: false, error: `Unsupported feed descriptor: ${descriptor}` });
        return;
      }

      // Fetch
      const response = await feedApi.fetch({ cursor, limit }, context);

      // Apply tuner pipeline
      if (response.slices.length > 0) {
        const tuner = FeedTuner.default();
        response.slices = tuner.apply(response.slices, {
          viewerId: currentUserId,
          preferences: {
            // TODO: Load from user settings
            hideReposts: false,
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

      const validEvents = ['impression', 'click', 'like', 'reply', 'repost', 'save'];
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
