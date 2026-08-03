import { Router, Response } from 'express';
import type { ProfileMedia } from '../db/userProfile/userSettingsRecord';
import { loadUserSettings } from '../db/userProfile/userSettingsRepository';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { extractPublicProfileData, redactedProfileDesign } from '../utils/userSettings';
import { sendErrorResponse, sendSuccessResponse, validateRequired } from '../utils/apiHelpers';
import { canViewProfileDesign, ProfileVisibility } from '../utils/privacyHelpers';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { PostType, PostVisibility } from '@mention/shared-types';
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
  boostsCount?: number;
  repliesCount?: number;
  appearance?: {
    primaryColor?: string;
  };
  profileHeaderImage?: string;
  profileMedia?: ProfileMedia;
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

    const doc = await loadUserSettings(userId);
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

    // Calculate post-related counts in parallel. All three are scoped to the
    // user's published public content and leverage existing indexes (oxyUserId,
    // type, parentPostId, boostOf), so there is no N+1.
    // - postsCount: top-level posts (not replies) — matches the author feed's
    //   `posts` filter (`author|<oxyUserId>`).
    //   `parentPostId: null` matches null OR a missing field in MongoDB.
    // - boostsCount: documents authored as boosts (type=boost, boostOf set).
    // - repliesCount: the inverse of postsCount — posts that ARE replies.
    // ONE grouped pass over the author's public published posts, `filter`-ed per
    // bucket, rather than three COUNTs over the same index range.
    const authored = and(
      eq(posts.oxyUserId, userId),
      eq(posts.visibility, PostVisibility.PUBLIC),
      eq(posts.status, 'published'),
    );
    const [counts] = await getDb()
      .select({
        // The STORED discriminator, not `parent_post_id IS NULL`: an orphaned
        // reply (parent deleted, `ON DELETE SET NULL` fired) is still a reply and
        // must not be counted as a top-level post here while the author feed's
        // `posts` tab — which reads the same column — leaves it out.
        postsCount: sql<number>`count(*) filter (where ${posts.isReply} = false)::int`,
        boostsCount: sql<number>`count(*) filter (where ${posts.type} = ${PostType.BOOST})::int`,
        repliesCount: sql<number>`count(*) filter (where ${posts.isReply})::int`,
      })
      .from(posts)
      .where(authored);

    response.postsCount = counts?.postsCount ?? 0;
    response.boostsCount = counts?.boostsCount ?? 0;
    response.repliesCount = counts?.repliesCount ?? 0;

    // Include privacy info in response
    if (doc?.privacy?.profileVisibility) {
      response.privacy = {
        profileVisibility: doc.privacy.profileVisibility,
      };
    }
    return sendSuccessResponse(res, 200, response);
  } catch (error) {
    logger.error('[ProfileDesign] Error fetching profile design:', { userId: req.user?.id, targetUserId: req.params.userId, error });
    return sendErrorResponse(
      res,
      500,
      'Internal Server Error',
      'Failed to fetch profile design data'
    );
  }
});

export default router;
