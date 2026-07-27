import { degradedActorSummary } from './degradedActorSummary';
import { resolveAvatarUrl } from './mediaResolver';

/** Minimal actor shape accepted from Oxy and realtime notification callers. */
export interface NotificationActorProfile {
  id?: string;
  _id?: string;
  username?: string | null;
  name?: { displayName?: string | null } | null;
  displayName?: string | null;
  avatar?: string | null;
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
  if (id === 'system') rawIds.delete('system');

  const username = safeVisualValue(actor?.username, rawIds);
  const resolvedDisplayName = safeVisualValue(
    actor?.name?.displayName ?? actor?.displayName,
    rawIds,
  );

  return {
    _id: id,
    username: username || fallback.username,
    name: {
      displayName: resolvedDisplayName || username || fallback.name.displayName,
    },
    avatar: resolveAvatarUrl(typeof actor?.avatar === 'string' ? actor.avatar : undefined),
  };
}
