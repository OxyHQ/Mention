import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { matchQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { notificationService } from '@/services/notificationService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import type { NotificationsInfiniteData } from '@/utils/notificationCache';
import { countNotificationOptimism } from '@/utils/notificationOptimism';
import { usePendingNotificationOperations } from './usePendingNotificationOperations';

/** The authoritative unread count, projected through this viewer's pending intents. */
export function useUnreadCount(): number {
  const { user, canUsePrivateApi, oxyServices } = useAuth();
  const client = useQueryClient();
  const listKey = useMemo(() => viewerQueryKeys.notifications(user?.id), [user?.id]);
  const { operations, epoch } = usePendingNotificationOperations(user?.id, oxyServices);
  const { data } = useQuery({
    queryKey: viewerQueryKeys.unreadNotifications(user?.id),
    queryFn: ({ signal }) => {
      if (!user?.id) throw new Error('Notification viewer is unavailable');
      return notificationService.getUnreadCountForViewer(user.id, signal);
    },
    enabled: canUsePrivateApi && !!user?.id,
    staleTime: 60_000,
  });
  // Observe cache data only. A disabled useQuery still creates an observer and
  // can replace the infinite list's fetch options; this badge owns no list fetch.
  const subscribe = useCallback(
    (listener: () => void) =>
      client.getQueryCache().subscribe((event) => {
        if (matchQuery({ queryKey: listKey, exact: true }, event.query)) listener();
      }),
    [client, listKey],
  );
  const readAffected = useCallback(
    () =>
      countNotificationOptimism(
        client.getQueryData<NotificationsInfiniteData>(listKey),
        operations,
        { viewerId: user?.id, epoch },
      ),
    [client, listKey, operations, user?.id, epoch],
  );
  const affected = useSyncExternalStore(subscribe, readAffected, readAffected);
  return Math.max(0, (data ?? 0) - affected);
}
