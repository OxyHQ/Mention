import { TRawNotification } from '../types/validation';

/**
 * Types that should be grouped when they share the same target entity.
 * Mentions and replies are kept individual since they carry unique content.
 */
const GROUPABLE_TYPES = new Set(['like', 'boost', 'follow', 'quote']);

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
    username?: string;
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
  /**
   * Whether the row can reveal more than the collapsed actor strip shows — true
   * when there are more unique actors than the (capped) `actors` array, or when
   * the group collapses multiple notifications from the same actor(s). Drives the
   * "Show all / Show less" affordance on the unified row.
   */
  expandable: boolean;
}

/**
 * A single item in the RENDERED notifications list. The screen interleaves
 * lightweight time-bucket section headers ("Today" / "This week" / "Earlier")
 * between the grouped notification rows, so the virtualizers (web + native)
 * receive a union rather than a bare {@link GroupedNotification}. Headers are a
 * pure presentation layer inserted at bucket boundaries; each carries a stable
 * `key` for the list, and rows keep every `GroupedNotification` field directly
 * (via the intersection) so `renderRow` can pass a row straight to
 * `NotificationItem`.
 */
export type NotificationListItem =
  | { kind: 'header'; key: string; label: string }
  | ({ kind: 'row' } & GroupedNotification);

/**
 * Max actors kept in the {@link GroupedNotification.actors} array. The collapsed
 * strip still shows only the first 3 (+N); the extra entries are revealed by the
 * expandable actor list without any refetch.
 */
const MAX_GROUP_ACTORS = 8;

/**
 * Groups an array of validated notifications.
 *
 * Groupable types (like, boost, follow, quote) that share the same
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
    const entityId = objectId(n.entityId) || String(n.entityId || '');
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

type GroupedActor = GroupedNotification['actors'][number];

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function objectId(value: unknown): string | undefined {
  const object = objectValue(value);
  return object
    ? stringValue(object._id) || stringValue(object.id)
    : stringValue(value);
}

function extractActor(n: TRawNotification): GroupedActor {
  const populated = n.actorId_populated;
  const actorId = objectId(n.actorId) || 'unknown';

  if (populated) {
    const populatedName = objectValue(populated.name);
    // Render the canonical `name.displayName` directly (profile-identity
    // contract); the backend guarantees it on the embedded actor. `actorId` is
    // the never-blank handle floor, NOT a name recompute.
    const name = stringValue(populatedName?.displayName) || actorId;
    return {
      id: actorId,
      name,
      username: populated.username,
      avatar: populated.avatar,
    };
  }

  const actor = objectValue(n.actorId);
  if (actor) {
    const username = stringValue(actor.username);
    const actorName = objectValue(actor.name);
    return {
      id: objectId(actor) || 'unknown',
      name: stringValue(actorName?.displayName) || stringValue(actor.displayName) || username || actorId,
      username,
      avatar: stringValue(actor.avatar),
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
    expandable: false,
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
    expandable: false,
  };
}

function mergeIntoGroup(group: GroupedNotification, n: TRawNotification): void {
  const actor = extractActor(n);

  // Keep track of unique actors (by id)
  const existingIds = new Set(group.actors.map(a => a.id));
  if (!existingIds.has(actor.id)) {
    if (group.actors.length < MAX_GROUP_ACTORS) {
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
  // Expandable when there are more unique actors than we kept, or when the group
  // merges multiple notifications (same actor(s) acting more than once).
  group.expandable = group.totalActors > group.actors.length || group.notificationIds.length > 1;
}
