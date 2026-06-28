import { Router, Response } from 'express';
import UserSettings, { type ProfileMedia } from '../models/UserSettings';
import UserBehavior from '../models/UserBehavior';
import Post from '../models/Post';
import Bookmark from '../models/Bookmark';
import Like from '../models/Like';
// Block and Restrict routes removed - frontend should use Oxy services directly
import { requireOxyAuth as requireAuth, type OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { buildSettingsResponseForViewer, ensureUserSettings } from '../utils/userSettings';
import { ensureProfileMediaPublic } from '../utils/oxyHelpers';
import { sendErrorResponse, sendSuccessResponse, validateRequired } from '../utils/apiHelpers';
import { getRequiredOxyUserId as getAuthenticatedUserId } from '@oxyhq/core/server';
import { type TrackSummary, type PodcastSummary } from '@syra.fm/sdk';
import { syraClient } from '../utils/syraPodcast';
import { logger } from '../utils/logger';

const router = Router();

/**
 * The public Syra preview is a fixed 30-second clip. A profile song's start
 * offset is clamped so the whole window stays inside the track.
 */
const PROFILE_MEDIA_PREVIEW_WINDOW_SEC = 30;

/**
 * Profile Settings API
 * All routes require authentication
 */

// Apply auth middleware to all routes
router.use(requireAuth);

/**
 * GET /api/profile/settings/me
 * Get current user's settings
 */
router.get('/settings/me', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const doc = await ensureUserSettings(oxyUserId);
    return sendSuccessResponse(res, 200, doc);
  } catch (err) {
    logger.error('[ProfileSettings] Error fetching my settings:', { userId: req.user?.id, error: err });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to fetch settings');
  }
});

/**
 * GET /api/profile/settings/:userId
 * Get settings by oxy user id
 */
router.get('/settings/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.params.userId as string;
    const viewerUserId = getAuthenticatedUserId(req);

    const validationError = validateRequired(userId, 'userId');
    if (validationError) {
      return sendErrorResponse(res, 400, 'Bad Request', validationError);
    }

    const doc = userId === viewerUserId
      ? await ensureUserSettings(userId)
      : await UserSettings.findOne({ oxyUserId: userId }).lean().exec();
    return sendSuccessResponse(res, 200, buildSettingsResponseForViewer(doc, userId, viewerUserId));
  } catch (err) {
    logger.error('[ProfileSettings] Error fetching user settings:', { userId: req.user?.id, targetUserId: req.params.userId, error: err });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to fetch settings');
  }
});

/**
 * PUT /api/profile/settings
 * Update current user's settings
 */
router.put('/settings', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const { appearance, profileHeaderImage, privacy, profileCustomization, profileMedia, interests, feedSettings, notificationPreferences } = req.body || {};

    const update: Record<string, any> = {};
    const unset: Record<string, ''> = {};
    // The Oxy file id newly set as the profile banner (if any). Captured here so
    // we can promote it to public AFTER the settings persist — profile banners
    // are public-facing media that an anonymous <img> must be able to load.
    let newBannerFileId: string | undefined;

    if (appearance) {
      update['appearance'] = {};
      if (appearance.themeMode && ['light', 'dark', 'system'].includes(appearance.themeMode)) {
        update.appearance.themeMode = appearance.themeMode;
      }
      if (typeof appearance.primaryColor === 'string' && appearance.primaryColor.trim()) {
        update.appearance.primaryColor = appearance.primaryColor.trim();
      } else if (appearance.primaryColor === null) {
        update.appearance.primaryColor = undefined;
      }
      if (['default', 'more', 'muchMore', 'all'].includes(appearance.postTextExpand)) {
        update.appearance.postTextExpand = appearance.postTextExpand;
      }
    }
    
    if (typeof profileHeaderImage === 'string') {
      const trimmedProfileHeaderImage = profileHeaderImage.trim();
      if (trimmedProfileHeaderImage) {
        update.profileHeaderImage = trimmedProfileHeaderImage;
        newBannerFileId = trimmedProfileHeaderImage;
      } else {
        unset.profileHeaderImage = '';
      }
    } else if (profileHeaderImage === null) {
      unset.profileHeaderImage = '';
    }
    
    if (profileCustomization) {
      if (typeof profileCustomization.coverPhotoEnabled === 'boolean') {
        update['profileCustomization.coverPhotoEnabled'] = profileCustomization.coverPhotoEnabled;
      }
      if (typeof profileCustomization.minimalistMode === 'boolean') {
        update['profileCustomization.minimalistMode'] = profileCustomization.minimalistMode;
      }
    }

    // Profile media: an Instagram-style pinned Syra song OR podcast show
    // (mutually exclusive — one field, one value, so setting either type
    // automatically replaces the other). The client sends only an untrusted
    // reference: `{ type:'song', syraTrackId, startSec }`, `{ type:'podcast',
    // syraPodcastId }`, or `null` to clear. We NEVER persist client-supplied
    // metadata: the canonical title/artist/artwork and preview/show URL are
    // resolved server-side from the Syra catalog via @syra.fm/sdk; a song is
    // additionally rejected unless it exposes a public preview.
    if (profileMedia === null) {
      unset['profileCustomization.profileMedia'] = '';
    } else if (profileMedia && typeof profileMedia === 'object' && !Array.isArray(profileMedia)) {
      if (profileMedia.type === 'song') {
        const syraTrackId = typeof profileMedia.syraTrackId === 'string' ? profileMedia.syraTrackId.trim() : '';
        if (!syraTrackId) {
          return sendErrorResponse(res, 400, 'Bad Request', 'profileMedia.syraTrackId is required');
        }

        const requestedStartSec = typeof profileMedia.startSec === 'number' && Number.isFinite(profileMedia.startSec)
          ? Math.max(0, Math.trunc(profileMedia.startSec))
          : 0;

        let track: TrackSummary;
        try {
          track = await syraClient.getTrack(syraTrackId);
        } catch (err) {
          logger.warn('[ProfileSettings] Failed to resolve Syra track for profile media:', { userId: oxyUserId, syraTrackId, error: err });
          return sendErrorResponse(res, 400, 'Bad Request', 'Unable to resolve the selected song');
        }

        if (track.previewAvailable !== true) {
          return sendErrorResponse(res, 400, 'Bad Request', 'The selected song does not have a public preview');
        }

        // Clamp the start offset to [0, max(0, duration - 30)] so the full 30s
        // preview window always stays inside the track.
        const maxStartSec = Math.max(0, Math.trunc(track.duration) - PROFILE_MEDIA_PREVIEW_WINDOW_SEC);
        const clampedStartSec = Math.min(requestedStartSec, maxStartSec);

        update['profileCustomization.profileMedia'] = {
          type: 'song',
          syraTrackId,
          title: track.title,
          artist: track.artistName,
          artworkUrl: syraClient.artworkUrl(track),
          previewUrl: syraClient.previewUrl(syraTrackId, clampedStartSec),
          startSec: clampedStartSec,
          durationSec: track.duration,
        } satisfies ProfileMedia;
      } else if (profileMedia.type === 'podcast') {
        const syraPodcastId = typeof profileMedia.syraPodcastId === 'string' ? profileMedia.syraPodcastId.trim() : '';
        if (!syraPodcastId) {
          return sendErrorResponse(res, 400, 'Bad Request', 'profileMedia.syraPodcastId is required');
        }

        let show: PodcastSummary;
        try {
          show = await syraClient.getPodcast(syraPodcastId);
        } catch (err) {
          logger.warn('[ProfileSettings] Failed to resolve Syra podcast for profile media:', { userId: oxyUserId, syraPodcastId, error: err });
          return sendErrorResponse(res, 400, 'Bad Request', 'Unable to resolve the selected podcast');
        }

        update['profileCustomization.profileMedia'] = {
          type: 'podcast',
          syraPodcastId,
          title: show.title,
          author: show.author,
          artworkUrl: syraClient.podcastArtworkUrl(show),
          showUrl: syraClient.podcastUrl(syraPodcastId),
        } satisfies ProfileMedia;
      } else {
        return sendErrorResponse(res, 400, 'Bad Request', 'profileMedia.type must be "song" or "podcast"');
      }
    }

    if (privacy) {
      const privacyFields = [
        'profileVisibility',
        'showContactInfo',
        'allowTags',
        'allowMentions',
        'showOnlineStatus',
        'hideLikeCounts',
        'hideShareCounts',
        'hideReplyCounts',
        'hideSaveCounts',
        'showSensitiveContent',
      ] as const;
      
      privacyFields.forEach(field => {
        if (typeof privacy[field] === 'boolean') {
          update[`privacy.${field}`] = privacy[field];
        }
      });
      
      if (privacy.profileVisibility && ['public', 'private', 'followers_only'].includes(privacy.profileVisibility)) {
        update['privacy.profileVisibility'] = privacy.profileVisibility;
      }
      if (Array.isArray(privacy.hiddenWords)) {
        update['privacy.hiddenWords'] = privacy.hiddenWords;
      }
      if (Array.isArray(privacy.restrictedUsers)) {
        update['privacy.restrictedUsers'] = privacy.restrictedUsers;
      }
    }

    if (interests) {
      if (interests.tags === null || interests.tags === undefined) {
        // Allow clearing interests
        update['interests.tags'] = [];
      } else if (Array.isArray(interests.tags)) {
        // Validate that all tags are strings
        const validTags = interests.tags.filter((tag: any) => typeof tag === 'string');
        update['interests.tags'] = validTags;
      }
    }

    if (feedSettings) {
      // Validate and set diversity settings
      if (feedSettings.diversity) {
        if (typeof feedSettings.diversity.enabled === 'boolean') {
          update['feedSettings.diversity.enabled'] = feedSettings.diversity.enabled;
        }
        if (typeof feedSettings.diversity.sameAuthorPenalty === 'number') {
          const penalty = Math.max(0.5, Math.min(1.0, feedSettings.diversity.sameAuthorPenalty));
          update['feedSettings.diversity.sameAuthorPenalty'] = penalty;
        }
        if (typeof feedSettings.diversity.sameTopicPenalty === 'number') {
          const penalty = Math.max(0.5, Math.min(1.0, feedSettings.diversity.sameTopicPenalty));
          update['feedSettings.diversity.sameTopicPenalty'] = penalty;
        }
        if (typeof feedSettings.diversity.maxConsecutiveSameAuthor === 'number') {
          const maxConsecutive = Math.max(1, Math.min(10, Math.round(feedSettings.diversity.maxConsecutiveSameAuthor)));
          update['feedSettings.diversity.maxConsecutiveSameAuthor'] = maxConsecutive;
        } else if (feedSettings.diversity.maxConsecutiveSameAuthor === null) {
          update['feedSettings.diversity.maxConsecutiveSameAuthor'] = undefined;
        }
      }

      // Validate and set recency settings
      if (feedSettings.recency) {
        if (typeof feedSettings.recency.halfLifeHours === 'number') {
          const halfLife = Math.max(6, Math.min(72, feedSettings.recency.halfLifeHours));
          update['feedSettings.recency.halfLifeHours'] = halfLife;
        }
        if (typeof feedSettings.recency.maxAgeHours === 'number') {
          const maxAge = Math.max(24, Math.min(336, feedSettings.recency.maxAgeHours));
          update['feedSettings.recency.maxAgeHours'] = maxAge;
        }
      }

      // Validate and set quality settings
      if (feedSettings.quality) {
        if (typeof feedSettings.quality.boostHighQuality === 'boolean') {
          update['feedSettings.quality.boostHighQuality'] = feedSettings.quality.boostHighQuality;
        }
        if (typeof feedSettings.quality.minEngagementRate === 'number') {
          const minRate = Math.max(0, Math.min(1, feedSettings.quality.minEngagementRate));
          update['feedSettings.quality.minEngagementRate'] = minRate;
        } else if (feedSettings.quality.minEngagementRate === null) {
          update['feedSettings.quality.minEngagementRate'] = undefined;
        }
      }
    }

    if (notificationPreferences) {
      const boolFields = [
        'pushEnabled',
        'emailEnabled',
        'likes',
        'boosts',
        'follows',
        'mentions',
        'replies',
        'quotes',
      ] as const;

      boolFields.forEach(field => {
        if (typeof notificationPreferences[field] === 'boolean') {
          update[`notificationPreferences.${field}`] = notificationPreferences[field];
        }
      });
    }

    const operation: Record<string, Record<string, any>> = {};
    if (Object.keys(update).length > 0) {
      operation.$set = update;
    }
    if (Object.keys(unset).length > 0) {
      operation.$unset = unset;
    }

    const doc = Object.keys(operation).length > 0
      ? await UserSettings.findOneAndUpdate(
        { oxyUserId },
        operation,
        { upsert: true, new: true }
      ).lean()
      : await ensureUserSettings(oxyUserId);

    // Profile banners are public-facing media: an anonymous <img> on a profile
    // page can't send a bearer token, so a private Oxy asset is denied and the
    // banner never renders. Promote the newly set banner asset to public using
    // the owner's own session token (Oxy's visibility route requires it). This
    // mirrors how Oxy auto-publishes avatars on PUT /users/me; the banner is a
    // Mention-only field, so Mention owns this promotion. Best-effort: it never
    // throws and never blocks the settings update.
    if (newBannerFileId) {
      await ensureProfileMediaPublic(req.accessToken, newBannerFileId);
    }

    return sendSuccessResponse(res, 200, doc);
  } catch (err) {
    logger.error('[ProfileSettings] Error updating settings:', { userId: req.user?.id, error: err });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to update settings');
  }
});

/**
 * DELETE /api/profile/settings/behavior
 * Reset user behavior/preferences
 */
router.delete('/settings/behavior', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const result = await UserBehavior.findOneAndDelete({ oxyUserId });

    return sendSuccessResponse(
      res,
      200,
      { success: true },
      result ? 'Personalization data reset successfully' : 'No personalization data to reset'
    );
  } catch (err) {
    logger.error('[ProfileSettings] Error resetting user behavior:', { userId: req.user?.id, error: err });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to reset personalization data');
  }
});

/**
 * POST /api/profile/export
 * Export user data as JSON
 */
router.post('/export', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);

    // Collect user's data in parallel
    const [posts, bookmarks, likes, settings] = await Promise.all([
      Post.find({ oxyUserId }).sort({ createdAt: -1 }).lean(),
      Bookmark.find({ userId: oxyUserId }).sort({ createdAt: -1 }).lean(),
      Like.find({ userId: oxyUserId }).sort({ createdAt: -1 }).lean(),
      UserSettings.findOne({ oxyUserId }).lean(),
    ]);

    const exportData = {
      exportedAt: new Date().toISOString(),
      userId: oxyUserId,
      posts,
      bookmarks,
      likes,
      settings,
    };

    return sendSuccessResponse(res, 200, exportData, 'Data export completed successfully');
  } catch (err) {
    logger.error('[ProfileSettings] Error exporting user data:', { userId: req.user?.id, error: err });
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to export user data');
  }
});

export default router;
