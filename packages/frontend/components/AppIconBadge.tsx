import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { createLogger } from '@oxy.so/core/logger';
import { useUnreadCount } from '@/hooks/useUnreadCount';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { setAppIconBadge } from '@/utils/notifications';

const logger = createLogger('AppIconBadge');

/**
 * Keeps the number on the app's icon equal to the unread notifications while the
 * app runs, and clears it for a signed-out device. Renders nothing.
 */
export function AppIconBadge() {
  const { user, isAuthResolved, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const unread = useUnreadCount();
  // Zero before the first answer is not "nothing unread": leave the icon alone.
  const answered =
    queryClient.getQueryData(viewerQueryKeys.unreadNotifications(user?.id)) !== undefined;
  const badge = !isAuthResolved ? null : !isAuthenticated ? 0 : answered ? unread : null;

  useEffect(() => {
    if (badge === null) return;
    setAppIconBadge(badge).catch((error: unknown) => {
      logger.debug('Could not set the app icon badge', { error });
    });
  }, [badge]);

  return null;
}
