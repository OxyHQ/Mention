/**
 * Subscribes to Oxy's user-invalidation broadcast and drops this task's cached
 * copies of the user that changed.
 *
 * WHY THIS EXISTS — Oxy owns identity; Mention caches it. A display-name or
 * avatar edit in Oxy was invisible here for up to the {@link userSummaryCache}
 * TTL (10 minutes by default), to EVERY viewer rather than just the editor,
 * because nothing told Mention the write had happened. oxy-api now publishes on
 * {@link OXY_USER_INVALIDATION_CHANNEL} whenever a user's identity changes, and
 * this is the consumer half.
 *
 * WHAT IT DROPS, and why all three:
 *  - the Redis {@link userSummaryCache} entry — the shared, cross-task copy that
 *    `PostHydrationService` reads for every post author;
 *  - the GET response cache of BOTH process-level Oxy clients (service and
 *    runtime). Those are per-PROCESS in-memory caches inside `@oxyhq/core`, so
 *    the Redis eviction alone would leave each task serving its own stale copy
 *    of `GET /users/:id` for another five minutes.
 *
 * RUNS ON EVERY TASK, deliberately not leader-gated. The Redis `DEL` is
 * idempotent and cheap, and the SDK caches above are per-process — a leader-only
 * subscriber would leave every other task stale, and leader-gating would add a
 * failure mode (leader down means no invalidation anywhere) to a signal whose
 * whole point is that losing it is merely slow, never wrong.
 *
 * FAILURE POSTURE — inert, never fatal. No `REDIS_URL`, a refused connection or
 * a failed subscribe all degrade to "no push signal", which is exactly the
 * behaviour before this existed: entries simply age out via TTL. Nothing here
 * may throw into server startup.
 */

import { OXY_USER_INVALIDATION_CHANNEL } from '@oxyhq/contracts';
import {
  createOxyUserInvalidationHandler,
  type OxyIdentityCacheEvictor,
} from '@oxyhq/core/server';

import { getRuntimeOxyClient } from '../runtime/oxyClient';
import { createRedisPubSub } from '../utils/redis';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { logger } from '../utils/logger';
import { invalidate as invalidateUserSummaries } from './userSummaryCache';

/** Handle for shutting the subscriber down. */
export interface UserInvalidationSubscriber {
  stop: () => Promise<void>;
}

/**
 * Fan one eviction out to both process-level Oxy clients.
 *
 * They are separate `OxyServices` instances (service-token vs public runtime)
 * and therefore hold SEPARATE response caches, so an invalidation that swept
 * only one would leave the other answering from a stale entry. Resolved lazily
 * per event: `getRuntimeOxyClient` constructs on first use, and building it at
 * module load would drag the Oxy runtime into every importer.
 */
function bothOxyClients(): OxyIdentityCacheEvictor {
  return {
    clearCacheEntry: (key) => {
      getServiceOxyClient().clearCacheEntry(key);
      getRuntimeOxyClient().clearCacheEntry(key);
    },
    clearCacheByPrefix: (prefix) => {
      getServiceOxyClient().clearCacheByPrefix(prefix);
      return getRuntimeOxyClient().clearCacheByPrefix(prefix);
    },
  };
}

/**
 * Connect a dedicated subscriber and start applying invalidations.
 *
 * Returns `null` when no subscription could be established — the caller keeps
 * running without the push signal rather than failing to boot.
 */
export async function startUserInvalidationSubscriber(): Promise<UserInvalidationSubscriber | null> {
  // A subscribed Redis connection cannot issue ordinary commands, so this needs
  // its own client rather than sharing the one `userSummaryCache` writes through.
  const { publisher, subscriber } = createRedisPubSub();

  try {
    await subscriber.connect();

    await subscriber.subscribe(
      OXY_USER_INVALIDATION_CHANNEL,
      createOxyUserInvalidationHandler({
        oxy: bothOxyClients(),
        onInvalidate: (event) => invalidateUserSummaries([event.userId]),
        onError: (error, raw) => {
          logger.warn('[UserInvalidation] dropped an invalidation message', {
            reason: error instanceof Error ? error.message : String(error),
            // Bounded: the payload is an id and a reason, never user content.
            raw: raw.slice(0, 200),
          });
        },
      }),
    );

    // Asserted by the deploy gate — a subscriber that silently failed to attach
    // is indistinguishable from one that attached and received nothing, so the
    // only evidence that the signal is live is this line appearing per task.
    logger.info('[UserInvalidation] subscriber enabled', {
      channel: OXY_USER_INVALIDATION_CHANNEL,
    });

    return {
      stop: async () => {
        await Promise.allSettled([
          subscriber.isOpen ? subscriber.unsubscribe(OXY_USER_INVALIDATION_CHANNEL) : undefined,
        ]);
        await Promise.allSettled([
          subscriber.isOpen ? subscriber.quit() : undefined,
          publisher.isOpen ? publisher.quit() : undefined,
        ]);
      },
    };
  } catch (error: unknown) {
    await Promise.allSettled([
      subscriber.isOpen ? subscriber.quit() : undefined,
      publisher.isOpen ? publisher.quit() : undefined,
    ]);
    logger.warn('[UserInvalidation] subscriber unavailable; identity stays TTL-bound', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
