import { Router, Response } from 'express';
import UserSettings from '../models/UserSettings';
import Post from '../models/Post';
import { extractPublicProfileData } from '../utils/userSettings';
import { sendErrorResponse, sendSuccessResponse, validateRequired } from '../utils/apiHelpers';
import { checkFollowAccess, requiresAccessCheck, ProfileVisibility } from '../utils/privacyHelpers';
import { AuthRequest } from '../types/auth';
import { PostVisibility } from '@mention/shared-types';
import { logger } from '../utils/logger';

const router = Router();

/**
 * Public Profile Design API
 * Returns only public profile appearance/customization data.
 * No authentication required.
 */

interface PublicProfileDesignResponse {
  oxyUserId: string;
  postsCount?: number;
  appearance?: {
    primaryColor?: string;
  };
  profileHeaderImage?: string;
  profileCustomization?: {
    coverPhotoEnabled: boolean;
    minimalistMode: boolean;
    displayName?: string;
    coverImage?: string;
  };
  privacy?: {
    profileVisibility?: 'public' | 'private' | 'followers_only';
  };
}

/**
 * GET /api/profile/design/:userId
 * Get public profile design data for a user
 * Respects privacy settings - only returns data if profile is public or viewer has access
 */
router.get('/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.params.userId as string;
    const currentUserId = req.user?.id;
    
    const validationError = validateRequired(userId, 'userId');
    if (validationError) {
      return sendErrorResponse(res, 400, 'Bad Request', validationError);
    }

    const doc = await UserSettings.findOne({ oxyUserId: userId }).lean();
    const profileVisibility = doc?.privacy?.profileVisibility || ProfileVisibility.PUBLIC;
    const isOwnProfile = currentUserId === userId;
    
    // Build minimal response helper
    const buildMinimalResponse = (): PublicProfileDesignResponse => ({
      oxyUserId: userId,
      appearance: undefined,
      profileHeaderImage: undefined,
      profileCustomization: undefined,
      privacy: {
        profileVisibility: profileVisibility,
      },
    });
    
    // Check privacy settings
    if (!isOwnProfile && requiresAccessCheck(profileVisibility)) {
      if (!currentUserId) {
        // Not authenticated - return minimal public data but include privacy info so frontend knows it's private
        return sendSuccessResponse(res, 200, buildMinimalResponse());
      }
      
      // Check if current user is following the profile owner
      const hasAccess = await checkFollowAccess(currentUserId, userId);
      if (!hasAccess) {
        // No access - return minimal public data but include privacy info
        return sendSuccessResponse(res, 200, buildMinimalResponse());
      }
    }

    // User has access - return full profile design data with privacy info
    const response = extractPublicProfileData(doc, userId) as PublicProfileDesignResponse;
    
    // Calculate posts count
    // Count only top-level posts (not replies) that are public
    // Match the same query pattern used in getUserProfileFeed
    const postsCount = await Post.countDocuments({
      oxyUserId: userId,
      visibility: PostVisibility.PUBLIC,
      parentPostId: null // In MongoDB, this matches null OR field doesn't exist
    });
    
    response.postsCount = postsCount;

    // Include privacy info in response
    if (doc?.privacy?.profileVisibility) {
      response.privacy = {
        profileVisibility: doc.privacy.profileVisibility,
      };
    }
    return sendSuccessResponse(res, 200, response);
  } catch (error) {
    logger.error('[ProfileDesign] Error fetching profile design:', error);
    return sendErrorResponse(
      res,
      500,
      'Internal Server Error',
      'Failed to fetch profile design data'
    );
  }
});

export default router;
