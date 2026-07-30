import type { ProcessedEventStore } from '@oxyhq/crowdsource-express';
import ModerationEvent, {
  MODERATION_EVENT_RETENTION_SECONDS,
} from '../../models/ModerationEvent';

/**
 * The webhook dedupe store, in Mongo.
 *
 * `@oxyhq/crowdsource-express` defaults to an in-process store and says exactly
 * when that is not enough: two instances behind a load balancer each keep their
 * own, so a redelivery landing on the other instance is not deduplicated. Mention
 * runs several ECS tasks behind one ALB, so this is that case.
 *
 * The claim/release contract is the store's, and it is the right one. A row
 * inserted BEFORE the handler runs means a concurrent redelivery cannot also run
 * it; deleting that row when the handler THROWS means §10.9's retry schedule can
 * still deliver the event later. Recording the id only after success would let two
 * copies run at once; recording it before and never releasing would make a
 * transient failure permanent and lose a decision silently.
 */

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    Number((error as { code?: unknown }).code) === 11000
  );
}

export function mongoProcessedEventStore(): ProcessedEventStore {
  return {
    /**
     * True when this call took the claim.
     *
     * The insert IS the claim: `_id` is the event id and the index on it is
     * unique, so the duplicate-key error is not an error condition to work around
     * — it is the answer "somebody else has this event".
     */
    async claim(eventId: string): Promise<boolean> {
      const now = new Date();
      try {
        await ModerationEvent.create({
          _id: eventId,
          state: 'claimed',
          receivedAt: now,
          expiresAt: new Date(now.getTime() + MODERATION_EVENT_RETENTION_SECONDS * 1_000),
        });
        return true;
      } catch (error: unknown) {
        if (isDuplicateKeyError(error)) return false;
        // Anything else — a lost connection, a failover — is NOT "already
        // processed". Rethrowing makes the middleware answer non-2xx so the event
        // stays on the sender's retry schedule; swallowing it here would answer
        // 200 and retire a decision nobody ever handled.
        throw error;
      }
    },

    /** Give the claim back so a redelivery can be processed. */
    async release(eventId: string): Promise<void> {
      await ModerationEvent.deleteOne({ _id: eventId });
    },
  };
}
