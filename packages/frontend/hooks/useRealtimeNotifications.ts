import { useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createScopedLogger } from '@/lib/logger';
import { useAuth } from '@oxyhq/services';
import { io, Socket } from 'socket.io-client';
import { API_URL_SOCKET } from '../config';
import { ZRawNotification } from '../types/validation';
import { unreadCountKey } from '@/hooks/useUnreadCount';
import {
  notificationsKey,
  containsNotification,
  findNotification,
  prependNotification,
  patchNotificationRead,
  removeNotification,
  markAllNotificationsRead,
  bumpUnread,
  type NotificationsInfiniteData,
} from '@/utils/notificationCache';

const logger = createScopedLogger('useRealtimeNotifications');

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

    const token = oxyServices?.getAccessToken() ?? undefined;
    if (!token) return;

    try {
      // Clean up any existing disconnected/failed socket
      if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
        socket = null;
      }

      // Connect to backend notifications namespace
      socket = io(`${API_URL_SOCKET}/notifications`, {
        auth: { token, userId },
        transports: ['websocket', 'polling'],
        path: '/socket.io',
      });

      const listKey = notificationsKey(userId);

      socket.on('connect', () => {
        logger.info('Connected to notifications socket');
      });

      socket.on('notification', (notification: unknown) => {
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
      });

      socket.on('notificationUpdated', (notification: unknown) => {
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
      });

      socket.on('notificationDeleted', (notificationId: unknown) => {
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
      });

      socket.on('allNotificationsRead', () => {
        queryClient.setQueryData<NotificationsInfiniteData>(listKey, (data) =>
          data ? markAllNotificationsRead(data) : data,
        );
        queryClient.setQueryData<number>(unreadCountKey(userId), 0);
      });

      socket.on('disconnect', () => {
        logger.info('Disconnected from notifications socket');
      });

      socket.on('connect_error', (error) => {
        logger.error('Socket connection error', { error });
      });
    } catch (error) {
      logger.error('Failed to connect to notifications socket', { error });
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
