import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { notificationService } from '@/services/notificationService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import type { NotificationsInfiniteData } from '@/utils/notificationCache';
import { countNotificationOptimism } from '@/utils/notificationOptimism';
import { usePendingNotificationOperations } from './usePendingNotificationOperations';

/** The authoritative unread count, projected through this viewer's pending intents. */
export function useUnreadCount(): number {
  const { user, canUsePrivateApi, oxyServices } = useAuth();
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
  const selectAffected = useCallback(
    (list: NotificationsInfiniteData) =>
      countNotificationOptimism(list, operations, { viewerId: user?.id, epoch }),
    [operations, user?.id, epoch],
  );
  // A disabled observer reads the existing list without issuing another request.
  // Selecting a number keeps unrelated row updates from rerendering the badge.
  const { data: affected = 0 } = useQuery({
    queryKey: viewerQueryKeys.notifications(user?.id),
    enabled: false,
    select: selectAffected,
  });
  return Math.max(0, (data ?? 0) - affected);
}
