import type { ProcessedEventStore } from '@crowdsource.you/core/express';
import {
  claimModerationEvent,
  releaseModerationEvent,
} from '../../db/moderation/moderationEventRepository';

/**
 * The webhook dedupe store, as the SDK's `ProcessedEventStore`.
 *
 * `@crowdsource.you/core/express` defaults to an in-process store and says exactly
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
 *
 * ## No duplicate-key error classifier
 *
 * `claimModerationEvent` returns "somebody else has this event" as a VALUE
 * (`ON CONFLICT DO NOTHING … RETURNING`), not as an error to classify — a
 * classifier widened by one condition would read a lost connection as "already
 * processed", the middleware would answer 200, and a decision nobody ever
 * handled would be retired. So the two are not separated by inspecting an
 * exception — anything thrown is genuinely the store failing to
 * answer, and propagates.
 */
export function moderationProcessedEventStore(): ProcessedEventStore {
  return {
    /** True when this call took the claim. */
    async claim(eventId: string): Promise<boolean> {
      return claimModerationEvent(eventId);
    },

    /** Give the claim back so a redelivery can be processed. */
    async release(eventId: string): Promise<void> {
      await releaseModerationEvent(eventId);
    },
  };
}
