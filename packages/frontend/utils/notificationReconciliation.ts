import { notifyManager, type QueryClient } from '@tanstack/react-query';
import { getNextNotificationPage } from '@/lib/notificationPagination';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import type { NotificationsResponse } from '@/services/notificationService';
import type { NotificationIntent } from '@/types/notificationIntent';
import type { NotificationsInfiniteData } from './notificationCache';

export type NotificationReconciliationResult =
  | { status: 'applied' | 'session-changed' | 'superseded' | 'absent' }
  | { status: 'failed'; error: unknown };

interface NotificationReconciliationSource {
  getPage: (
    viewerId: string,
    cursor: string | undefined,
    limit: number,
  ) => Promise<NotificationsResponse>;
}

/**
 * Read with the backend's viewer precondition, then apply only if neither the
 * session nor either cache entry changed during the complete paginated read.
 * The caller decides when to retry a superseded or unavailable snapshot.
 */
export async function reconcileNotificationCache(
  client: QueryClient,
  intent: NotificationIntent,
  isCurrent: (intent: NotificationIntent) => boolean,
  source: NotificationReconciliationSource,
): Promise<NotificationReconciliationResult> {
  if (!isCurrent(intent)) return { status: 'session-changed' };
  const cache = client.getQueryCache();
  const listKey = viewerQueryKeys.notifications(intent.viewerId);
  const badgeKey = viewerQueryKeys.unreadNotifications(intent.viewerId);
  const list = cache.find({ queryKey: listKey, exact: true });
  const badge = cache.find({ queryKey: badgeKey, exact: true });
  if (!list && !badge) return { status: 'absent' };
  const previous = client.getQueryData<NotificationsInfiniteData>(listKey);
  const pageCount = Math.max(1, previous?.pages.length ?? 1);
  const limit = previous?.pages[0]?.limit ?? 20;
  let changed = false;
  let badgeChanged = false;
  const stop = cache.subscribe((event) => {
    if (event.query !== list && event.query !== badge) return;
    const dataChanged =
      event.type === 'removed' ||
      (event.type === 'updated' &&
        (event.action.type === 'success' || event.action.type === 'setState'));
    if (dataChanged) {
      changed = true;
      if (event.query === badge) badgeChanged = true;
    }
  });
  try {
    const pages: NotificationsResponse[] = [];
    const pageParams: (string | undefined)[] = [];
    let cursor: string | undefined;
    for (let index = 0; index < pageCount; index++) {
      const current = await source.getPage(intent.viewerId, cursor, limit);
      if (!isCurrent(intent)) return { status: 'session-changed' };
      if (changed) return { status: 'superseded' };
      pages.push(current);
      pageParams.push(cursor);
      cursor = getNextNotificationPage(current, pages, cursor, pageParams);
      if (!cursor) break;
    }
    if (
      changed ||
      cache.find({ queryKey: listKey, exact: true }) !== list ||
      cache.find({ queryKey: badgeKey, exact: true }) !== badge
    )
      return { status: 'superseded' };
    if (!isCurrent(intent)) return { status: 'session-changed' };
    let result: NotificationReconciliationResult = { status: 'applied' };
    notifyManager.batch(() => {
      if (list) client.setQueryData<NotificationsInfiniteData>(listKey, { pages, pageParams });
      // Query-cache observers run synchronously even inside a notification batch.
      // A later badge event must win over the snapshot we just applied to the list.
      if (!isCurrent(intent)) result = { status: 'session-changed' };
      else if (badgeChanged || cache.find({ queryKey: badgeKey, exact: true }) !== badge)
        result = { status: 'superseded' };
      else if (badge) client.setQueryData<number>(badgeKey, pages[0]?.unreadCount ?? 0);
    });
    return result;
  } catch (error) {
    return { status: 'failed', error };
  } finally {
    stop();
  }
}
