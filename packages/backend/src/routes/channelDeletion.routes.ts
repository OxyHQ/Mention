/**
 * DELETING A CHANNEL — Mention's half, and the trigger `ChannelDeletionService`
 * was deliberately shipped without.
 *
 * ── TWO HALVES, TWO OWNERS, ONE ORDER ─────────────────────────────────────────
 *
 * Deleting a channel destroys things on both sides of the Oxy boundary. Mention
 * owns the posts and every row pointing at them (`CHANNEL_CASCADE`); Oxy owns the
 * account itself, its membership rows, its follow edges and its uploaded bytes
 * (`OWNED_BY_OXY`). Mention cannot archive the account — `DELETE /accounts/:id`
 * is authorized against the CALLER, not against a service credential — so the
 * client performs that half with the SDK once this one has answered.
 *
 * The order is not a preference. Oxy's account reads EXCLUDE an archived account:
 * `GET /users/:id` answers 404 for one and `POST /users/by-ids` filters
 * `accountStatus: { $ne: 'archived' }`. So after the archive:
 *
 *  - `resolveAccountKind` answers `null`, and `deleteChannelContent` refuses
 *    permanently with `NotAChannelAccountError` — by design, since deleting an
 *    account whose kind is unknown is not a risk it takes; and
 *  - `broadcastFederatedDelete` cannot resolve the username the canonical Note
 *    ids are minted from, and throws before a single Tombstone goes out.
 *
 * Archive-first therefore strands every post the channel ever published, forever,
 * with no route able to re-target them and no retry that helps. Mention-first
 * fails the other way: the posts are gone, the fediverse has been told, and an
 * account survives that the operator can archive on a retry. The cascade is
 * idempotent, so a second run over an already-emptied channel reports all-zero
 * counts and does not throw, which is what makes that retry safe.
 *
 * ── WHY THIS IS SYNCHRONOUS AND NOT A BULLMQ JOB ──────────────────────────────
 *
 * The `sharing-cleanup` shape (202, enqueue, inline fallback) is the obvious
 * model and it is the wrong one HERE, for the reason above: a 202 tells the
 * client nothing about whether Mention's half finished, so a client that archived
 * on a 202 would be racing the worker into exactly the unrecoverable state. The
 * client must not archive until this route has answered, so this route answers
 * when the work is done.
 *
 * A client timeout is therefore not a failure of the cascade — the run continues
 * server-side, and a retry converges on a 200 the client can then act on. What
 * must never happen is an archive on anything other than a 2xx from here.
 *
 * ── AUTHORIZATION ─────────────────────────────────────────────────────────────
 *
 * `account:delete`, via `assertCanDeleteAccount` — the SAME permission Oxy gates
 * the account archive on, held by the `owner` role alone. Membership is not
 * enough even though it is enough to PUBLISH as the channel: see that function on
 * why the two halves have to be permitted or refused together.
 */

import { Router, type Response } from 'express';
import type { AccountKind } from '@oxyhq/contracts';
import type { ChannelDeletionCounts } from '@mention/shared-types';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import {
  assertCanDeleteAccount,
  PublishAsAccessError,
} from '../services/publishAsAccount';
import {
  deleteChannelContent,
  previewChannelDeletion,
  NotAChannelAccountError,
  type ChannelDeletionPreview,
} from '../services/channelDeletion/ChannelDeletionService';
import { createUserScopedOxyServices } from '../utils/oxyHelpers';
import { channelDeletionRateLimiter } from '../middleware/security';
import { config } from '../config';
import { sendErrorResponse, sendSuccessResponse } from '../utils/apiHelpers';
import { logger } from '../utils/logger';

const router = Router();

/** Longest account id we will look up — an Oxy user id is a 24-char hex ObjectId. */
const MAX_OXY_USER_ID_LENGTH = 64;

/**
 * The server's preview, narrowed to what a person deciding is owed.
 *
 * `replies` is structurally always 0 (a channel takes no replies at five enforced
 * sites) and `quotesByOthersKept` counts rows that SURVIVE — both are operational
 * facts for a log rather than numbers to put in front of somebody about to
 * destroy an archive, and `channelOxyUserId` is something the client already
 * knows. Narrowing here rather than at the client keeps the decision in one
 * place.
 */
function toCounts(preview: ChannelDeletionPreview): ChannelDeletionCounts {
  return { posts: preview.posts, boostsByOthers: preview.boostsByOthers };
}

/**
 * Resolve the target account and authorize the caller over it, or answer and
 * return `null`.
 *
 * Shared by both routes ON PURPOSE: an affordance the server refuses is worse
 * than no affordance, so the preview a confirmation is built from has to be
 * behind exactly the gate the deletion is behind. A preview readable by somebody
 * the deletion would refuse is a button that appears and then fails.
 *
 * The kind check is separate from the permission check and stays here rather than
 * inside the gate: `assertCanDeleteAccount` answers "may this person", the
 * service answers "is this a channel", and this route is where the two meet. The
 * service re-checks the kind at its own door regardless — that guard is its
 * defence and not this route's to satisfy.
 */
async function resolveDeletableChannel(
  req: AuthRequest,
  res: Response,
): Promise<string | null> {
  const channelOxyUserId =
    typeof req.params.oxyUserId === 'string' ? req.params.oxyUserId.trim() : '';
  if (!channelOxyUserId || channelOxyUserId.length > MAX_OXY_USER_ID_LENGTH) {
    sendErrorResponse(res, 400, 'Bad Request', 'oxyUserId is required');
    return null;
  }

  const callerId = getRequiredOxyUserId(req);

  let kind: AccountKind;
  try {
    kind = await assertCanDeleteAccount({
      targetOxyUserId: channelOxyUserId,
      callerId,
      memberReader: createUserScopedOxyServices(req),
    });
  } catch (error) {
    if (error instanceof PublishAsAccessError) {
      sendErrorResponse(
        res,
        error.status,
        error.status === 400 ? 'Bad Request' : 'Forbidden',
        error.message,
      );
      return null;
    }
    throw error;
  }

  if (kind !== 'channel') {
    sendErrorResponse(res, 400, 'Bad Request', 'That account is not a channel');
    return null;
  }

  return channelOxyUserId;
}

/**
 * GET /channels/:oxyUserId/deletion-preview
 *
 * What deleting this channel would destroy, counted, touching nothing. The count
 * is what the client's confirmation STATES — a channel is a publication, and a
 * bare "are you sure" is not informed consent for destroying an archive.
 */
router.get(
  '/:oxyUserId/deletion-preview',
  // Production-gated in the PER-ROUTE position. `router.use(...limiters)` with an
  // empty array throws `argument handler is required` at import outside
  // production, and this is also the only position CodeQL inspects.
  ...(config.runtime.isProduction ? [channelDeletionRateLimiter] : []),
  async (req: AuthRequest, res: Response) => {
    try {
      const channelOxyUserId = await resolveDeletableChannel(req, res);
      if (!channelOxyUserId) return;

      return sendSuccessResponse(res, 200, toCounts(await previewChannelDeletion(channelOxyUserId)));
    } catch (error) {
      if (error instanceof NotAChannelAccountError) {
        return sendErrorResponse(res, 400, 'Bad Request', 'That account is not a channel');
      }
      logger.error('[ChannelDeletion] Failed to preview a channel deletion', {
        channelOxyUserId: req.params.oxyUserId,
        userId: req.user?.id,
        error,
      });
      return sendErrorResponse(
        res,
        500,
        'Internal Server Error',
        'Failed to read what deleting this channel would remove',
      );
    }
  },
);

/**
 * DELETE /channels/:oxyUserId/content
 *
 * Destroy the channel's posts and every Mention row pointing at them, and tell
 * the fediverse. Named `/content` because that is honestly all it does: the
 * account is Oxy's, and the client archives it with the SDK once this answers
 * 200.
 *
 * A 500 here means Mention's half did NOT complete, and the client must not
 * archive — `deleteChannelContent` collects per-step failures, runs every
 * remaining step, and throws at the end precisely so a caller learns that some of
 * it survived.
 */
router.delete(
  '/:oxyUserId/content',
  ...(config.runtime.isProduction ? [channelDeletionRateLimiter] : []),
  async (req: AuthRequest, res: Response) => {
    try {
      const channelOxyUserId = await resolveDeletableChannel(req, res);
      if (!channelOxyUserId) return;

      logger.warn('[ChannelDeletion] Destroying the content of a channel', {
        channelOxyUserId,
        userId: req.user?.id,
      });
      const result = await deleteChannelContent(channelOxyUserId, { dryRun: false });

      return sendSuccessResponse(res, 200, toCounts(result.preview));
    } catch (error) {
      if (error instanceof NotAChannelAccountError) {
        return sendErrorResponse(res, 400, 'Bad Request', 'That account is not a channel');
      }
      logger.error('[ChannelDeletion] Failed to delete the content of a channel', {
        channelOxyUserId: req.params.oxyUserId,
        userId: req.user?.id,
        error,
      });
      return sendErrorResponse(
        res,
        500,
        'Internal Server Error',
        'Some of the channel could not be deleted. Nothing else was changed; try again.',
      );
    }
  },
);

export default router;
