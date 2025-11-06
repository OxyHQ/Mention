import { Router, Request, Response } from 'express';
import UserSettings from '../models/UserSettings';
import { extractPublicProfileData } from '../utils/userSettings';
import { sendErrorResponse, sendSuccessResponse, validateRequired } from '../utils/apiHelpers';

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
}

/**
 * GET /api/profile/design/:userId
 * Get public profile design data for a user
 */
router.get('/:userId', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    
    const validationError = validateRequired(userId, 'userId');
    if (validationError) {
      return sendErrorResponse(res, 400, 'Bad Request', validationError);
    }

    const doc = await UserSettings.findOne({ oxyUserId: userId }).lean();
    const response = extractPublicProfileData(doc, userId) as PublicProfileDesignResponse;

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
