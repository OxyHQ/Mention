import { useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createLogger } from '@oxy.so/core/logger';
import { useAuth } from '@oxy.so/services/ui/client';
import { io, type Socket } from 'socket.io-client';
import { API_URL_SOCKET } from '../config';
import {
  loadNotificationValidation,
  type NotificationValidation,
} from '@/lib/notificationValidation';
import {
  containsNotification,
  findNotification,
  prependNotification,
  patchNotificationRead,
  removeNotification,
  markAllNotificationsRead,
  bumpUnread,
  type NotificationsInfiniteData,
} from '@/utils/notificationCache';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

const logger = createLogger('useRealtimeNotifications');

let socket: Socket | null = null;

/**
 * Keeps the notifications socket connected app-wide and applies every realtime
 * event as a TARGETED cache patch (never a full `invalidateQueries` refetch), so
 * the list and the bell badge update in place without flicker.
 *
 * Mounted once via `RealtimeNotificationsBridge` (the socket is a module
 * singleton — mounting it twice would double every listener). The connect/
 * disconnect `useEffect` is the one legitimate Effect here: synchronizing with an
 * external system (the WebSocket). All list/badge mutations are pure reducers
 * from `utils/notificationCache`.
 */
export const useRealtimeNotifications = () => {
  const { user, isAuthenticated, isReady, oxyServices } = useAuth();
  const queryClient = useQueryClient();

  const connectSocket = useCallback(() => {
    const userId = user?.id;
    if (!isAuthenticated || !isReady || !userId || socket?.connected) return;

    const token = oxyServices?.session.accessToken ?? undefined;
    if (!token) return;

    try {
      // Clean up any existing disconnected/failed socket
      if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
        socket = null;
      }

      // Connect to backend notifications namespace
      const current = io(`${API_URL_SOCKET}/notifications`, {
        auth: { token, userId },
        transports: ['websocket', 'polling'],
        path: '/socket.io',
      });
      socket = current;

      const listKey = viewerQueryKeys.notifications(userId);

      // Every cache patch runs in arrival order. The first event waits for the
      // validators to load (`loadNotificationValidation`), so later events queue
      // behind it rather than overtake it — a delete must never land before the
      // insert it removes. A patch still queued when this socket is replaced
      // (sign-out, account switch) is dropped: it belongs to the previous viewer.
      let pending: Promise<void> = Promise.resolve();
      const inOrder =
        <A extends unknown[]>(apply: (validation: NotificationValidation, ...args: A) => void) =>
        (...args: A): void => {
          pending = pending
            .then(loadNotificationValidation)
            .then((validation) => {
              if (socket === current) apply(validation, ...args);
            })
            .catch((error: unknown) => {
              logger.warn('Dropped a realtime notification event', { error });
            });
        };

      current.on('connect', () => {
        logger.info('Connected to notifications socket');
      });

      current.on(
        'notification',
        inOrder(({ ZRawNotification }, notification: unknown) => {
          const parsed = ZRawNotification.safeParse(notification);
          if (!parsed.success) {
            logger.warn('Dropped invalid socket notification');
            return;
          }
          const incoming = parsed.data;

          const prev = queryClient.getQueryData<NotificationsInfiniteData>(listKey);
          const alreadyPresent = prev ? containsNotification(prev, incoming._id) : false;

          queryClient.setQueryData<NotificationsInfiniteData>(listKey, (data) =>
            data ? prependNotification(data, incoming) : data,
          );

          // Bump the badge only for a genuinely new, unread notification — the
          // server echoes to the acting device too, so dedupe guards the count.
          if (!alreadyPresent && !incoming.read) {
            bumpUnread(queryClient, userId, 1);
          }
        }),
      );

      current.on(
        'notificationUpdated',
        inOrder(({ ZRawNotification }, notification: unknown) => {
          const parsed = ZRawNotification.safeParse(notification);
          if (!parsed.success) {
            logger.warn('Dropped invalid socket notificationUpdated');
            return;
          }
          const incoming = parsed.data;

          const prev = queryClient.getQueryData<NotificationsInfiniteData>(listKey);
          const previous = prev ? findNotification(prev, incoming._id) : undefined;

          queryClient.setQueryData<NotificationsInfiniteData>(listKey, (data) =>
            data ? patchNotificationRead(data, incoming._id, incoming.read) : data,
          );

          if (previous) {
            if (!previous.read && incoming.read) bumpUnread(queryClient, userId, -1);
            else if (previous.read && !incoming.read) bumpUnread(queryClient, userId, 1);
          }
        }),
      );

      current.on(
        'notificationDeleted',
        inOrder((_validation, notificationId: unknown) => {
          if (typeof notificationId !== 'string') {
            logger.warn('Dropped invalid socket notificationDeleted');
            return;
          }

          const prev = queryClient.getQueryData<NotificationsInfiniteData>(listKey);
          const previous = prev ? findNotification(prev, notificationId) : undefined;

          queryClient.setQueryData<NotificationsInfiniteData>(listKey, (data) =>
            data ? removeNotification(data, notificationId) : data,
          );

          if (previous && !previous.read) bumpUnread(queryClient, userId, -1);
        }),
      );

      current.on(
        'allNotificationsRead',
        inOrder(() => {
          queryClient.setQueryData<NotificationsInfiniteData>(listKey, (data) =>
            data ? markAllNotificationsRead(data) : data,
          );
          queryClient.setQueryData<number>(viewerQueryKeys.unreadNotifications(userId), 0);
        }),
      );

      current.on('disconnect', () => {
        logger.info('Disconnected from notifications socket');
      });

      // NOT an error: socket.io reconnects on its own, and the log says so
      // plainly — every one of these is followed by a `connect`. Measured on a
      // Pixel 10 Pro: `Disconnected` → three `connect_error` → `Connected`,
      // twice in five minutes on a normal wifi handover. Logged at `error` it
      // raised a red banner in dev that covered the bottom bar, and filed
      // recovered transport noise as an app failure in production telemetry.
      current.on('connect_error', (error) => {
        logger.warn('Notifications socket retrying after a connection error', { error });
      });
    } catch (error) {
      logger.error('Failed to connect to notifications socket', error);
    }
  }, [isAuthenticated, isReady, user?.id, oxyServices, queryClient]);

  const disconnectSocket = useCallback(() => {
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated && isReady && user?.id) {
      connectSocket();
    } else {
      disconnectSocket();
    }

    return () => {
      disconnectSocket();
    };
  }, [isAuthenticated, isReady, user?.id, connectSocket, disconnectSocket]);

  return {
    isConnected: socket?.connected || false,
    connect: connectSocket,
    disconnect: disconnectSocket,
  };
};
