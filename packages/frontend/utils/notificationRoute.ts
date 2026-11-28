import type { Href } from '@/lib/navigation/router';

interface NotificationSubject {
  type?: string;
  entityType?: string;
  entityId?: string;
}

/**
 * The screen a notification opens when it names its subject by id: an event
 * or a post. `null` for anything else — a profile notification is reached by
 * its actor's handle, which only the caller that resolved the actor knows.
 *
 * One mapping for the in-app row and the push tap, so the two never disagree
 * about where the same notification leads.
 */
export function notificationSubjectHref({
  type,
  entityType,
  entityId,
}: NotificationSubject): Href | null {
  if (!entityId) return null;
  if (type === 'event_updated' || type === 'event_cancelled') return `/events/${entityId}`;
  if (entityType === 'post' || entityType === 'reply') return `/p/${entityId}`;
  return null;
}
