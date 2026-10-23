/** Own publishing adapter: shared middleware proves identity; native createPost owns policy/effects. */
import { Router, type RequestHandler } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { MentionPublishInput } from '@oxy.so/mention-contracts';
import { reserveMcpEffect, finalizeMcpEffect } from '../mcp/services/mcpEffectReceiptService';
import {
  fingerprintEffectRequest,
  settleReceiptWhenResponseEnds,
} from '../mcp/utils/effectReceiptRequest';
import { logger } from '../utils/logger';

export function createServicePublishingRouter(
  publish: RequestHandler,
  receipts = { reserve: reserveMcpEffect, finalize: finalizeMcpEffect },
): Router {
  const router = Router();
  router.post(
    '/posts',
    async (req, res, next) => {
      const authenticated = req as OxyAuthRequest;
      const service = authenticated.serviceApp;
      const requester = authenticated.serviceActingAs;
      if (
        service?.authority !== 'first_party' ||
        requester?.authority !== 'first_party' ||
        !requester.requesterContext ||
        !requester.userId ||
        authenticated.user?.id !== requester.userId
      ) {
        res.status(403).json({ error: 'verified_own_requester_required' });
        return;
      }
      const key = req.header('Idempotency-Key')?.trim();
      if (!key || !/^mcp:[a-f0-9]{64}$/.test(key)) {
        res.status(428).json({ error: 'publishing_idempotency_required' });
        return;
      }
      const parsed = MentionPublishInput.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_publication' });
        return;
      }
      req.body = parsed.data;
      try {
        const reservation = await receipts.reserve({
          oxyUserId: requester.userId,
          clientId: `oxy-service:${service.appId}`,
          toolName: 'create-post',
          idempotencyKey: key,
          requestFingerprint: fingerprintEffectRequest(req, 'create-post'),
        });
        if (reservation.kind !== 'reserved') {
          res.status(409).json({
            error:
              reservation.kind === 'conflict'
                ? 'publishing_key_conflict'
                : 'publishing_already_reserved',
          });
          return;
        }
        settleReceiptWhenResponseEnds(
          res,
          (status, indeterminate) =>
            receipts.finalize(reservation.receiptId, status, indeterminate),
          () => logger.error('[ServicePublishing] Could not finalize publication receipt'),
        );
        next();
      } catch {
        res.status(503).json({ error: 'publishing_receipt_unavailable' });
      }
    },
    publish,
  );
  return router;
}
