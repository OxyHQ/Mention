import { Router, Response } from 'express';
import UserSettings from '../models/UserSettings';
import UserBehavior from '../models/UserBehavior';
import Block from '../models/Block';
import Restrict from '../models/Restrict';
import { AuthRequest, requireAuth } from '../middleware/auth';
import { ensureUserSettings } from '../utils/userSettings';
import { sendErrorResponse, sendSuccessResponse, validateRequired } from '../utils/apiHelpers';
import { getAuthenticatedUserId } from '../utils/auth';

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
    console.error('[ProfileSettings] Error fetching my settings:', err);
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to fetch settings');
  }
});

/**
 * GET /api/profile/settings/:userId
 * Get settings by oxy user id
 */
router.get('/settings/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const { userId } = req.params;
    
    const validationError = validateRequired(userId, 'userId');
    if (validationError) {
      return sendErrorResponse(res, 400, 'Bad Request', validationError);
    }

    const doc = await ensureUserSettings(userId);
    return sendSuccessResponse(res, 200, doc);
  } catch (err) {
    console.error('[ProfileSettings] Error fetching user settings:', err);
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
    const { appearance, profileHeaderImage, privacy, profileCustomization, interests } = req.body || {};

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
        const validTags = interests.tags.filter(tag => typeof tag === 'string');
        update['interests.tags'] = validTags;
      }
    }

    const doc = await UserSettings.findOneAndUpdate(
      { oxyUserId },
      { $set: update },
      { upsert: true, new: true }
    ).lean();

    return sendSuccessResponse(res, 200, doc);
  } catch (err) {
    console.error('[ProfileSettings] Error updating settings:', err);
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
    console.error('[ProfileSettings] Error resetting user behavior:', err);
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to reset personalization data');
  }
});

/**
 * Block management endpoints
 */

router.get('/blocks', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const blocks = await Block.find({ userId: oxyUserId })
      .sort({ createdAt: -1 })
      .lean();

    return sendSuccessResponse(res, 200, {
      blockedUsers: blocks.map(b => b.blockedId),
    });
  } catch (err) {
    console.error('[ProfileSettings] Error fetching blocked users:', err);
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to fetch blocked users');
  }
});

router.post('/blocks', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const { blockedId } = req.body;
    
    const validationError = validateRequired(blockedId, 'blockedId');
    if (validationError || typeof blockedId !== 'string') {
      return sendErrorResponse(res, 400, 'Bad Request', 'Missing or invalid blockedId');
    }

    if (oxyUserId === blockedId) {
      return sendErrorResponse(res, 400, 'Bad Request', 'Cannot block yourself');
    }

    const existing = await Block.findOne({ userId: oxyUserId, blockedId });
    if (existing) {
      return sendSuccessResponse(res, 200, { success: true }, 'User already blocked');
    }

    await Block.create({ userId: oxyUserId, blockedId });
    return sendSuccessResponse(res, 201, { success: true }, 'User blocked successfully');
  } catch (err: any) {
    console.error('[ProfileSettings] Error blocking user:', err);
    if (err.code === 11000) {
      return sendSuccessResponse(res, 200, { success: true }, 'User already blocked');
    }
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to block user');
  }
});

router.delete('/blocks/:blockedId', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const { blockedId } = req.params;
    
    const validationError = validateRequired(blockedId, 'blockedId');
    if (validationError) {
      return sendErrorResponse(res, 400, 'Bad Request', validationError);
    }

    const result = await Block.findOneAndDelete({ userId: oxyUserId, blockedId });

    if (!result) {
      return sendErrorResponse(res, 404, 'Not Found', 'Block not found');
    }

    return sendSuccessResponse(res, 200, { success: true }, 'User unblocked successfully');
  } catch (err) {
    console.error('[ProfileSettings] Error unblocking user:', err);
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to unblock user');
  }
});

/**
 * Restricted users management endpoints
 */

router.get('/restricts', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const restricts = await Restrict.find({ userId: oxyUserId })
      .sort({ createdAt: -1 })
      .lean();

    return sendSuccessResponse(res, 200, {
      restrictedUsers: restricts.map(r => r.restrictedId),
    });
  } catch (err) {
    console.error('[ProfileSettings] Error fetching restricted users:', err);
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to fetch restricted users');
  }
});

router.post('/restricts', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const { restrictedId } = req.body;
    
    const validationError = validateRequired(restrictedId, 'restrictedId');
    if (validationError || typeof restrictedId !== 'string') {
      return sendErrorResponse(res, 400, 'Bad Request', 'Missing or invalid restrictedId');
    }

    if (oxyUserId === restrictedId) {
      return sendErrorResponse(res, 400, 'Bad Request', 'Cannot restrict yourself');
    }

    const existing = await Restrict.findOne({ userId: oxyUserId, restrictedId });
    if (existing) {
      return sendSuccessResponse(res, 200, { success: true }, 'User already restricted');
    }

    await Restrict.create({ userId: oxyUserId, restrictedId });
    return sendSuccessResponse(res, 201, { success: true }, 'User restricted successfully');
  } catch (err: any) {
    console.error('[ProfileSettings] Error restricting user:', err);
    if (err.code === 11000) {
      return sendSuccessResponse(res, 200, { success: true }, 'User already restricted');
    }
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to restrict user');
  }
});

router.delete('/restricts/:restrictedId', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const { restrictedId } = req.params;
    
    const validationError = validateRequired(restrictedId, 'restrictedId');
    if (validationError) {
      return sendErrorResponse(res, 400, 'Bad Request', validationError);
    }

    const result = await Restrict.findOneAndDelete({ userId: oxyUserId, restrictedId });

    if (!result) {
      return sendErrorResponse(res, 404, 'Not Found', 'Restrict not found');
    }

    return sendSuccessResponse(res, 200, { success: true }, 'User unrestricted successfully');
  } catch (err) {
    console.error('[ProfileSettings] Error unrestricting user:', err);
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to unrestrict user');
  }
});

export default router;
