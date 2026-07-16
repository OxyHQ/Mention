import { logger } from '../utils/logger';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { connectorRegistry } from './index';
import type { LocalNetworkEvent } from './types';

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
  buildEvent: (username: string) => LocalNetworkEvent,
): void {
  void (async () => {
    const user = await getServiceOxyClient().getUserById(actorOxyUserId);
    const username = user.username?.trim();
    if (!username) {
      logger.warn(`[Federation] skipping ${context} federation for ${actorOxyUserId}: no resolvable username`);
      return;
    }
    await connectorRegistry.deliver(buildEvent(username));
  })().catch((err) => {
    logger.error(`[Federation] failed to federate ${context}`, err);
  });
}
