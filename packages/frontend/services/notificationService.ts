import { authenticatedClient } from '../utils/api';
import { Notification } from '@mention/shared-types';

interface NotificationsResponse {
    notifications: Notification[];
    unreadCount: number;
    hasMore: boolean;
    page: number;
    limit: number;
}

class NotificationService {
    /**
     * Get notifications for the current user
     */
    async getNotifications(cursor?: string, limit: number = 20): Promise<NotificationsResponse> {
        try {
            const params: any = { limit };

            if (cursor) {
                // For pagination, use page parameter if cursor represents page number
                params.page = parseInt(cursor) || 1;
            }

            const response = await authenticatedClient.get('/notifications', { params });

            return {
                notifications: response.data.notifications || [],
                unreadCount: response.data.unreadCount || 0,
                hasMore: response.data.hasMore || false,
                page: response.data.page || 1,
                limit: response.data.limit || limit,
            };
        } catch (error) {
            console.error('Error fetching notifications:', error);
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
            console.error('Error marking notification as read:', error);
            throw error;
        }
    }

    /**
     * Mark all notifications as read
     */
    async markAllAsRead(): Promise<{ message: string }> {
        try {
            console.log('Calling markAllAsRead endpoint: /notifications/read-all');
            const response = await authenticatedClient.patch('/notifications/read-all');
            console.log('markAllAsRead response:', response);
            return response.data || { message: 'All notifications marked as read' };
        } catch (error: any) {
            console.error('Error marking all notifications as read:', error);
            console.error('Error details:', {
                status: error?.response?.status,
                statusText: error?.response?.statusText,
                data: error?.response?.data,
                message: error?.message,
                url: error?.config?.url,
                method: error?.config?.method,
            });
            throw error;
        }
    }

    /**
     * Get unread notification count
     */
    async getUnreadCount(): Promise<number> {
        try {
            const response = await authenticatedClient.get('/notifications/unread-count');
            return response.data.count || 0;
        } catch (error) {
            console.error('Error fetching unread count:', error);
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
            console.error('Error deleting notification:', error);
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
            console.error('Error archiving notification:', error);
            throw error;
        }
    }
}

export const notificationService = new NotificationService();
