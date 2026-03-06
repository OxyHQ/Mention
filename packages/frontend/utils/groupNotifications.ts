import { TRawNotification } from '../types/validation';

/**
 * Types that should be grouped when they share the same target entity.
 * Mentions and replies are kept individual since they carry unique content.
 */
const GROUPABLE_TYPES = new Set(['like', 'repost', 'follow', 'quote']);

/**
 * Time window (in ms) within which notifications of the same type+entity
 * are collapsed into a single grouped item.  Default: 24 hours.
 */
const GROUP_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface GroupedNotification {
  /** Stable key for React lists */
  key: string;
  /** The notification type shared by the group */
  type: string;
  /** The entityId all notifications in the group refer to */
  entityId: string;
  /** The entityType all notifications in the group refer to */
  entityType: string;
  /** Whether any notification in the group is unread */
  hasUnread: boolean;
  /** The most recent createdAt timestamp */
  createdAt: string;
  /** Up to 3 most-recent actor objects (for avatar display) */
  actors: {
    id: string;
    name: string;
    avatar?: string;
  }[];
  /** Total number of unique actors in this group */
  totalActors: number;
  /** The IDs of all individual notifications in this group (for mark-as-read) */
  notificationIds: string[];
  /** The "lead" notification (most recent) for fallback rendering */
  leadNotification: TRawNotification;
  /** Whether this is a group (true) or a single notification (false) */
  isGroup: boolean;
}

/**
 * Groups an array of validated notifications.
 *
 * Groupable types (like, repost, follow, quote) that share the same
 * (type + entityId) and fall within the time window are merged.
 *
 * Non-groupable types (mention, reply, post, welcome, poke) remain individual.
 *
 * The returned array preserves chronological order (most recent first) based
 * on the lead notification of each group.
 */
export function groupNotifications(
  notifications: TRawNotification[],
  windowMs: number = GROUP_WINDOW_MS,
): GroupedNotification[] {
  if (!notifications || notifications.length === 0) return [];

  const groups = new Map<string, GroupedNotification>();
  const singles: GroupedNotification[] = [];

  for (const n of notifications) {
    // Non-groupable types stay as individual items
    if (!GROUPABLE_TYPES.has(n.type)) {
      singles.push(toSingle(n));
      continue;
    }

    // Build a group key from type + entityId
    const entityId = typeof n.entityId === 'object' && n.entityId !== null
      ? (n.entityId as any)._id || String(n.entityId)
      : String(n.entityId || '');
    const groupKey = `${n.type}:${entityId}`;

    const existing = groups.get(groupKey);

    if (existing) {
      // Check time window — compare against the lead (most recent) notification
      const existingTime = new Date(existing.createdAt).getTime();
      const currentTime = new Date(n.createdAt).getTime();
      const timeDiff = Math.abs(existingTime - currentTime);

      if (timeDiff <= windowMs) {
        // Merge into existing group
        mergeIntoGroup(existing, n);
        continue;
      }
    }

    // Start a new group
    const group = toGroup(n, groupKey, entityId);
    groups.set(groupKey, group);
  }

  // Combine groups and singles, sort by createdAt descending
  const all: GroupedNotification[] = [...groups.values(), ...singles];
  all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return all;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractActor(n: TRawNotification): { id: string; name: string; avatar?: string } {
  const populated = n.actorId_populated;
  const actorId = typeof n.actorId === 'string'
    ? n.actorId
    : (n.actorId as any)?._id || String(n.actorId || 'unknown');

  if (populated) {
    const name = typeof populated.name === 'string'
      ? populated.name
      : (populated.name as any)?.full || populated.username || actorId;
    return { id: actorId, name, avatar: populated.avatar };
  }

  if (typeof n.actorId === 'object' && n.actorId !== null) {
    const obj = n.actorId as any;
    return {
      id: obj._id || obj.id || 'unknown',
      name: obj.name?.full || obj.name || obj.username || actorId,
      avatar: obj.avatar,
    };
  }

  return { id: actorId, name: actorId };
}

function toSingle(n: TRawNotification): GroupedNotification {
  const actor = extractActor(n);
  return {
    key: n._id,
    type: n.type,
    entityId: String(n.entityId || ''),
    entityType: n.entityType,
    hasUnread: !n.read,
    createdAt: n.createdAt,
    actors: [actor],
    totalActors: 1,
    notificationIds: [n._id],
    leadNotification: n,
    isGroup: false,
  };
}

function toGroup(n: TRawNotification, groupKey: string, entityId: string): GroupedNotification {
  const actor = extractActor(n);
  return {
    key: `group:${groupKey}`,
    type: n.type,
    entityId,
    entityType: n.entityType,
    hasUnread: !n.read,
    createdAt: n.createdAt,
    actors: [actor],
    totalActors: 1,
    notificationIds: [n._id],
    leadNotification: n,
    isGroup: false, // will flip to true when 2nd notification merges
  };
}

function mergeIntoGroup(group: GroupedNotification, n: TRawNotification): void {
  const actor = extractActor(n);

  // Keep track of unique actors (by id)
  const existingIds = new Set(group.actors.map(a => a.id));
  if (!existingIds.has(actor.id)) {
    if (group.actors.length < 3) {
      group.actors.push(actor);
    }
    group.totalActors += 1;
  }

  group.notificationIds.push(n._id);

  if (!n.read) {
    group.hasUnread = true;
  }

  // Update lead notification if this one is more recent
  if (new Date(n.createdAt).getTime() > new Date(group.createdAt).getTime()) {
    group.createdAt = n.createdAt;
    group.leadNotification = n;
  }

  group.isGroup = true;
}
