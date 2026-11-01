import { authenticatedClient } from '../utils/api';
import { createLogger } from '@oxy.so/core/logger';
import type { TRawNotification } from '@/types/validation';
import { loadNotificationValidation } from '@/lib/notificationValidation';
import { expectedViewerHeaders } from '@mention/shared-types/common';

const logger = createLogger('NotificationService');

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
   * The cursor is an opaque backend pagination token.
   */
  async getNotifications(cursor?: string, limit: number = 20): Promise<NotificationsResponse> {
    return this.fetchNotifications('/notifications', cursor, limit);
  }

  /** A reconciliation read bound to the effective authenticated subject. */
  async getNotificationsForViewer(
    viewerId: string,
    cursor?: string,
    limit: number = 20,
  ): Promise<NotificationsResponse> {
    return this.fetchNotifications('/notifications/_viewer/inbox', cursor, limit, viewerId);
  }

  private async fetchNotifications(
    path: string,
    cursor: string | undefined,
    limit: number,
    viewerId?: string,
  ): Promise<NotificationsResponse> {
    try {
      const params: { limit: number; cursor?: string } = { limit };

      if (cursor) {
        params.cursor = cursor;
      }

      const [response, { validateNotifications }] = await Promise.all([
        authenticatedClient.get<Partial<NotificationsResponse>>(path, {
          params,
          ...(viewerId ? { headers: expectedViewerHeaders(viewerId) } : {}),
        }),
        loadNotificationValidation(),
      ]);

      return {
        // Parsed once, here, at the boundary: everything that reads the
        // list (and the realtime patches applied to it) holds contract-valid rows.
        notifications: validateNotifications(response.data.notifications ?? []),
        unreadCount: response.data.unreadCount || 0,
        hasMore: response.data.hasMore || false,
        nextCursor: response.data.nextCursor,
        limit: response.data.limit || limit,
      };
    } catch (error) {
      logger.error('Error fetching notifications', error);
      throw error;
    }
  }

  /**
   * Mark a notification as read
   */
  async markAsRead(notificationId: string, viewerId: string): Promise<void> {
    try {
      await authenticatedClient.patch(`/notifications/_viewer/${notificationId}/read`, undefined, {
        headers: expectedViewerHeaders(viewerId),
      });
    } catch (error) {
      logger.error('Error marking notification as read', error);
      throw error;
    }
  }

  /**
   * Mark all notifications as read
   */
  async markAllAsRead(viewerId: string): Promise<{ message: string }> {
    try {
      const response = await authenticatedClient.patch<{ message: string }>(
        '/notifications/_viewer/read-all',
        undefined,
        { headers: expectedViewerHeaders(viewerId) },
      );
      return response.data || { message: 'All notifications marked as read' };
    } catch (error) {
      logger.error('Error marking all notifications as read', error);
      throw error;
    }
  }

  /**
   * Get unread notification count
   */
  async getUnreadCount(): Promise<number> {
    try {
      const response = await authenticatedClient.get<{ count?: number }>(
        '/notifications/unread-count',
      );
      return response.data.count || 0;
    } catch (error) {
      logger.error('Error fetching unread count', error);
      return 0;
    }
  }

  /** A protected reconciliation failure must not be reported as a zero badge. */
  async getUnreadCountForViewer(viewerId: string): Promise<number> {
    const response = await authenticatedClient.get<{ count?: number }>(
      '/notifications/_viewer/unread-count',
      { headers: expectedViewerHeaders(viewerId) },
    );
    return response.data.count || 0;
  }

  /**
   * Delete a notification
   */
  async deleteNotification(notificationId: string, viewerId: string): Promise<void> {
    try {
      await authenticatedClient.delete(`/notifications/_viewer/${notificationId}`, {
        headers: expectedViewerHeaders(viewerId),
      });
    } catch (error) {
      logger.error('Error deleting notification', error);
      throw error;
    }
  }

  /**
   * Archive a notification
   */
  async archiveNotification(notificationId: string, viewerId: string): Promise<void> {
    try {
      await authenticatedClient.patch(
        `/notifications/_viewer/${notificationId}/archive`,
        undefined,
        { headers: expectedViewerHeaders(viewerId) },
      );
    } catch (error) {
      logger.error('Error archiving notification', error);
      throw error;
    }
  }
}

export const notificationService = new NotificationService();
