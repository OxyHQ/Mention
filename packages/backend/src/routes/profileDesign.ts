import { Router, type Response } from 'express';
import type { ProfileMedia } from '../db/userProfile/userSettingsRecord';
import { loadUserSettings } from '../db/userProfile/userSettingsRepository';
import { extractPublicProfileData, redactedProfileDesign } from '../utils/userSettings';
import { sendErrorResponse, sendSuccessResponse, validateRequired } from '../utils/apiHelpers';
import { canViewProfileDesign, ProfileVisibility } from '../utils/privacyHelpers';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import { logger } from '../utils/logger';
import type { RemoteProfileStats } from '@mention/shared-types/profile';
import { loadPublicProfileFacts } from '../services/publicProfileFacts';
import { isAccountErased } from '../services/accountErasure/erasedAccounts';

const router = Router();

/**
 * Public Profile Design API
 * Returns only public profile appearance/customization data.
 * No authentication required.
 */

interface PublicProfileDesignResponse {
  oxyUserId: string;
  postsCount?: number;
  boostsCount?: number;
  repliesCount?: number;
  profileHeaderImage?: string;
  profileMedia?: ProfileMedia;
  privacy?: {
    profileVisibility?: 'public' | 'private' | 'followers_only';
    /**
     * Whether search engines may index this profile and its posts. Public by
     * nature: every page of the profile already says it in its `robots` tag.
     */
    searchEngineIndexing?: boolean;
    /** Whether other people can see this account's likes (drives the Likes tab). */
    showLikes?: boolean;
  };
  /**
   * Present only for a federated account: the origin's own totals and join
   * date, each omitted when unknown. See `remoteProfileStats`.
   */
  remote?: RemoteProfileStats;
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

    // The three reads are independent, so they start together. The profile
    // facts are only READ ahead of the decisions below: they are awaited — and
    // anything from them sent, or any failure of theirs surfaced — only once the
    // erasure and access checks have passed.
    const factsRead = loadPublicProfileFacts(userId);
    factsRead.catch(() => undefined);
    const [erased, doc] = await Promise.all([isAccountErased(userId), loadUserSettings(userId)]);

    // An account Oxy told us was deleted has no profile to describe. Without this
    // the route would answer 200 with default settings and zero counts for it,
    // which is what the issue that introduced erasure saw (OxyHQ/Mention#1169).
    if (erased) {
      return sendErrorResponse(res, 404, 'Not Found', 'Profile not found');
    }

    const profileVisibility = doc?.privacy?.profileVisibility || ProfileVisibility.PUBLIC;

    // The shared profile-design rule (`GET /profile/settings/:userId` applies the
    // same one). A viewer without access still learns the profile IS restricted,
    // so the frontend can render the locked state instead of an empty profile.
    if (!(await canViewProfileDesign(userId, currentUserId, profileVisibility))) {
      return sendSuccessResponse(res, 200, {
        ...redactedProfileDesign(userId),
        privacy: { profileVisibility },
      } satisfies PublicProfileDesignResponse);
    }

    // User has access - return full profile design data with privacy info
    const response = extractPublicProfileData(doc, userId) as PublicProfileDesignResponse;

    const { counts, remote } = await factsRead;

    response.postsCount = counts.postsCount;
    response.boostsCount = counts.boostsCount;
    response.repliesCount = counts.repliesCount;
    if (remote) response.remote = remote;

    // Report the same resolved policy used by the access check, including the
    // public default when no settings row exists. Missing client privacy then
    // means unresolved/failed data rather than an implicitly public profile.
    response.privacy = {
      profileVisibility,
      searchEngineIndexing: doc?.privacy?.searchEngineIndexing ?? true,
      showLikes: doc?.privacy?.showLikes ?? false,
    };
    return sendSuccessResponse(res, 200, response);
  } catch (error) {
    logger.error('[ProfileDesign] Error fetching profile design:', {
      userId: req.user?.id,
      targetUserId: req.params.userId,
      error,
    });
    return sendErrorResponse(
      res,
      500,
      'Internal Server Error',
      'Failed to fetch profile design data',
    );
  }
});

export default router;
