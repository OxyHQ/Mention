import type { NotificationsInfiniteData } from '../notificationCache';
import {
  projectNotificationOptimism,
  type NotificationOptimisticOperation,
} from '../notificationOptimism';

function row(id: string, read = false) {
  return {
    _id: id,
    recipientId: 'A',
    actorId: 'system',
    type: 'welcome',
    entityId: '',
    entityType: 'system',
    read,
    createdAt: '2026-11-01T12:00:00Z',
  };
}
function inbox(...pages: ReturnType<typeof row>[][]): NotificationsInfiniteData {
  return {
    pages: pages.map((notifications) => ({
      notifications,
      unreadCount: notifications.filter((item) => !item.read).length,
      hasMore: false,
      limit: 20,
    })),
    pageParams: pages.map(() => undefined),
  };
}
function op(
  kind: NotificationOptimisticOperation['kind'],
  ids: string[],
  viewerId = 'A',
  epoch = 1,
): NotificationOptimisticOperation {
  return { kind, ids, viewerId, epoch };
}
const state = (
  data: NotificationsInfiniteData,
  unread: number,
  operations: NotificationOptimisticOperation[],
  viewerId = 'A',
  epoch = 1,
) => projectNotificationOptimism(data, unread, operations, { viewerId, epoch });

it('returns authoritative data unchanged when no current operation applies', () => {
  const data = inbox([row('one')]);
  expect(state(data, 1, []).data).toBe(data);
  expect(state(data, 1, [op('read', ['one'], 'B')]).data).toBe(data);
  expect(state(data, 1, [op('read', ['one'], 'A', 0)]).data).toBe(data);
});

it('projects independent writes without mutating the authoritative cache', () => {
  const data = inbox([row('one'), row('two')]);
  const projected = state(data, 2, [op('read', ['one']), op('read', ['two'])]);
  expect(projected.data?.pages[0].notifications.map((item) => item.read)).toEqual([true, true]);
  expect(projected.unread).toBe(0);
  expect(data.pages[0].notifications.map((item) => item.read)).toEqual([false, false]);
});

it('removing a rejected operation keeps another success and its badge contribution', () => {
  const authoritative = inbox([row('one'), row('two', true)]);
  const projected = state(authoritative, 1, []);
  expect(projected.data?.pages[0].notifications.map((item) => item.read)).toEqual([false, true]);
  expect(projected.unread).toBe(1);
});

it('deduplicates overlapping group read and delete operations for the badge', () => {
  const data = inbox([row('one'), row('two'), row('three')]);
  const projected = state(data, 3, [
    op('read', ['one', 'two', 'one']),
    op('delete', ['two', 'three']),
  ]);
  expect(projected.data?.pages[0].notifications.map((item) => [item._id, item.read])).toEqual([
    ['one', true],
  ]);
  expect(projected.unread).toBe(0);
});

it('projects mark-all only over observed IDs, leaving new and later-paginated rows unread', () => {
  const data = inbox([row('new'), row('one'), row('two')], [row('later-page')]);
  const projected = state(data, 11, [op('read-all', ['one', 'two'])]);
  expect(
    projected.data?.pages.flatMap((page) =>
      page.notifications.map((item) => [item._id, item.read]),
    ),
  ).toEqual([
    ['new', false],
    ['one', true],
    ['two', true],
    ['later-page', false],
  ]);
  expect(projected.unread).toBe(9);
});

it('respects authoritative realtime changes while an operation is pending', () => {
  const changed = inbox([row('one'), row('two', true), row('new')]);
  const projected = state(changed, 2, [op('read', ['one']), op('delete', ['two'])]);
  expect(projected.data?.pages[0].notifications.map((item) => [item._id, item.read])).toEqual([
    ['one', true],
    ['new', false],
  ]);
  expect(projected.unread).toBe(1);
});

it('does not project an offline operation after a same-user session replacement or ABA', () => {
  const data = inbox([row('one')]);
  const pending = [op('read', ['one'], 'A', 1)];
  expect(state(data, 1, pending, 'A', 2)).toEqual({ data, unread: 1 });
  expect(state(data, 1, pending, 'B', 2)).toEqual({ data, unread: 1 });
  expect(state(data, 1, pending, 'A', 3)).toEqual({ data, unread: 1 });
});

it('keeps a partially confirmed group in the authoritative base after its rejected overlay ends', () => {
  const base = inbox([row('one'), row('two', true)]);
  const pending = [op('read', ['one', 'two'])];
  expect(state(base, 1, pending).unread).toBe(0);
  const reconciled = state(base, 1, []);
  expect(reconciled.data?.pages[0].notifications.map((item) => item.read)).toEqual([false, true]);
  expect(reconciled.unread).toBe(1);
});

it('counts duplicate pending operations only once and never changes unrelated pages', () => {
  const base = inbox([row('one')], [row('untouched')]);
  const projected = state(base, 2, [op('read', ['one']), op('delete', ['one'])]);
  expect(projected.unread).toBe(1);
  expect(projected.data?.pages[1]).toBe(base.pages[1]);
});

it('keeps new realtime arrivals visible during an older mark-all and concurrent delete', () => {
  const base = inbox([row('new'), row('one'), row('two')]);
  const pending = [op('read-all', ['one', 'two']), op('delete', ['two'])];
  const projected = state(base, 3, pending);
  expect(projected.data?.pages[0].notifications.map((item) => [item._id, item.read])).toEqual([
    ['new', false],
    ['one', true],
  ]);
  expect(projected.unread).toBe(1);
});

it('does not invent a badge adjustment when the affected rows are not in the cache', () => {
  const pending = [op('read-all', ['one'])];
  expect(projectNotificationOptimism(undefined, 9, pending, { viewerId: 'A', epoch: 1 })).toEqual({
    data: undefined,
    unread: 9,
  });
});
