import { Router } from 'express';
import { crowdsourceWebhooks } from '@oxyhq/crowdsource-express';
import { config } from '../config';
import { recordDecisionEvent, recordIgnoredEvent } from '../services/moderation/ModerationInboundService';
import { moderationProcessedEventStore } from '../services/moderation/moderationEventStore';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';

/**
 * `POST /webhooks/crowdsource` — where decisions come back.
 *
 * ## The mount is part of the correctness
 *
 * This router MUST be mounted before `express.json()` in `app.ts`. The signature
 * covers `timestamp + "." + rawBody` — the bytes that arrived — and once a JSON
 * parser has run, those bytes are gone. Mention's parser keeps a copy in
 * `req.rawBody`, but as a UTF-8 STRING for HTTP-signature verification, and
 * `@oxyhq/crowdsource-express` looks for a Buffer; it therefore sees a parsed
 * `req.body`, refuses, and hands a configuration error to the error handler rather
 * than verifying a signature over a re-serialisation. That refusal is the correct
 * behaviour and it is also why the mount order cannot be got wrong silently.
 *
 * ## What this handler does and does not do
 *
 * It records and returns. §10.8 asks a receiver to answer 2xx quickly and queue
 * the processing, and the reason is not latency: applying a decision means reading
 * posts, planning enforcement and writing several collections, and a receiver that
 * did all that inline would time out under a burst and be retried while the first
 * attempt was still running. So the event and a durable `decision.apply` outbox row
 * commit in ONE transaction, and the dispatcher does the work.
 *
 * Nothing here is authenticated by Oxy. The HMAC IS the authentication (§10.8), and
 * an Oxy session must never satisfy this route — it is not a user endpoint.
 */
/**
 * One string field out of an event payload this version does not know.
 *
 * `WebhookEventEnvelope.data` is deliberately OPAQUE in the contract: an
 * unrecognised event's payload is whatever a newer CrowdSource decided to send, and
 * since 0.2.0 the exported type says so — property access on it does not compile.
 * That is the contract being honest rather than an obstacle, so this reads the key
 * defensively instead of asserting a shape nobody has verified. Anything that is not
 * a string is treated as absent, which is the only safe reading of a field this
 * deployment has never seen.
 */
function stringField(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const value: unknown = Reflect.get(source, key);
  return typeof value === 'string' ? value : undefined;
}

export function createCrowdSourceWebhookRoutes(): Router {
  const router = Router();

  const secret = config.crowdSource.webhookSecret;
  if (!secret) {
    /**
     * Not mounted, rather than mounted and permissive.
     *
     * A route that answers anything at all without a secret is a route that will
     * one day be reasoned about as if it verified something. An unconfigured
     * deployment 404s here, which is indistinguishable from not having the feature
     * — which is exactly what it is.
     */
    logger.info('[CrowdSource] webhook route not mounted: no CROWDSOURCE_WEBHOOK_SECRET');
    return router;
  }

  router.post(
    '/crowdsource',
    crowdsourceWebhooks({
      secret,
      ...(config.crowdSource.webhookPreviousSecret === undefined
        ? {}
        : { previousSecret: config.crowdSource.webhookPreviousSecret }),
      // Shared across ECS tasks: the in-process default would dedupe only the
      // instance that happened to receive both copies of a redelivery.
      store: moderationProcessedEventStore(),
      on: {
        /**
         * A decision, provisional or final. Both are queued: a provisional decision
         * is real (§9.6) and Mention records it; what it may ACT on is decided by
         * the enforcement mode, not by discarding the event here.
         */
        'case.decided': async (event) => {
          await recordDecisionEvent({
            eventId: event.id,
            type: event.type,
            caseId: event.data.caseId,
            decision: event.data.decision,
          });
        },
        /**
         * A later revision replacing an earlier one (§10.6). The SAME path: the
         * decision worker compares revisions and the enforcement service reverses
         * what the superseded revision did. A correction is not a special case with
         * its own code — it is an ordinary decision that supersedes another, and
         * giving it a separate path is how a restore ends up not being idempotent.
         */
        'decision.corrected': async (event) => {
          await recordDecisionEvent({
            eventId: event.id,
            type: event.type,
            caseId: event.data.caseId,
            decision: event.data.decision,
          });
        },
        /**
         * An appeal's outcome carries a decision too, and it is the current answer
         * for the case, so it takes the same path.
         */
        'appeal.decided': async (event) => {
          await recordDecisionEvent({
            eventId: event.id,
            type: event.type,
            caseId: event.data.caseId,
            decision: event.data.decision,
          });
        },
      },
      /**
       * Every other event type — including one this version of the contracts
       * package has never heard of (§10.11).
       *
       * Recorded rather than dropped. `case.created`, `case.escalated` and
       * `case.closed` carry no decision and nothing to enforce, but "did CrowdSource
       * tell us about this case, and when" is the first question asked when a report
       * appears stuck, and the answer has to exist somewhere.
       */
      onUnhandled: async (event) => {
        await recordIgnoredEvent({
          eventId: event.id,
          type: event.type,
          caseId: stringField(event.data, 'caseId'),
        });
      },
      /**
       * A refusal reason and nothing else — never a body, a header or a signature
       * (§10.8's last line). It is a bounded label, so it can be a metric.
       */
      onRejected: (rejection) => {
        metrics.incrementCounter('crowdsource_webhook_rejected_total', 1, { rejection });
        logger.warn('[CrowdSource] webhook delivery refused', { rejection });
      },
    }),
  );

  return router;
}
