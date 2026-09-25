import express, { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { RedisStore } from '../middleware/rateLimitStore';
import {
  isAccountEventRefusal,
  verifyAccountEvent,
  type OxyAccountEvent,
} from '../services/accountErasure/oxyAccountEvents';
import { acceptAccountEvent } from '../services/accountErasure/accountEventIntake';
import { hashedIpKey } from '../utils/ipKey';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';

/**
 * `POST /webhooks/oxy/account-events`: Oxy telling Mention a person deleted their
 * account (OxyHQ/Mention#1169).
 *
 * ## The token is the authentication
 *
 * The body is a Security Event Token (`application/secevent+jwt`), a compact JWS
 * Oxy signs with its service-token key. Verifying it against Oxy's published key
 * set, with `typ`, issuer and audience checks, is what authenticates the request.
 * No Oxy session or service token is accepted in its place, and nothing is erased
 * on an unverified request. That is why this router is mounted BEFORE the JSON
 * parser and every user-auth, deployment-admission and CSRF layer in `app.ts`,
 * next to the CrowdSource webhook.
 *
 * ## Answers
 *
 * - 202: the event is durably recorded in `account_erasures` (a redelivery of an
 *   already-recorded event also gets 202, which is what stops Oxy retrying).
 * - 400: the body is not a compact JWS.
 * - 401: the token did not verify. Oxy retries; a genuine token never gets here.
 * - 415: wrong content type.
 * - 503: the token could not be CHECKED (Oxy's key set unreachable).
 *   Not a 401, because the event may be genuine and Oxy must retry it.
 * - 500: recording failed. Oxy retries.
 *
 * ## Bounds
 *
 * A 16 KB body limit (a token is a few hundred bytes; the SDK refuses past 16 KB)
 * and a per-IP rate limit. The limit sits well above Oxy's own delivery rate: Oxy
 * sends one request per event, and a burst of account deletions is a burst of
 * events that must all land.
 */

const TOKEN_CONTENT_TYPE = 'application/secevent+jwt';
const MAX_TOKEN_BYTES = 16 * 1024;
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export const ACCOUNT_EVENT_WEBHOOK_METRIC = 'oxy_account_event_webhook_total';

export const oxyAccountEventsRateLimiter = rateLimit({
  store: new RedisStore({ prefix: 'rate-limit:oxy-account-events:', windowMs: 60 * 1000 }),
  windowMs: 60 * 1000,
  max: 600,
  keyGenerator: (req: Request) => hashedIpKey(req),
  message: { error: 'Too Many Requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

function answer(res: Response, status: number, outcome: string, body: Record<string, unknown>): void {
  metrics.incrementCounter(ACCOUNT_EVENT_WEBHOOK_METRIC, 1, { outcome });
  res.status(status).json(body);
}

export async function handleAccountEvent(req: Request, res: Response): Promise<void> {
  if (!req.is(TOKEN_CONTENT_TYPE)) {
    answer(res, 415, 'unsupported_media_type', { error: `Content-Type must be ${TOKEN_CONTENT_TYPE}` });
    return;
  }
  const token = typeof req.body === 'string' ? req.body.trim() : '';
  if (!COMPACT_JWS.test(token)) {
    answer(res, 400, 'malformed', { error: 'Body must be a compact JWS security event token' });
    return;
  }

  let event: OxyAccountEvent;
  try {
    event = await verifyAccountEvent(token);
  } catch (error) {
    if (isAccountEventRefusal(error)) {
      logger.warn('[AccountErasure] webhook token refused', {
        reason: error instanceof Error ? error.message : 'refused',
      });
      answer(res, 401, 'refused', { error: 'Invalid account event token' });
      return;
    }
    logger.error('[AccountErasure] webhook token could not be verified', {
      error: error instanceof Error ? error.message : String(error),
    });
    answer(res, 503, 'unverifiable', { error: 'Account event could not be verified; retry' });
    return;
  }

  try {
    const intake = await acceptAccountEvent(event, 'webhook');
    answer(res, 202, intake.inserted ? 'accepted' : 'duplicate', {
      received: true,
      eventId: event.eventId,
      duplicate: !intake.inserted,
    });
  } catch (error) {
    logger.error('[AccountErasure] webhook could not record the event', {
      eventId: event.eventId,
      error: error instanceof Error ? error.message : String(error),
    });
    answer(res, 500, 'record_failed', { error: 'Could not record the event; retry' });
  }
}

export function createOxyAccountEventsRoutes(): Router {
  const router = Router();
  router.post(
    '/oxy/account-events',
    oxyAccountEventsRateLimiter,
    express.text({ type: TOKEN_CONTENT_TYPE, limit: MAX_TOKEN_BYTES }),
    handleAccountEvent,
  );
  return router;
}
