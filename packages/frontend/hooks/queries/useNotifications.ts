/**
 * Notifications Query Hooks
 * 
 * Custom React Query hooks for notification-related data fetching
 * Following best practices with proper error handling and type safety
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { notificationService } from '@/services/notificationService';
import { useOxy } from '@oxyhq/services';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/utils/api';
import { QueryOptions, MutationOptions, getErrorMessage } from './useQueryHelpers';

// ============================================================================
// Query Keys
// ============================================================================

export const notificationKeys = {
  all: ['notifications'] as const,
  lists: () => [...notificationKeys.all, 'list'] as const,
  list: (userId?: string) => [...notificationKeys.lists(), userId] as const,
  detail: (id: string) => [...notificationKeys.all, 'detail', id] as const,
} as const;

// ============================================================================
// Query Hooks
// ============================================================================

/**
 * Hook to fetch notifications for the current user
 */
export function useNotifications(options?: QueryOptions<Awaited<ReturnType<typeof notificationService.getNotifications>>>) {
  const { user, isAuthenticated } = useOxy();

  return useQuery({
    queryKey: notificationKeys.list(user?.id),
    queryFn: () => notificationService.getNotifications(),
    enabled: (options?.enabled ?? true) && isAuthenticated && !!user?.id,
    ...options,
  });
}

// ============================================================================
// Mutation Hooks
// ============================================================================

/**
 * Hook to mark a notification as read
 */
export function useMarkNotificationAsRead(
  options?: MutationOptions<void, string>
) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: (notificationId: string) =>
      notificationService.markAsRead(notificationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
    onError: (error: ApiError) => {
      console.error('Error marking notification as read:', error);
      toast.error(t('notification.mark_read_error') || 'Failed to mark notification as read');
      options?.onError?.(error);
    },
    ...options,
  });
}

/**
 * Hook to mark all notifications as read
 */
export function useMarkAllNotificationsAsRead(
  options?: MutationOptions<void, void>
) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: () => notificationService.markAllAsRead(),
    onSuccess: async () => {
      // Invalidate all notification queries
      await queryClient.invalidateQueries({ queryKey: notificationKeys.all });
      toast.success(
        t('notification.mark_all_read_success') || 'All notifications marked as read'
      );
      options?.onSuccess?.(undefined, undefined, undefined as any);
    },
    onError: (error: ApiError) => {
      console.error('Error marking all notifications as read:', error);
      const errorMessage = getErrorMessage(error);
      toast.error(
        t('notification.mark_all_read_error') ||
          `Failed to mark all notifications as read: ${errorMessage}`
      );
      options?.onError?.(error, undefined, undefined as any);
    },
    ...options,
  });
}

