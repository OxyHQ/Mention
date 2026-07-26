import type { PostContent } from '@mention/shared-types';
import type { LocalNetworkEvent } from '@oxyhq/federation';
import { logger } from '../utils/logger';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { connectorRegistry } from './index';

/**
 * Fire-and-forget outbound federation for a local interaction, through the
 * connector seam (which applies the per-user `fediverseSharing` gate; the
 * connector re-checks it too).
 *
 * The acting user's username is resolved SERVER-SIDE from the authoritative
 * `oxyUserId`: the Oxy auth middleware runs without `loadUser`, so
 * `req.user.username` is never populated and must not be trusted. Once resolved,
 * `buildEvent(username)` produces the concrete {@link LocalNetworkEvent}. NEVER
 * blocks or fails the HTTP response — a resolve miss is logged and skipped, any
 * error is caught.
 *
 * The single resolve-and-deliver entry point for every controller/route that
 * federates a local action (posts create/update/delete, likes, boosts, replies,
 * actor updates), so the username-resolution + gating live in exactly one place.
 */
export function federateAsResolvedActor(
  actorOxyUserId: string,
  context: string,
  buildEvent: (username: string) => LocalNetworkEvent<PostContent>,
): void {
  void federateAsResolvedActorAndWait(
    actorOxyUserId,
    context,
    buildEvent,
    false,
  ).catch((err) => {
    logger.error(`[Federation] failed to federate ${context}`, err);
  });
}

/**
 * Awaitable delivery used by durable workers. A missing username or connector
 * failure rejects so the outbox lease is released for retry.
 */
export async function federateAsResolvedActorAndWait(
  actorOxyUserId: string,
  context: string,
  buildEvent: (username: string) => LocalNetworkEvent<PostContent>,
  strict: boolean = true,
): Promise<void> {
  const user = await getServiceOxyClient().getUserById(actorOxyUserId);
  const username = user.username?.trim();
  if (!username) {
    throw new Error(
      `[Federation] cannot deliver ${context} for ${actorOxyUserId}: no resolvable username`,
    );
  }
  const event = buildEvent(username);
  if (strict) {
    await connectorRegistry.deliverStrict(event);
  } else {
    await connectorRegistry.deliver(event);
  }
}
