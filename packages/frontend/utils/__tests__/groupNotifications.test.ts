import type { TRawNotification } from '@/types/validation';
import { GROUPABLE_TYPES, groupNotifications } from '../groupNotifications';

const HOUR_MS = 60 * 60 * 1000;
const WINDOW_MS = 24 * HOUR_MS;

/** Fixed clock so "recent" and "old" are unambiguous distances, not wall time. */
const NOW = Date.parse('2026-07-29T12:00:00.000Z');

function at(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

/**
 * Only the fields `groupNotifications` reads. `actorId` / `entityId` are `z.any()`
 * on the wire and a bare id string is one of the shapes the backend sends, so the
 * fixture uses it directly rather than a full populated actor.
 */
function notification(fields: {
  id: string;
  type: string;
  entityId: string;
  actorId: string;
  createdAt: string;
  read?: boolean;
  /** Defaults to the viewer; a channel id models a row from an inbox they operate. */
  recipientId?: string;
}): TRawNotification {
  return {
    _id: fields.id,
    recipientId: fields.recipientId ?? 'viewer',
    actorId: fields.actorId,
    type: fields.type,
    entityId: fields.entityId,
    entityType: fields.type === 'follow' ? 'profile' : 'post',
    read: fields.read ?? true,
    createdAt: fields.createdAt,
  };
}

/** The notification ids each emitted row collapsed, in emission order. */
function idsPerRow(rows: { notificationIds: string[] }[]): string[][] {
  return rows.map((row) => row.notificationIds);
}

describe('groupNotifications', () => {
  // One case per groupable type, driven off the module's own set so a newly
  // groupable type cannot slip through uncovered.
  it.each([...GROUPABLE_TYPES])(
    'emits both windows when %s notifications on one entity span more than the group window',
    (type) => {
      const rows = groupNotifications([
        // Newest-first, the order the screen feeds in.
        notification({ id: 'recent-a', type, entityId: 'entity-1', actorId: 'actor-a', createdAt: at(0) }),
        notification({ id: 'recent-b', type, entityId: 'entity-1', actorId: 'actor-b', createdAt: at(HOUR_MS) }),
        notification({ id: 'old-a', type, entityId: 'entity-1', actorId: 'actor-c', createdAt: at(3 * WINDOW_MS) }),
        notification({ id: 'old-b', type, entityId: 'entity-1', actorId: 'actor-d', createdAt: at(3 * WINDOW_MS + HOUR_MS) }),
      ]);

      // The recent window is the one a naive keyed accumulator overwrites, and it
      // is the one the user cares about most.
      expect(idsPerRow(rows)).toEqual([
        ['recent-a', 'recent-b'],
        ['old-a', 'old-b'],
      ]);
    },
  );

  it('keeps every window of every entity when several entities each span more than the window', () => {
    const rows = groupNotifications([
      notification({ id: 'p1-recent', type: 'like', entityId: 'post-1', actorId: 'actor-a', createdAt: at(0) }),
      notification({ id: 'p2-recent', type: 'like', entityId: 'post-2', actorId: 'actor-b', createdAt: at(HOUR_MS) }),
      notification({ id: 'p1-old', type: 'like', entityId: 'post-1', actorId: 'actor-c', createdAt: at(2 * WINDOW_MS) }),
      notification({ id: 'p2-old', type: 'like', entityId: 'post-2', actorId: 'actor-d', createdAt: at(2 * WINDOW_MS + HOUR_MS) }),
    ]);

    expect(idsPerRow(rows)).toEqual([['p1-recent'], ['p2-recent'], ['p1-old'], ['p2-old']]);
  });

  it('gives each window of one entity a distinct list key', () => {
    // The notifications screen de-dupes rows by `key`, so two windows sharing a
    // key lose one row on render even when grouping emitted both.
    const rows = groupNotifications([
      notification({ id: 'recent', type: 'like', entityId: 'post-1', actorId: 'actor-a', createdAt: at(0) }),
      notification({ id: 'old', type: 'like', entityId: 'post-1', actorId: 'actor-b', createdAt: at(2 * WINDOW_MS) }),
    ]);

    const keys = rows.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(2);
  });

  it('orders the emitted rows most recent first by each row lead notification', () => {
    const rows = groupNotifications([
      notification({ id: 'like-recent', type: 'like', entityId: 'post-1', actorId: 'actor-a', createdAt: at(0) }),
      notification({ id: 'reply', type: 'reply', entityId: 'post-9', actorId: 'actor-e', createdAt: at(WINDOW_MS) }),
      notification({ id: 'boost', type: 'boost', entityId: 'post-2', actorId: 'actor-f', createdAt: at(2 * WINDOW_MS) }),
      notification({ id: 'like-old', type: 'like', entityId: 'post-1', actorId: 'actor-b', createdAt: at(4 * WINDOW_MS) }),
    ]);

    expect(rows.map((row) => row.createdAt)).toEqual([at(0), at(WINDOW_MS), at(2 * WINDOW_MS), at(4 * WINDOW_MS)]);
    expect(idsPerRow(rows)).toEqual([['like-recent'], ['reply'], ['boost'], ['like-old']]);
  });

  it('keeps each window actors and unread flag to itself', () => {
    const rows = groupNotifications([
      notification({ id: 'recent-a', type: 'like', entityId: 'post-1', actorId: 'actor-a', createdAt: at(0), read: true }),
      notification({ id: 'old-a', type: 'like', entityId: 'post-1', actorId: 'actor-b', createdAt: at(2 * WINDOW_MS), read: false }),
      notification({ id: 'old-b', type: 'like', entityId: 'post-1', actorId: 'actor-c', createdAt: at(2 * WINDOW_MS + HOUR_MS), read: true }),
    ]);

    expect(rows.map((row) => ({ ids: row.notificationIds, actors: row.actors.map((a) => a.id), hasUnread: row.hasUnread, isGroup: row.isGroup }))).toEqual([
      { ids: ['recent-a'], actors: ['actor-a'], hasUnread: false, isGroup: false },
      { ids: ['old-a', 'old-b'], actors: ['actor-b', 'actor-c'], hasUnread: true, isGroup: true },
    ]);
  });

  it('collapses notifications on one entity inside the window into a single row', () => {
    const rows = groupNotifications([
      notification({ id: 'a', type: 'like', entityId: 'post-1', actorId: 'actor-a', createdAt: at(0) }),
      notification({ id: 'b', type: 'like', entityId: 'post-1', actorId: 'actor-b', createdAt: at(HOUR_MS) }),
      notification({ id: 'c', type: 'like', entityId: 'post-1', actorId: 'actor-c', createdAt: at(2 * HOUR_MS) }),
    ]);

    expect(idsPerRow(rows)).toEqual([['a', 'b', 'c']]);
    expect(rows[0].totalActors).toBe(3);
    expect(rows[0].createdAt).toBe(at(0));
  });

  it('leaves non-groupable types as individual rows even on one entity', () => {
    const rows = groupNotifications([
      notification({ id: 'reply-a', type: 'reply', entityId: 'post-1', actorId: 'actor-a', createdAt: at(0) }),
      notification({ id: 'reply-b', type: 'reply', entityId: 'post-1', actorId: 'actor-b', createdAt: at(HOUR_MS) }),
      notification({ id: 'mention', type: 'mention', entityId: 'post-1', actorId: 'actor-c', createdAt: at(2 * HOUR_MS) }),
    ]);

    expect(idsPerRow(rows)).toEqual([['reply-a'], ['reply-b'], ['mention']]);
    expect(rows.every((row) => row.isGroup)).toBe(false);
  });

  it('returns nothing for an empty list', () => {
    expect(groupNotifications([])).toEqual([]);
  });

  describe('inboxes do not merge into one another', () => {
    // The list carries rows addressed to the viewer alongside rows addressed to a
    // CHANNEL they operate (a channel has no session of its own). `type:'follow'`
    // stores the FOLLOWER in `entityId`, so one person following both the viewer
    // and their channel produces two rows identical in type and entityId — keyed
    // on those alone they collapse into one and the channel's follow disappears.
    it('keeps the same actor following the viewer and their channel apart', () => {
      const rows = groupNotifications([
        notification({
          id: 'follow-me', type: 'follow', entityId: 'actor-a', actorId: 'actor-a', createdAt: at(0),
        }),
        notification({
          id: 'follow-channel', type: 'follow', entityId: 'actor-a', actorId: 'actor-a',
          createdAt: at(HOUR_MS), recipientId: 'channel-1',
        }),
      ]);

      expect(idsPerRow(rows)).toEqual([['follow-me'], ['follow-channel']]);
    });

    it('still groups within ONE inbox (control)', () => {
      // Without this, the case above would also pass if grouping had simply been
      // switched off altogether.
      const rows = groupNotifications([
        notification({
          id: 'a', type: 'like', entityId: 'post-1', actorId: 'actor-a',
          createdAt: at(0), recipientId: 'channel-1',
        }),
        notification({
          id: 'b', type: 'like', entityId: 'post-1', actorId: 'actor-b',
          createdAt: at(HOUR_MS), recipientId: 'channel-1',
        }),
      ]);

      expect(idsPerRow(rows)).toEqual([['a', 'b']]);
    });
  });
});
