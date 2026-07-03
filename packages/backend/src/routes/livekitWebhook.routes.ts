import express, { Router, Request, Response } from 'express';
import { WebhookReceiver } from 'livekit-server-sdk';
import Room from '../models/Room';
import { logger } from '../utils/logger';
import { advancePodcastQueueForRoom } from './rooms.routes';

/**
 * LiveKit webhook receiver — the machine-to-machine trigger that auto-advances
 * a room's podcast queue when the current ingress ends.
 *
 * Mounting contract (see `server.ts`): this router is registered with a RAW
 * body parser BEFORE the global `express.json()` middleware, because
 * `WebhookReceiver` verifies the LiveKit signature against the EXACT raw payload
 * bytes — a JSON re-serialization would invalidate it. It sits ahead of the
 * global Oxy rate limiter too; that is intentional and safe: the route is
 * machine-to-machine and gated entirely by cryptographic signature verification
 * (an unsigned / mis-signed request never reaches the handler body), so it needs
 * no per-request rate limit.
 *
 * Env-gated: with LiveKit credentials absent the handler is inert (503, no work).
 * NOTE FOR OPERATORS: auto-advance only fires once the webhook URL
 * (`https://api.mention.earth/livekit/webhook`) is registered in the LiveKit
 * project's webhook config — an infrastructure step OUTSIDE this repo. The
 * manual `POST /rooms/:id/stream/podcast/next` endpoint works without it.
 */

const router = Router();

/** The event we act on; every other LiveKit event type is acknowledged + ignored. */
const INGRESS_ENDED_EVENT = 'ingress_ended';

router.post(
  '/webhook',
  // Buffer the raw request bytes for signature verification. Bounded to protect
  // against oversized payloads; LiveKit webhook bodies are small JSON blobs.
  express.raw({ type: '*/*', limit: '512kb' }),
  async (req: Request, res: Response) => {
    // Read creds at request time so the gate reflects the current environment
    // regardless of module load order.
    const apiKey = process.env.LIVEKIT_API_KEY || '';
    const apiSecret = process.env.LIVEKIT_API_SECRET || '';
    if (!apiKey || !apiSecret) {
      logger.warn('[LiveKitWebhook] Ignoring webhook: LiveKit credentials not configured');
      return res.status(503).json({ message: 'LiveKit webhook not configured' });
    }

    const receiver = new WebhookReceiver(apiKey, apiSecret);

    let event;
    try {
      const rawBody = Buffer.isBuffer(req.body)
        ? req.body.toString('utf8')
        : typeof req.body === 'string'
          ? req.body
          : '';
      // Throws when the signature/JWT in the Authorization header does not match
      // the raw body — the sole authentication gate for this route.
      event = await receiver.receive(rawBody, req.header('Authorization'));
    } catch (err) {
      logger.warn('[LiveKitWebhook] Signature verification failed', {
        reason: err instanceof Error ? err.message : 'unknown',
      });
      return res.status(401).json({ message: 'Invalid webhook signature' });
    }

    if (event.event !== INGRESS_ENDED_EVENT) {
      // Not our concern — acknowledge so LiveKit does not retry.
      return res.status(200).json({ ok: true, ignored: event.event });
    }

    const ingressId = event.ingressInfo?.ingressId;
    if (!ingressId) {
      return res.status(200).json({ ok: true, ignored: 'missing-ingress-id' });
    }

    const room = await Room.findOne({ activeIngressId: ingressId });
    if (!room) {
      // The ended ingress is not the room's currently-active one (already
      // replaced/stopped, or belongs to no live room). Nothing to do.
      return res.status(200).json({ ok: true, ignored: 'no-matching-room' });
    }

    try {
      // Empty queue ⇒ this stops the stream + emits `room:stream:stopped`;
      // non-empty ⇒ starts the next episode. Identical policy to `/next`.
      const result = await advancePodcastQueueForRoom(room, String(room._id), 'livekit-webhook');
      if (result.kind === 'error') {
        logger.warn('[LiveKitWebhook] Failed to start next queued episode after ingress_ended', {
          roomId: String(room._id),
          status: result.status,
          message: result.body.message,
        });
      }
    } catch (err) {
      // Never surface a 5xx to LiveKit (it would retry the whole delivery); the
      // failure is logged and a manual `/next` can recover the room.
      logger.error('[LiveKitWebhook] Error advancing/stopping stream after ingress_ended', {
        roomId: String(room._id),
        error: err,
      });
    }

    return res.status(200).json({ ok: true });
  },
);

export default router;
