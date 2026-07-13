import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services';
import { notificationService } from '@/services/notificationService';

/**
 * React Query key for the unread-notification count. Keyed on the user id so it
 * resets across account switches and so the realtime reducers and the badge read
 * the exact same cache entry. Exported so those reducers can patch it directly.
 */
export function unreadCountKey(userId: string | undefined) {
  return ['notifications', 'unreadCount', userId] as const;
}

/**
 * Live unread-notification count for the bell badges (bottom bar + sidebar).
 *
 * Backed by React Query — an external store consumed via `useSyncExternalStore`,
 * so this stays reactive without any `useEffect`. Gated on `canUsePrivateApi`
 * (not bare `isAuthenticated`) so the private read never fires during the SSO
 * cold-boot and 401-loops. The realtime notifications bridge keeps this fresh by
 * patching {@link unreadCountKey}; the 60s `staleTime` is only the cold refetch
 * floor.
 */
export function useUnreadCount(): number {
  const { user, canUsePrivateApi } = useAuth();

  const { data } = useQuery({
    queryKey: unreadCountKey(user?.id),
    queryFn: () => notificationService.getUnreadCount(),
    enabled: canUsePrivateApi && !!user?.id,
    staleTime: 60_000,
  });

  return data ?? 0;
}
