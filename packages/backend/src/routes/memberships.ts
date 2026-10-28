import { reconcileMembershipInvoice } from '../services/memberships/billing/receipts';
import { Router, raw, type Response } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { safetyRequesterFor, type RequestSafetyContext } from '../utils/safetyRequester';
type MembershipRequest = OxyAuthRequest & RequestSafetyContext;
import { z } from 'zod';
import {
  MEMBERSHIP_BENEFITS,
  MEMBERSHIP_CONTENT_KINDS,
  MEMBERSHIP_TIER_STATES,
} from '@mention/shared-types';
import { createUserScopedOxyServices } from '../utils/oxyHelpers';
import { decodeChronoCursor, encodeChronoCursor } from '../utils/chronoCursor';
import { sendErrorResponse, sendSuccessResponse } from '../utils/apiHelpers';
import { logger } from '../utils/logger';
import { PublishAsAccessError } from '../services/publishAsAccount';
import { MembershipError, type MembershipActor } from '../services/memberships/access';
import {
  listMyMembershipCommunities,
  createMembershipCommunity,
  createMembershipTier,
  joinFreeMembership,
  leaveMembership,
  membershipDirectory,
  membershipInsights,
  membershipLanding,
  revokeMembership,
  setMembershipBadge,
  updateMembershipTier,
  updateMembershipCommunity,
} from '../services/memberships/communities';
import {
  createMembershipContent,
  listMembershipContent,
  membershipContentTeaser,
  membershipReportQueue,
  readMembershipContent,
  removeMembershipContent,
  reportMembershipContent,
  resolveMembershipReport,
  voteMembershipPoll,
} from '../services/memberships/content';
import {
  discardMembershipMedia,
  downloadMembershipMedia,
  uploadMembershipMedia,
} from '../services/memberships/media';

const id = z.string().trim().min(1).max(128);
const name = z.string().trim().min(1).max(120);
const description = z.string().trim().max(5000);
const communityInput = z
  .object({
    ownerOxyUserId: id,
    name,
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .min(3)
      .max(80),
    description: description.optional(),
    visibility: z.enum(['public', 'unlisted']).optional(),
  })
  .strict();
const tierInput = z
  .object({
    name,
    description: description.optional(),
    kind: z.enum(['free', 'paid']),
    benefits: z.array(z.enum(MEMBERSHIP_BENEFITS)).min(1).max(MEMBERSHIP_BENEFITS.length),
  })
  .strict();
const contentInput = z
  .object({
    kind: z.enum(MEMBERSHIP_CONTENT_KINDS),
    title: z.string().trim().max(200).optional(),
    body: z.string().trim().min(1).max(50000),
    teaser: z.string().trim().min(1).max(1000).optional(),
    requiredTierIds: z.array(id).max(20).optional(),
    parentContentId: id.optional(),
    mediaIds: z.array(id).max(10).optional(),
    poll: z
      .object({
        options: z.array(z.string().trim().min(1).max(200)).min(2).max(10),
        endsAt: z.iso
          .datetime()
          .refine((value) => new Date(value) > new Date(), 'Poll must end in the future'),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (input) => (input.kind === 'poll') === !!input.poll,
    'Poll options are required only for polls',
  );
function foregroundActor(req: MembershipRequest, required = true): MembershipActor | undefined {
  if (req.mcp || req.capability || req.serviceApp || !req.user || !req.accessToken) {
    if (required)
      throw new MembershipError(req.user ? 403 : 401, 'A foreground account session is required');
    return undefined;
  }
  return {
    accountId: req.user.id,
    requester: safetyRequesterFor(req),
    memberReader: createUserScopedOxyServices(req),
  };
}
function actor(req: MembershipRequest): MembershipActor {
  const result = foregroundActor(req);
  if (!result) throw new MembershipError(401, 'Sign in required');
  return result;
}
const param = (req: MembershipRequest, key: string) => id.parse(req.params[key]);
function endpoint(operation: (req: MembershipRequest) => Promise<unknown>, status = 200) {
  return async (req: MembershipRequest, res: Response) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      return sendSuccessResponse(res, status, await operation(req));
    } catch (error) {
      if (error instanceof z.ZodError)
        return sendErrorResponse(
          res,
          400,
          'Bad Request',
          error.issues[0]?.message ?? 'Invalid request',
        );
      if (error instanceof MembershipError || error instanceof PublishAsAccessError)
        return sendErrorResponse(res, error.status, 'Membership request failed', error.message);
      const cause = error instanceof Error && 'cause' in error ? error.cause : error;
      if (cause && typeof cause === 'object' && 'code' in cause && cause.code === '23505')
        return sendErrorResponse(
          res,
          409,
          'Conflict',
          'That community slug or tier already exists',
        );
      logger.error('[Memberships] Request failed', {
        name: error instanceof Error ? error.name : 'UnknownError',
      });
      return sendErrorResponse(res, 500, 'Internal Server Error', 'Membership request failed');
    }
  };
}
export const publicMembershipRoutes = Router();
publicMembershipRoutes.get(
  '/:communityId/landing',
  endpoint((req) =>
    membershipLanding(
      param(req, 'communityId'),
      foregroundActor(req, false),
      safetyRequesterFor(req),
    ),
  ),
);
publicMembershipRoutes.get(
  '/:communityId/directory',
  endpoint((req) => membershipDirectory(param(req, 'communityId'), safetyRequesterFor(req))),
);
publicMembershipRoutes.get(
  '/content/:contentId/teaser',
  endpoint((req) => membershipContentTeaser(param(req, 'contentId'), safetyRequesterFor(req))),
);

export const membershipRoutes = Router();
// No public-posting MCP grant or generic own-product task confers private membership access.
membershipRoutes.use((req: MembershipRequest, res, next) => {
  try {
    actor(req);
    next();
  } catch (error) {
    if (error instanceof MembershipError) {
      sendErrorResponse(res, error.status, 'Forbidden', error.message);
      return;
    }
    next(error);
  }
});
membershipRoutes.get(
  '/mine',
  endpoint((req) => listMyMembershipCommunities(actor(req), createUserScopedOxyServices(req))),
);
membershipRoutes.post(
  '/',
  endpoint((req) => createMembershipCommunity(actor(req), communityInput.parse(req.body)), 201),
);
membershipRoutes.patch(
  '/:communityId',
  endpoint((req) =>
    updateMembershipCommunity(
      param(req, 'communityId'),
      actor(req),
      z
        .object({
          name: name.optional(),
          description: description.optional(),
          visibility: z.enum(['public', 'unlisted']).optional(),
          status: z.enum(['draft', 'active', 'paused', 'closed']).optional(),
        })
        .strict()
        .parse(req.body),
    ),
  ),
);
membershipRoutes.post(
  '/:communityId/tiers',
  endpoint(
    (req) => createMembershipTier(param(req, 'communityId'), actor(req), tierInput.parse(req.body)),
    201,
  ),
);
membershipRoutes.post(
  '/:communityId/tiers/:tierId/billing/reconcile',
  endpoint(async (req) => {
    const caller = actor(req);
    const refs = z.object({ invoiceId: id, subscriptionId: id }).strict().parse(req.body);
    const receipt = await reconcileMembershipInvoice(
      param(req, 'communityId'),
      param(req, 'tierId'),
      caller,
      req,
      refs,
    );
    // Evidence was recorded, not a promise of paid access; no provider IDs or fiscal payload leak.
    return { recorded: true, state: receipt.state };
  }),
);
membershipRoutes.patch(
  '/:communityId/tiers/:tierId',
  endpoint(async (req) => {
    await updateMembershipTier(
      param(req, 'communityId'),
      param(req, 'tierId'),
      actor(req),
      z
        .object({
          status: z.enum(MEMBERSHIP_TIER_STATES).optional(),
          name: name.optional(),
          description: description.optional(),
          benefits: z
            .array(z.enum(MEMBERSHIP_BENEFITS))
            .min(1)
            .max(MEMBERSHIP_BENEFITS.length)
            .optional(),
        })
        .strict()
        .parse(req.body),
    );
    return { updated: true };
  }),
);
membershipRoutes.put(
  '/:communityId/membership',
  endpoint((req) =>
    joinFreeMembership(
      param(req, 'communityId'),
      actor(req),
      z.object({ tierId: id }).strict().parse(req.body).tierId,
    ),
  ),
);
membershipRoutes.delete(
  '/:communityId/membership',
  endpoint(async (req) => {
    await leaveMembership(param(req, 'communityId'), actor(req));
    return { left: true };
  }),
);
membershipRoutes.patch(
  '/:communityId/membership',
  endpoint(async (req) => {
    await setMembershipBadge(
      param(req, 'communityId'),
      actor(req),
      z.object({ publicBadge: z.boolean() }).strict().parse(req.body).publicBadge,
    );
    return { updated: true };
  }),
);
membershipRoutes.delete(
  '/:communityId/members/:memberId',
  endpoint(async (req) => {
    await revokeMembership(param(req, 'communityId'), actor(req), param(req, 'memberId'));
    return { revoked: true };
  }),
);
membershipRoutes.get(
  '/:communityId/insights',
  endpoint((req) => membershipInsights(param(req, 'communityId'), actor(req))),
);
membershipRoutes.get(
  '/:communityId/reports',
  endpoint((req) => membershipReportQueue(param(req, 'communityId'), actor(req))),
);
membershipRoutes.post(
  '/:communityId/reports/:reportId/resolve',
  endpoint(async (req) => {
    await resolveMembershipReport(param(req, 'communityId'), param(req, 'reportId'), actor(req));
    return { resolved: true };
  }),
);
membershipRoutes.post(
  '/:communityId/content',
  endpoint(
    (req) =>
      createMembershipContent(param(req, 'communityId'), actor(req), contentInput.parse(req.body)),
    201,
  ),
);
membershipRoutes.get(
  '/:communityId/content',
  endpoint(async (req) => {
    const input = z
      .object({
        limit: z.coerce.number().int().min(1).max(50).default(20),
        cursor: z.string().max(1024).optional(),
        parentContentId: id.optional(),
      })
      .strict()
      .parse(req.query);
    const before = input.cursor ? decodeChronoCursor(input.cursor) : undefined;
    if (input.cursor && !before) throw new MembershipError(400, 'Invalid content cursor');
    const page = await listMembershipContent(param(req, 'communityId'), actor(req), {
      limit: input.limit,
      before,
      parentContentId: input.parentContentId,
    });
    return {
      items: page.items,
      nextCursor:
        page.hasMore && page.last ? encodeChronoCursor(page.last.createdAt, page.last.id) : null,
    };
  }),
);
membershipRoutes.get(
  '/content/:contentId',
  endpoint((req) => readMembershipContent(param(req, 'contentId'), actor(req))),
);
membershipRoutes.delete(
  '/content/:contentId',
  endpoint(async (req) => {
    await removeMembershipContent(param(req, 'contentId'), actor(req));
    return { removed: true };
  }),
);
membershipRoutes.put(
  '/content/:contentId/vote',
  endpoint(async (req) => {
    await voteMembershipPoll(
      param(req, 'contentId'),
      actor(req),
      z.object({ optionId: id }).strict().parse(req.body).optionId,
    );
    return { voted: true };
  }),
);
membershipRoutes.post(
  '/content/:contentId/reports',
  endpoint(async (req) => {
    await reportMembershipContent(
      param(req, 'contentId'),
      actor(req),
      z
        .object({ reason: z.string().trim().min(1).max(2000) })
        .strict()
        .parse(req.body).reason,
    );
    return { reported: true };
  }, 201),
);
membershipRoutes.post(
  '/:communityId/media',
  raw({ type: () => true, limit: '40mb' }),
  endpoint((req) => {
    const mime = req.get('Content-Type')?.split(';')[0].trim() ?? '';
    if (
      !/^(image\/(jpeg|png|webp|gif|avif)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|ogg|wav|webm))$/.test(
        mime,
      ) ||
      !Buffer.isBuffer(req.body) ||
      !req.body.length
    )
      throw new MembershipError(400, 'A supported image, video or audio body is required');
    return uploadMembershipMedia(param(req, 'communityId'), actor(req), req, req.body, mime);
  }, 201),
);
membershipRoutes.delete(
  '/:communityId/media/:mediaId',
  endpoint(async (req) => {
    await discardMembershipMedia(param(req, 'communityId'), param(req, 'mediaId'), actor(req));
    return { discarded: true };
  }),
);
membershipRoutes.get(
  '/content/:contentId/media/:mediaId',
  endpoint((req) =>
    downloadMembershipMedia(param(req, 'contentId'), param(req, 'mediaId'), actor(req), req),
  ),
);
