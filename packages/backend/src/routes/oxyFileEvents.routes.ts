import express, { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import {
  FileEventVerificationError,
  verifyFileEventSignature,
  type FileEvent,
  type FileWebhookChallenge,
} from '@oxy.so/core/server';
import { config } from '../config';
import { RedisStore } from '../middleware/rateLimitStore';
import { applyFileEvent } from '../services/oxyFiles/fileEvents';
import { hashedIpKey } from '../utils/ipKey';
import { logger } from '../utils/logger';

/**
 * `POST /webhooks/oxy/files`: Oxy telling Mention that a file it uses or owns
 * was deleted, taken down, trashed, restored or changed visibility (ADR 0043
 * D9/D10). What is done about it: `services/oxyFiles/fileEvents.ts`.
 *
 * ## The signature is the authentication
 *
 * `oxy-signature: t=<unix>,v1=<HMAC-SHA256(secret, "<t>.<raw body>")>`, checked
 * by `verifyFileEventSignature` over the bytes that ARRIVED — so this router
 * reads the body raw and is mounted BEFORE `express.json()` and every session,
 * admission and CSRF layer in `app.ts`, beside the other two webhooks. Mounted
 * after the JSON parser it would see a consumed stream and refuse every event,
 * which is why `appFactory.test.ts` pins its position.
 *
 * ## The secret, and the one unsigned request
 *
 * The secret is the one Oxy returned when the endpoint was set
 * (`OXY_FILES_WEBHOOK_SECRET`; `…_PREVIOUS` during a rotation). Setting the
 * endpoint is itself verified: Oxy POSTs `{ type: 'webhook.challenge', challenge }`
 * and stores the endpoint only if it is echoed — BEFORE anyone holds the
 * secret. So the challenge is answered whether or not a secret is configured
 * (echoing it grants nothing), and every event is refused with 503 until one is:
 * Oxy retries with backoff, so nothing is lost while it is being provisioned.
 *
 * ## Answers
 *
 * - 200 `{ challenge }`: the endpoint challenge.
 * - 204: applied, or a duplicate / older event (recorded, nothing to do).
 * - 400: not a file event. 401: the signature did not verify.
 * - 503: no secret configured yet. 500: applying failed. Oxy retries both.
 */

const MAX_BODY_BYTES = '4mb';

export const oxyFileEventsRateLimiter = rateLimit({
  store: new RedisStore({ prefix: 'rate-limit:oxy-file-events:', windowMs: 60 * 1000 }),
  windowMs: 60 * 1000,
  max: 1200,
  keyGenerator: (req: Request) => hashedIpKey(req),
  message: { error: 'Too Many Requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

type Verified = FileEvent | FileWebhookChallenge;

/** Verify with the current secret, then the previous one (a rotation). */
function verify(raw: Buffer, req: Request): Verified {
  const secrets = [config.oxyFiles.webhookSecret, config.oxyFiles.webhookPreviousSecret].filter(
    (secret): secret is string => typeof secret === 'string' && secret.length > 0,
  );
  if (secrets.length === 0) {
    // Only a challenge verifies without a secret; anything else throws
    // "No signing secret configured".
    return verifyFileEventSignature(raw, req.headers, '');
  }
  let lastError: unknown;
  for (const secret of secrets) {
    try {
      return verifyFileEventSignature(raw, req.headers, secret);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function handleFileEvent(req: Request, res: Response): Promise<void> {
  const raw = Buffer.isBuffer(req.body) ? req.body : null;
  if (!raw || raw.length === 0) {
    res.status(400).json({ error: 'Expected a JSON body' });
    return;
  }

  let verified: Verified;
  try {
    verified = verify(raw, req);
  } catch (error) {
    if (error instanceof FileEventVerificationError) {
      if (error.message === 'No signing secret configured') {
        logger.error('[FileEvents] event refused: OXY_FILES_WEBHOOK_SECRET is not configured');
        res.status(503).json({ error: 'File events are not configured yet; retry' });
        return;
      }
      const malformed = /not (UTF-8|JSON|a file event)/.test(error.message);
      logger.warn('[FileEvents] request refused', { reason: error.message });
      res.status(malformed ? 400 : 401).json({ error: error.message });
      return;
    }
    throw error;
  }

  if (verified.type === 'webhook.challenge') {
    logger.info('[FileEvents] answered the endpoint challenge');
    res.status(200).json({ challenge: verified.challenge });
    return;
  }

  try {
    await applyFileEvent(verified);
    res.status(204).end();
  } catch (error) {
    logger.error('[FileEvents] could not apply the event; Oxy will retry', {
      eventId: verified.id,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Could not apply the event; retry' });
  }
}

export function createOxyFileEventsRoutes(): Router {
  const router = Router();
  router.post(
    '/oxy/files',
    oxyFileEventsRateLimiter,
    express.raw({ type: 'application/json', limit: MAX_BODY_BYTES }),
    (req, res, next) => {
      handleFileEvent(req, res).catch(next);
    },
  );
  return router;
}
