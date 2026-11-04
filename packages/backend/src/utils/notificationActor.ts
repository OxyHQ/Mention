import type { AccountKind, AvatarCharacter } from '@oxy.so/contracts';
import type { PostUser } from '@mention/shared-types';
import { SYSTEM_NOTIFICATION_ACTOR_ID } from '@mention/shared-types/notification';
import { isFallbackUserSummary, resolveUserSummaries } from '../services/PostHydrationService';
import { degradedActorSummary } from './degradedActorSummary';
import { logger } from './logger';
import { resolveAvatarUrl } from './mediaResolver';

/** Minimal actor shape accepted from Oxy and realtime notification callers. */
export interface NotificationActorProfile {
  id?: string;
  _id?: string;
  username?: string | null;
  name?: { displayName?: string | null } | null;
  displayName?: string | null;
  avatar?: string | null;
  kind?: AccountKind;
  character?: AvatarCharacter | null;
}

/** The synthetic actor of server-authored notifications; it is not an Oxy account. */
const SYSTEM_ACTOR: PostUser = {
  id: SYSTEM_NOTIFICATION_ACTOR_ID,
  username: 'system',
  name: { displayName: 'System' },
};

/**
 * Public profiles for notification actors (and the channels and people a
 * notification surface names), through the shared Redis user-summary cache —
 * the ONE resolver behind the notification list, mark-read, the socket event,
 * the push body and the pokes lists, so none of them asks Oxy for an identity
 * the cache already holds.
 *
 * The synthetic `system` actor is answered here and never sent to Oxy. An id
 * Oxy could not resolve is left OUT, so the caller renders its neutral
 * identity. Never rejects: every caller treats the actor as best-effort.
 */
export async function resolveActorProfiles(ids: Iterable<string>): Promise<Map<string, PostUser>> {
  const profiles = new Map<string, PostUser>();
  const oxyIds: string[] = [];
  for (const id of new Set(ids)) {
    if (id === SYSTEM_NOTIFICATION_ACTOR_ID) profiles.set(id, SYSTEM_ACTOR);
    else if (id) oxyIds.push(id);
  }
  if (oxyIds.length === 0) return profiles;
  try {
    for (const [id, summary] of await resolveUserSummaries(oxyIds)) {
      if (!isFallbackUserSummary(summary.user)) profiles.set(id, summary.user);
    }
  } catch (error) {
    logger.warn('[Notifications] Failed to resolve actor profiles', {
      count: oxyIds.length,
      error,
    });
  }
  return profiles;
}

function safeVisualValue(value: unknown, rawIds: Set<string>): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized && !rawIds.has(normalized) ? normalized : '';
}

/**
 * Serialize the actor embedded in notification responses and socket events.
 * Resolution misses and outages use the same neutral identity as post
 * hydration; the raw id is never copied into a visual field.
 */
export function toPopulatedActor(
  actor: NotificationActorProfile | null | undefined,
  fallbackId: unknown,
) {
  const id = String(actor?.id || actor?._id || fallbackId || '');
  const fallback = degradedActorSummary(id);
  const rawIds = new Set([id, String(fallbackId || '')].filter(Boolean));

  // `system` is a synthetic actor name, not an Oxy identifier.
  if (id === SYSTEM_NOTIFICATION_ACTOR_ID) rawIds.delete(SYSTEM_NOTIFICATION_ACTOR_ID);

  const username = safeVisualValue(actor?.username, rawIds);
  const resolvedDisplayName = safeVisualValue(
    actor?.name?.displayName ?? actor?.displayName,
    rawIds,
  );

  return {
    _id: id,
    kind: actor?.kind,
    character: actor?.character,
    username: username || fallback.username,
    name: {
      displayName: resolvedDisplayName || username || fallback.name.displayName,
    },
    avatar: resolveAvatarUrl(typeof actor?.avatar === 'string' ? actor.avatar : undefined),
  };
}
