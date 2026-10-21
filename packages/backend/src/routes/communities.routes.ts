/**
 * A COMMUNITY'S MODERATION — what its moderators do to a community hosted here.
 *
 * A community is an Oxy ACCOUNT (`kind: 'community'`) whose active members are
 * its moderators, so `:communityId` is that account's Oxy id, and every route
 * here is gated by `assertCanModerateCommunity` with the caller's OWN bearer
 * (Oxy decides who moderates; Mention keeps no copy). Posting into a community
 * is `POST /posts` with `communityOxyUserId`; joining it is an ordinary Oxy
 * follow; its moderators are public at Oxy's `GET /users/:id/moderators`.
 *
 *  - `GET    /communities/joined` — the communities the caller joined, hosted
 *    here or remote (the composer's choice of where to post)
 *  - `POST   /communities/:communityId/posts/:postId/removal` `{ reason? }`
 *  - `GET    /communities/:communityId/bans`
 *  - `POST   /communities/:communityId/bans` `{ userId, reason? }`
 *  - `DELETE /communities/:communityId/bans/:userId`
 */

import { Router, type Response } from 'express';
import type { CommunityBansResponse, JoinedCommunitiesResponse } from '@mention/shared-types';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import { getRequiredOxyUserId } from '@oxy.so/core/server';
import { PublishAsAccessError } from '../services/publishAsAccount';
import { listJoinedCommunities } from '../services/communities/joinedCommunities';
import { CommunityPostError } from '../services/communities/communityPosting';
import {
  banFromCommunity,
  listBansForModerators,
  normalizeModerationReason,
  removePostFromCommunity,
  unbanFromCommunity,
} from '../services/communities/communityModeration';
import { createUserScopedOxyServices } from '../utils/oxyHelpers';
import { communityModerationRateLimiter } from '../middleware/security';
import { config } from '../config';
import { sendErrorResponse, sendSuccessResponse } from '../utils/apiHelpers';
import { logger } from '../utils/logger';

const router = Router();

/** Longest id we will look up — an Oxy id or a post id is far shorter. */
const MAX_ID_LENGTH = 64;

function idParam(value: unknown): string | null {
  const id = typeof value === 'string' ? value.trim() : '';
  return id && id.length <= MAX_ID_LENGTH ? id : null;
}

const STATUS_LABELS: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  503: 'Service Unavailable',
};

/** One error mapping for every route: the gate's and the service's refusals. */
function sendModerationError(res: Response, error: unknown, context: string): Response {
  if (error instanceof PublishAsAccessError || error instanceof CommunityPostError) {
    return sendErrorResponse(
      res,
      error.status,
      STATUS_LABELS[error.status] ?? 'Error',
      error.message,
    );
  }
  logger.error(`[Communities] ${context} failed`, error);
  return sendErrorResponse(res, 500, 'Internal Server Error', 'Moderation failed; try again.');
}

// Production-gated in the PER-ROUTE position, like the channel routers:
// `router.use(...limiters)` with an empty array throws at import outside production.
const limiters = config.runtime.isProduction ? [communityModerationRateLimiter] : [];

/**
 * The communities the caller joined (joining one is following it), hosted here
 * or remote — see `listJoinedCommunities`.
 */
router.get('/joined', async (req: AuthRequest, res: Response) => {
  try {
    const communities = await listJoinedCommunities(
      getRequiredOxyUserId(req),
      createUserScopedOxyServices(req),
    );
    res.set('Cache-Control', 'private, no-store');
    return sendSuccessResponse<JoinedCommunitiesResponse>(res, 200, { communities });
  } catch (error) {
    return sendModerationError(res, error, 'joined communities');
  }
});

router.post(
  '/:communityId/posts/:postId/removal',
  ...limiters,
  async (req: AuthRequest, res: Response) => {
    const communityId = idParam(req.params.communityId);
    const postId = idParam(req.params.postId);
    if (!communityId || !postId) {
      return sendErrorResponse(res, 400, 'Bad Request', 'communityId and postId are required');
    }
    try {
      await removePostFromCommunity({
        communityOxyUserId: communityId,
        moderatorOxyUserId: getRequiredOxyUserId(req),
        memberReader: createUserScopedOxyServices(req),
        postId,
        reason: normalizeModerationReason(req.body?.reason),
      });
      return sendSuccessResponse(res, 200, { removed: true });
    } catch (error) {
      return sendModerationError(res, error, 'post removal');
    }
  },
);

router.get('/:communityId/bans', ...limiters, async (req: AuthRequest, res: Response) => {
  const communityId = idParam(req.params.communityId);
  if (!communityId) return sendErrorResponse(res, 400, 'Bad Request', 'communityId is required');
  try {
    const bans = await listBansForModerators({
      communityOxyUserId: communityId,
      moderatorOxyUserId: getRequiredOxyUserId(req),
      memberReader: createUserScopedOxyServices(req),
    });
    res.set('Cache-Control', 'private, no-store');
    return sendSuccessResponse<CommunityBansResponse>(res, 200, { bans });
  } catch (error) {
    return sendModerationError(res, error, 'ban list');
  }
});

router.post('/:communityId/bans', ...limiters, async (req: AuthRequest, res: Response) => {
  const communityId = idParam(req.params.communityId);
  const userId = idParam(req.body?.userId);
  if (!communityId || !userId) {
    return sendErrorResponse(res, 400, 'Bad Request', 'communityId and userId are required');
  }
  try {
    await banFromCommunity({
      communityOxyUserId: communityId,
      moderatorOxyUserId: getRequiredOxyUserId(req),
      memberReader: createUserScopedOxyServices(req),
      bannedOxyUserId: userId,
      reason: normalizeModerationReason(req.body?.reason),
    });
    return sendSuccessResponse(res, 200, { banned: true });
  } catch (error) {
    return sendModerationError(res, error, 'ban');
  }
});

router.delete(
  '/:communityId/bans/:userId',
  ...limiters,
  async (req: AuthRequest, res: Response) => {
    const communityId = idParam(req.params.communityId);
    const userId = idParam(req.params.userId);
    if (!communityId || !userId) {
      return sendErrorResponse(res, 400, 'Bad Request', 'communityId and userId are required');
    }
    try {
      await unbanFromCommunity({
        communityOxyUserId: communityId,
        moderatorOxyUserId: getRequiredOxyUserId(req),
        memberReader: createUserScopedOxyServices(req),
        bannedOxyUserId: userId,
      });
      return sendSuccessResponse(res, 200, { banned: false });
    } catch (error) {
      return sendModerationError(res, error, 'unban');
    }
  },
);

export default router;
