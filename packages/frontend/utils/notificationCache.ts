import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type { NotificationsResponse } from '@/services/notificationService';
import type { TRawNotification } from '@/types/validation';
import { unreadCountKey } from '@/hooks/useUnreadCount';

/**
 * The cached shape of the `['notifications', userId]` infinite query. The page
 * param is the last notification's `_id` (cursor pagination), matching the
 * `useInfiniteQuery` in `notifications.tsx`.
 */
export type NotificationsInfiniteData = InfiniteData<NotificationsResponse, string | undefined>;

/** React Query key for the paginated notifications list. */
export function notificationsKey(userId: string | undefined) {
  return ['notifications', userId] as const;
}

// ---------------------------------------------------------------------------
// Pure reducers — no React, no QueryClient. Each returns a NEW object graph
// (structurally shared where nothing changed) so React Query change-detection
// re-renders only what moved. Exported individually so they are unit-testable.
// ---------------------------------------------------------------------------

/** Whether a notification with `id` already exists anywhere in the cache. */
export function containsNotification(data: NotificationsInfiniteData, id: string): boolean {
  return data.pages.some((page) => page.notifications.some((n) => n._id === id));
}

/** The first notification matching `id`, or `undefined`. */
export function findNotification(data: NotificationsInfiniteData, id: string): TRawNotification | undefined {
  for (const page of data.pages) {
    const found = page.notifications.find((n) => n._id === id);
    if (found) return found;
  }
  return undefined;
}

/**
 * Prepend a freshly-received notification to page 0, deduped by `_id` (idempotent
 * against the server echo to the acting device). Also nudges page 0's own
 * `unreadCount` when the incoming item is unread.
 */
export function prependNotification(
  data: NotificationsInfiniteData,
  incoming: TRawNotification,
): NotificationsInfiniteData {
  if (containsNotification(data, incoming._id)) return data;

  const [first, ...rest] = data.pages;
  if (!first) {
    return {
      ...data,
      pages: [
        {
          notifications: [incoming],
          unreadCount: incoming.read ? 0 : 1,
          hasMore: false,
          limit: 20,
        },
      ],
    };
  }

  const newFirst: NotificationsResponse = {
    ...first,
    notifications: [incoming, ...first.notifications],
    unreadCount: incoming.read ? first.unreadCount : first.unreadCount + 1,
  };
  return { ...data, pages: [newFirst, ...rest] };
}

/** Set the `read` flag on the notification matching `id` across all pages. */
export function patchNotificationRead(
  data: NotificationsInfiniteData,
  id: string,
  read: boolean,
): NotificationsInfiniteData {
  return {
    ...data,
    pages: data.pages.map((page) => {
      let changed = false;
      const notifications = page.notifications.map((n) => {
        if (n._id === id && n.read !== read) {
          changed = true;
          return { ...n, read };
        }
        return n;
      });
      return changed ? { ...page, notifications } : page;
    }),
  };
}

/** Mark several notifications read at once (used by the screen's mark mutations). */
export function markNotificationsRead(
  data: NotificationsInfiniteData,
  ids: string[],
): NotificationsInfiniteData {
  if (ids.length === 0) return data;
  const idSet = new Set(ids);
  return {
    ...data,
    pages: data.pages.map((page) => {
      let changed = false;
      const notifications = page.notifications.map((n) => {
        if (idSet.has(n._id) && !n.read) {
          changed = true;
          return { ...n, read: true };
        }
        return n;
      });
      return changed ? { ...page, notifications } : page;
    }),
  };
}

/** Mark every notification read and zero each page's `unreadCount`. */
export function markAllNotificationsRead(data: NotificationsInfiniteData): NotificationsInfiniteData {
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      unreadCount: 0,
      notifications: page.notifications.map((n) => (n.read ? n : { ...n, read: true })),
    })),
  };
}

/** Remove the notification matching `id` from every page. */
export function removeNotification(data: NotificationsInfiniteData, id: string): NotificationsInfiniteData {
  return {
    ...data,
    pages: data.pages.map((page) => {
      if (!page.notifications.some((n) => n._id === id)) return page;
      return { ...page, notifications: page.notifications.filter((n) => n._id !== id) };
    }),
  };
}

// ---------------------------------------------------------------------------
// QueryClient-bound helper for the separate unread-count badge cache.
// ---------------------------------------------------------------------------

/**
 * Adjust the live unread-count badge cache by `delta`, clamped at 0. Kept in
 * lockstep with the list reducers so the badge and the list never diverge.
 */
export function bumpUnread(queryClient: QueryClient, userId: string | undefined, delta: number): void {
  if (!userId || delta === 0) return;
  queryClient.setQueryData<number>(unreadCountKey(userId), (prev) => Math.max(0, (prev ?? 0) + delta));
}
