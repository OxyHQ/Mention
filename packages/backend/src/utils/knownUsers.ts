import type { PostUser } from '@mention/shared-types';
import { SYSTEM_NOTIFICATION_ACTOR_ID } from '@mention/shared-types/notification';
import { isFallbackUserSummary, resolveUserSummaries } from '../services/PostHydrationService';
import { logger } from './logger';

/** The synthetic actor of server-authored notifications; it is not an Oxy account. */
const SYSTEM_ACTOR: PostUser = {
  id: SYSTEM_NOTIFICATION_ACTOR_ID,
  username: 'system',
  name: { displayName: 'System' },
};

/**
 * Public profiles for a set of Oxy ids, through the shared Redis user-summary
 * cache — the ONE cached "who is this" lookup for every surface that renders
 * only the people it can name: notification actors, pokes, trend faces,
 * starter-pack members, an edit's mentions.
 *
 * An id Oxy could not resolve (its degraded placeholder) is left OUT, so the
 * caller drops it or renders its own neutral identity. The synthetic `system`
 * notification actor is answered here and never sent to Oxy. Never rejects:
 * every caller treats identity as best-effort.
 */
export async function resolveKnownUsers(ids: Iterable<string>): Promise<Map<string, PostUser>> {
  const users = new Map<string, PostUser>();
  const oxyIds: string[] = [];
  for (const id of new Set(ids)) {
    if (id === SYSTEM_NOTIFICATION_ACTOR_ID) users.set(id, SYSTEM_ACTOR);
    else if (id) oxyIds.push(id);
  }
  if (oxyIds.length === 0) return users;
  try {
    for (const [id, summary] of await resolveUserSummaries(oxyIds)) {
      if (!isFallbackUserSummary(summary.user)) users.set(id, summary.user);
    }
  } catch (error) {
    logger.warn('[Users] Failed to resolve user profiles', { count: oxyIds.length, error });
  }
  return users;
}
