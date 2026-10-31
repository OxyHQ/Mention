import { useEffect } from 'react';
import { Platform } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { useRouter } from '@/lib/navigation/router';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { notificationService } from '@/services/notificationService';
import { notificationSubjectHref } from '@/utils/notificationRoute';
import { subscribeToPushOpens } from '@/utils/notifications';

/**
 * Acts on a tapped push exactly as tapping its row in the inbox does: marks
 * the notification read and opens its subject. A profile notification (a
 * follow, a poke) names its actor only by id, so it opens the inbox, where the
 * row resolves the actor.
 *
 * Mounted beside `RegisterPushToken`, inside navigation, and subscribes only
 * once signed in, so the cold-start push is handled with a session to mark it
 * read under.
 */
export function PushNotificationOpener() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { isAuthenticated, user } = useAuth();
  const userId = user?.id;

  useEffect(() => {
    if (Platform.OS === 'web' || !isAuthenticated || !userId) return;
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    void subscribeToPushOpens((data) => {
      if (data.notificationId) {
        // The socket echo patches the inbox when it is connected; refetching
        // covers a cold start, where it is not yet.
        notificationService
          .markAsRead(data.notificationId)
          .then(() =>
            queryClient.invalidateQueries({ queryKey: viewerQueryKeys.notificationsRoot(userId) }),
          )
          .catch(() => undefined);
      }
      router.push(notificationSubjectHref(data) ?? '/notifications');
    }).then((stop) => {
      if (cancelled) stop();
      else unsubscribe = stop;
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [isAuthenticated, userId, queryClient, router]);

  return null;
}
