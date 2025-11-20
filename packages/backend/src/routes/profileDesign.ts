import { Router, Request, Response } from 'express';
import UserSettings from '../models/UserSettings';
import { extractPublicProfileData } from '../utils/userSettings';
import { sendErrorResponse, sendSuccessResponse, validateRequired } from '../utils/apiHelpers';
import { oxy } from '../../server';

interface AuthRequest extends Request {
  user?: {
    id: string;
    [key: string]: any;
  };
}

const router = Router();

/**
 * Public Profile Design API
 * Returns only public profile appearance/customization data.
 * No authentication required.
 */

interface PublicProfileDesignResponse {
  oxyUserId: string;
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
    const { userId } = req.params;
    const currentUserId = req.user?.id;
    
    const validationError = validateRequired(userId, 'userId');
    if (validationError) {
      return sendErrorResponse(res, 400, 'Bad Request', validationError);
    }

    const doc = await UserSettings.findOne({ oxyUserId: userId }).lean();
    const profileVisibility = doc?.privacy?.profileVisibility || 'public';
    const isOwnProfile = currentUserId === userId;
    
    // Check privacy settings
    if (!isOwnProfile && (profileVisibility === 'private' || profileVisibility === 'followers_only')) {
      if (!currentUserId) {
        // Not authenticated - return minimal public data but include privacy info so frontend knows it's private
        return sendSuccessResponse(res, 200, {
          oxyUserId: userId,
          appearance: undefined,
          profileHeaderImage: undefined,
          profileCustomization: undefined,
          privacy: {
            profileVisibility: profileVisibility,
          },
        } as PublicProfileDesignResponse);
      }
      
      // Check if current user is following the profile owner
      try {
        const followingRes = await oxy.getUserFollowing(currentUserId);
        const followingList = Array.isArray((followingRes as any)?.following)
          ? (followingRes as any).following
          : (Array.isArray(followingRes) ? followingRes : []);
        const followingIds = followingList.map((u: any) => 
          typeof u === 'string' ? u : (u?.id || u?._id || u?.userId || u?.user?.id || u?.profile?.id || u?.targetId)
        ).filter(Boolean);
        
        const isFollowing = followingIds.includes(userId);
        
        if (!isFollowing) {
          // Not following - return minimal public data but include privacy info
          return sendSuccessResponse(res, 200, {
            oxyUserId: userId,
            appearance: undefined,
            profileHeaderImage: undefined,
            profileCustomization: undefined,
            privacy: {
              profileVisibility: profileVisibility,
            },
          } as PublicProfileDesignResponse);
        }
      } catch (error) {
        console.error('[ProfileDesign] Error checking follow status:', error);
        // On error, return minimal data for privacy but include privacy info
        return sendSuccessResponse(res, 200, {
          oxyUserId: userId,
          appearance: undefined,
          profileHeaderImage: undefined,
          profileCustomization: undefined,
          privacy: {
            profileVisibility: profileVisibility,
          },
        } as PublicProfileDesignResponse);
      }
    }

    // User has access - return full profile design data with privacy info
    const response = extractPublicProfileData(doc, userId) as PublicProfileDesignResponse;
    // Include privacy info in response
    if (doc?.privacy?.profileVisibility) {
      response.privacy = {
        profileVisibility: doc.privacy.profileVisibility,
      };
    }
    return sendSuccessResponse(res, 200, response);
  } catch (error) {
    console.error('[ProfileDesign] Error fetching profile design:', error);
    return sendErrorResponse(
      res,
      500,
      'Internal Server Error',
      'Failed to fetch profile design data'
    );
  }
});

export default router;
