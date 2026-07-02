/**
 * Feed Preferences Controller
 *
 * GET/PUT `/feed/preferences` — the viewer's server-persisted feed layout
 * (saved / pinned / ordered feeds). GET merges the stored layout with the
 * `PRESET_FEEDS` defaults (For You + Following pinned when nothing is stored,
 * otherwise missing presets appended unpinned) so a new preset appears without a
 * migration. PUT whitelists `{ key, descriptor, pinned, order }`, validates every
 * descriptor, and ownership-checks any `custom|id` feed before upserting. Owner id
 * always comes from the session (`getRequiredOxyUserId`) — never the body.
 */

import { Response } from 'express';
import mongoose from 'mongoose';
import { PRESET_FEEDS, isValidFeedDescriptor, parseFeedDescriptor } from '@mention/shared-types';
import type { FeedDescriptor, SavedFeed } from '@mention/shared-types';
import { getRequiredOxyUserId, type OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import UserFeedPreference from '../../models/UserFeedPreference';
import CustomFeed from '../../models/CustomFeed';
import { sendErrorResponse, sendSuccessResponse } from '../../utils/apiHelpers';
import { logger } from '../../utils/logger';

/** Hard cap on how many feeds a viewer may save. */
const MAX_SAVED_FEEDS = 200;

/**
 * Merge a viewer's stored feed layout with the preset catalog: presets not yet
 * in the stored list are appended. When nothing is stored the presets keep their
 * `defaultPinned` (For You + Following pinned); once a layout exists, appended
 * presets are unpinned so a new preset never silently steals a tab-bar slot.
 */
function mergeWithPresetDefaults(stored: SavedFeed[], hasStored: boolean): SavedFeed[] {
  const storedDescriptors = new Set(stored.map((feed) => feed.descriptor));
  const merged: SavedFeed[] = [...stored];
  for (const preset of PRESET_FEEDS) {
    if (storedDescriptors.has(preset.descriptor)) continue;
    merged.push({
      key: preset.id,
      descriptor: preset.descriptor,
      pinned: hasStored ? false : preset.defaultPinned,
      order: merged.length,
    });
  }
  return merged;
}

type CustomFeedAccess = 'ok' | 'invalid' | 'forbidden';

/**
 * Whether the viewer may save a `custom|id` feed: it must exist and be either
 * owned by the viewer or public.
 */
async function resolveCustomFeedAccess(feedId: string | undefined, userId: string): Promise<CustomFeedAccess> {
  if (!feedId || !mongoose.Types.ObjectId.isValid(feedId)) return 'invalid';
  const feed = await CustomFeed.findById(feedId).lean();
  if (!feed) return 'invalid';
  if (feed.ownerOxyUserId === userId || feed.isPublic === true) return 'ok';
  return 'forbidden';
}

class FeedPreferencesController {
  /** GET /feed/preferences — the viewer's layout, merged with preset defaults. */
  async get(req: AuthRequest, res: Response): Promise<Response> {
    if (!req.user?.id) {
      return sendErrorResponse(res, 401, 'Unauthorized', 'Authentication required');
    }
    const userId = getRequiredOxyUserId(req);
    try {
      const doc = await UserFeedPreference.findOne({ oxyUserId: userId }).lean();
      const stored: SavedFeed[] = doc?.savedFeeds ?? [];
      return sendSuccessResponse(res, 200, { savedFeeds: mergeWithPresetDefaults(stored, Boolean(doc)) });
    } catch (error) {
      logger.error('[FeedPreferences] Failed to load preferences', { userId, error });
      return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to load feed preferences');
    }
  }

  /** PUT /feed/preferences — replace the viewer's layout (validated + whitelisted). */
  async update(req: AuthRequest, res: Response): Promise<Response> {
    if (!req.user?.id) {
      return sendErrorResponse(res, 401, 'Unauthorized', 'Authentication required');
    }
    const userId = getRequiredOxyUserId(req);
    try {
      const raw = (req.body as { savedFeeds?: unknown } | undefined)?.savedFeeds;
      if (!Array.isArray(raw)) {
        return sendErrorResponse(res, 400, 'Bad Request', 'savedFeeds must be an array');
      }
      if (raw.length > MAX_SAVED_FEEDS) {
        return sendErrorResponse(res, 400, 'Bad Request', `You can save at most ${MAX_SAVED_FEEDS} feeds`);
      }

      const savedFeeds: SavedFeed[] = [];
      for (let i = 0; i < raw.length; i++) {
        const entry = (raw[i] ?? {}) as Record<string, unknown>;
        const key = typeof entry.key === 'string' ? entry.key : '';
        const descriptor = typeof entry.descriptor === 'string' ? entry.descriptor : '';

        if (!key || !descriptor || !isValidFeedDescriptor(descriptor)) {
          return sendErrorResponse(res, 400, 'Bad Request', `Invalid feed descriptor: ${descriptor || '(missing)'}`);
        }

        const { source, params } = parseFeedDescriptor(descriptor as FeedDescriptor);
        if (source === 'custom') {
          const access = await resolveCustomFeedAccess(params[0], userId);
          if (access === 'invalid') {
            return sendErrorResponse(res, 400, 'Bad Request', 'Unknown custom feed');
          }
          if (access === 'forbidden') {
            return sendErrorResponse(res, 403, 'Forbidden', 'You cannot save this custom feed');
          }
        }

        savedFeeds.push({
          key,
          descriptor: descriptor as FeedDescriptor,
          pinned: entry.pinned === true,
          order: typeof entry.order === 'number' ? entry.order : i,
        });
      }

      const updated = await UserFeedPreference.findOneAndUpdate(
        { oxyUserId: userId },
        { $set: { savedFeeds } },
        { new: true, upsert: true },
      ).lean();

      return sendSuccessResponse(
        res,
        200,
        { savedFeeds: updated?.savedFeeds ?? savedFeeds },
        'Feed preferences updated',
      );
    } catch (error) {
      logger.error('[FeedPreferences] Failed to update preferences', { userId, error });
      return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to update feed preferences');
    }
  }
}

export const feedPreferencesController = new FeedPreferencesController();
