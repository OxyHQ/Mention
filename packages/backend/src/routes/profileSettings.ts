import { Router, Response } from 'express';
import UserSettings from '../models/UserSettings';
import UserBehavior from '../models/UserBehavior';
// Block and Restrict routes removed - frontend should use Oxy services directly
import { AuthRequest, requireAuth } from '../middleware/auth';
import { ensureUserSettings } from '../utils/userSettings';
import { sendErrorResponse, sendSuccessResponse, validateRequired } from '../utils/apiHelpers';
import { getAuthenticatedUserId } from '../utils/auth';
import { logger } from '../utils/logger';

const router = Router();

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
    logger.error('[ProfileSettings] Error fetching my settings:', err);
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

    const validationError = validateRequired(userId, 'userId');
    if (validationError) {
      return sendErrorResponse(res, 400, 'Bad Request', validationError);
    }

    const doc = await ensureUserSettings(userId);
    return sendSuccessResponse(res, 200, doc);
  } catch (err) {
    logger.error('[ProfileSettings] Error fetching user settings:', err);
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
    const { appearance, profileHeaderImage, privacy, profileCustomization, interests, feedSettings } = req.body || {};

    const update: Record<string, any> = {};
    
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
    }
    
    if (typeof profileHeaderImage === 'string') {
      update.profileHeaderImage = profileHeaderImage;
    }
    
    if (profileCustomization) {
      if (typeof profileCustomization.coverPhotoEnabled === 'boolean') {
        update['profileCustomization.coverPhotoEnabled'] = profileCustomization.coverPhotoEnabled;
      }
      if (typeof profileCustomization.minimalistMode === 'boolean') {
        update['profileCustomization.minimalistMode'] = profileCustomization.minimalistMode;
      }
      if (typeof profileCustomization.displayName === 'string') {
        update['profileCustomization.displayName'] = profileCustomization.displayName.trim() || undefined;
      } else if (profileCustomization.displayName === null) {
        update['profileCustomization.displayName'] = undefined;
      }
      if (typeof profileCustomization.coverImage === 'string') {
        update['profileCustomization.coverImage'] = profileCustomization.coverImage.trim() || undefined;
      } else if (profileCustomization.coverImage === null) {
        update['profileCustomization.coverImage'] = undefined;
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

    const doc = await UserSettings.findOneAndUpdate(
      { oxyUserId },
      { $set: update },
      { upsert: true, new: true }
    ).lean();

    return sendSuccessResponse(res, 200, doc);
  } catch (err) {
    logger.error('[ProfileSettings] Error updating settings:', err);
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
    logger.error('[ProfileSettings] Error resetting user behavior:', err);
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to reset personalization data');
  }
});

export default router;
