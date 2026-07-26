import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services/ui/client';
import { notificationService } from '@/services/notificationService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

/**
 * Live unread-notification count for the bell badges (bottom bar + sidebar).
 *
 * Backed by React Query — an external store consumed via `useSyncExternalStore`,
 * so this stays reactive without any `useEffect`. Gated on `canUsePrivateApi`
 * (not bare `isAuthenticated`) so the private read never fires during the SSO
 * cold-boot and 401-loops. The realtime notifications bridge keeps this fresh by
 * patching the shared viewer-scoped key; the 60s `staleTime` is only the cold refetch
 * floor.
 */
export function useUnreadCount(): number {
  const { user, canUsePrivateApi } = useAuth();

  const { data } = useQuery({
    queryKey: viewerQueryKeys.unreadNotifications(user?.id),
    queryFn: () => notificationService.getUnreadCount(),
    enabled: canUsePrivateApi && !!user?.id,
    staleTime: 60_000,
  });

  return data ?? 0;
}
