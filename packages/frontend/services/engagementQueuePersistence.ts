const ENGAGEMENT_QUEUE_KEY_PREFIX = 'mention-engagement-queue:v2';

export interface PersistedEngagementQueue<T> {
  version: 2;
  viewerId: string;
  updates: Record<string, T[]>;
}

export function engagementQueueStorageKey(viewerId: string): string {
  return `${ENGAGEMENT_QUEUE_KEY_PREFIX}:${encodeURIComponent(viewerId)}`;
}

export function serializeEngagementQueue<T>(
  viewerId: string,
  updates: Record<string, T[]>,
): string {
  const envelope: PersistedEngagementQueue<T> = {
    version: 2,
    viewerId,
    updates,
  };
  return JSON.stringify(envelope);
}

/**
 * Decode only a queue explicitly owned by the expected viewer.
 *
 * Returning `null` for legacy/unscoped payloads is intentional. Engagement
 * records include viewer-dependent flags, so guessing ownership is unsafe.
 */
export function parseEngagementQueue<T>(
  raw: string,
  expectedViewerId: string,
): Record<string, T[]> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const envelope = parsed as Partial<PersistedEngagementQueue<T>>;
  if (
    envelope.version !== 2 ||
    envelope.viewerId !== expectedViewerId ||
    !envelope.updates ||
    typeof envelope.updates !== 'object' ||
    Array.isArray(envelope.updates)
  ) {
    return null;
  }

  const safeUpdates: Record<string, T[]> = {};
  for (const [postId, updates] of Object.entries(envelope.updates)) {
    if (postId && Array.isArray(updates) && updates.length > 0) {
      safeUpdates[postId] = updates;
    }
  }
  return safeUpdates;
}
