import { useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import { io, Socket } from 'socket.io-client';
import { API_URL_SOCKET } from '../config';

let socket: Socket | null = null;

/**
 * Hook for real-time notification updates via WebSocket
 */
export const useRealtimeNotifications = () => {
  const { user, isAuthenticated } = useOxy();
  const queryClient = useQueryClient();

  const connectSocket = useCallback(() => {
    if (!isAuthenticated || !user?.id || socket?.connected) return;

    try {
      // Connect to backend notifications namespace
      socket = io(`${API_URL_SOCKET}/notifications`, {
        auth: {
          userId: user.id,
        },
        transports: ['websocket', 'polling'],
        path: '/socket.io',
      });

      socket.on('connect', () => {
        console.log('Connected to notifications socket');
      });

      socket.on('notification', (notification: any) => {
        console.log('New notification received:', notification);

        // Invalidate notifications query to refetch
        queryClient.invalidateQueries({ queryKey: ['notifications'] });

        // You could also show a local notification or toast here
        // showNotificationToast(notification);
      });

      socket.on('notificationUpdated', (notification: any) => {
        console.log('Notification updated:', notification);
        queryClient.invalidateQueries({ queryKey: ['notifications'] });
      });

      socket.on('notificationDeleted', (notificationId: string) => {
        console.log('Notification deleted:', notificationId);
        queryClient.invalidateQueries({ queryKey: ['notifications'] });
      });

      socket.on('allNotificationsRead', () => {
        console.log('All notifications marked as read');
        queryClient.invalidateQueries({ queryKey: ['notifications'] });
      });

      socket.on('disconnect', () => {
        console.log('Disconnected from notifications socket');
      });

      socket.on('connect_error', (error) => {
        console.error('Socket connection error:', error);
      });

    } catch (error) {
      console.error('Failed to connect to notifications socket:', error);
    }
  }, [isAuthenticated, user?.id, queryClient]);

  const disconnectSocket = useCallback(() => {
    if (socket) {
      socket.disconnect();
      socket = null;
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated && user?.id) {
      connectSocket();
    } else {
      disconnectSocket();
    }

    return () => {
      disconnectSocket();
    };
  }, [isAuthenticated, user?.id, connectSocket, disconnectSocket]);

  return {
    isConnected: socket?.connected || false,
    connect: connectSocket,
    disconnect: disconnectSocket,
  };
};
