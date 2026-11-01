import type { NotificationsInfiniteData } from './notificationCache';

/** One pending intent. The ids for `read-all` are captured when it starts. */
export interface NotificationOptimisticOperation {
  kind: 'read' | 'delete' | 'read-all';
  ids: readonly string[];
  viewerId: string;
  epoch: number;
}

/** Count only distinct, currently unread rows covered by a current intent. */
export function countNotificationOptimism(
  data: NotificationsInfiniteData | undefined,
  operations: readonly NotificationOptimisticOperation[],
  scope: { viewerId: string | null | undefined; epoch: number },
): number {
  if (!data || !scope.viewerId || operations.length === 0) return 0;
  const ids = new Set<string>();
  for (const operation of operations) {
    if (operation.viewerId !== scope.viewerId || operation.epoch !== scope.epoch) continue;
    for (const id of operation.ids) ids.add(id);
  }
  if (ids.size === 0) return 0;
  const counted = new Set<string>();
  for (const page of data.pages) {
    for (const notification of page.notifications) {
      if (!notification.read && ids.has(notification._id)) counted.add(notification._id);
    }
  }
  return counted.size;
}

/**
 * Project pending actions without modifying the authoritative query data.
 * `read-all` affects only rows actually observed when it started: a later page
 * or new notification is not evidence that the server included it.
 */
export function projectNotificationOptimism(
  data: NotificationsInfiniteData | undefined,
  unread: number,
  operations: readonly NotificationOptimisticOperation[],
  scope: { viewerId: string | null | undefined; epoch: number },
): { data: NotificationsInfiniteData | undefined; unread: number } {
  if (!data || !scope.viewerId || operations.length === 0) return { data, unread };
  const read = new Set<string>();
  const deleted = new Set<string>();
  for (const operation of operations) {
    if (operation.viewerId !== scope.viewerId || operation.epoch !== scope.epoch) continue;
    const target = operation.kind === 'delete' ? deleted : read;
    for (const id of operation.ids) target.add(id);
  }
  if (read.size === 0 && deleted.size === 0) return { data, unread };

  const counted = new Set<string>();
  let changed = false;
  const pages = data.pages.map((page) => {
    let pageChanged = false;
    const notifications = page.notifications.flatMap((notification) => {
      const isDeleted = deleted.has(notification._id);
      const isRead = read.has(notification._id);
      if (!notification.read && (isDeleted || isRead)) counted.add(notification._id);
      if (isDeleted) {
        pageChanged = true;
        return [];
      }
      if (isRead && !notification.read) {
        pageChanged = true;
        return [{ ...notification, read: true }];
      }
      return [notification];
    });
    if (!pageChanged) return page;
    changed = true;
    return { ...page, notifications };
  });
  return {
    data: changed ? { ...data, pages } : data,
    unread: Math.max(0, unread - counted.size),
  };
}
