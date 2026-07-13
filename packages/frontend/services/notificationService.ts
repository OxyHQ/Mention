import { authenticatedClient } from '../utils/api';
import { createScopedLogger } from '@/lib/logger';
import type { TRawNotification } from '@/types/validation';

const logger = createScopedLogger('NotificationService');

/**
 * Shape of the paginated `/notifications` response. `notifications` carries the
 * RAW API notification shape (`_id`/`read`/`actorId`…), which is what every
 * consumer re-validates via `ZRawNotification` and what the realtime reducers
 * patch — NOT the aspirational `@mention/shared-types` `Notification` model
 * (`id`/`isRead`/`status`), which this endpoint does not emit.
 */
export interface NotificationsResponse {
    notifications: TRawNotification[];
    unreadCount: number;
    hasMore: boolean;
    nextCursor?: string;
    limit: number;
}

class NotificationService {
    /**
     * Get notifications for the current user.
     * Backend uses cursor-based pagination where cursor is the _id of the last notification.
     */
    async getNotifications(cursor?: string, limit: number = 20): Promise<NotificationsResponse> {
        try {
            const params: { limit: number; cursor?: string } = { limit };

            if (cursor) {
                params.cursor = cursor;
            }

            const response = await authenticatedClient.get<Partial<NotificationsResponse>>('/notifications', { params });

            return {
                notifications: response.data.notifications || [],
                unreadCount: response.data.unreadCount || 0,
                hasMore: response.data.hasMore || false,
                nextCursor: response.data.nextCursor,
                limit: response.data.limit || limit,
            };
        } catch (error) {
            logger.error('Error fetching notifications', { error });
            throw error;
        }
    }

    /**
     * Mark a notification as read
     */
    async markAsRead(notificationId: string): Promise<void> {
        try {
            await authenticatedClient.patch(`/notifications/${notificationId}/read`);
        } catch (error) {
            logger.error('Error marking notification as read', { error });
            throw error;
        }
    }

    /**
     * Mark all notifications as read
     */
    async markAllAsRead(): Promise<{ message: string }> {
        try {
            const response = await authenticatedClient.patch<{ message: string }>('/notifications/read-all');
            return response.data || { message: 'All notifications marked as read' };
        } catch (error) {
            logger.error('Error marking all notifications as read', { error });
            throw error;
        }
    }

    /**
     * Get unread notification count
     */
    async getUnreadCount(): Promise<number> {
        try {
            const response = await authenticatedClient.get<{ count?: number }>('/notifications/unread-count');
            return response.data.count || 0;
        } catch (error) {
            logger.error('Error fetching unread count', { error });
            return 0;
        }
    }

    /**
     * Delete a notification
     */
    async deleteNotification(notificationId: string): Promise<void> {
        try {
            await authenticatedClient.delete(`/notifications/${notificationId}`);
        } catch (error) {
            logger.error('Error deleting notification', { error });
            throw error;
        }
    }

    /**
     * Archive a notification
     */
    async archiveNotification(notificationId: string): Promise<void> {
        try {
            await authenticatedClient.patch(`/notifications/${notificationId}/archive`);
        } catch (error) {
            logger.error('Error archiving notification', { error });
            throw error;
        }
    }
}

export const notificationService = new NotificationService();
