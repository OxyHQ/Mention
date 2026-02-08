import { authenticatedClient } from '../utils/api';
import { createScopedLogger } from '../utils/logger';

const logger = createScopedLogger('NotificationCreationService');

export interface CreateNotificationRequest {
  recipientId: string;
  actorId: string;
  type: 'like' | 'reply' | 'mention' | 'follow' | 'repost' | 'quote' | 'welcome' | 'poke';
  entityId: string;
  entityType: 'post' | 'reply' | 'profile';
}

/**
 * Service for creating notifications from the frontend
 * This is typically called when user actions occur that should notify others
 */
class NotificationCreationService {
  /**
   * Create a notification for a user action
   */
  async createNotification(data: CreateNotificationRequest): Promise<void> {
    try {
      await authenticatedClient.post('/notifications', data);
    } catch (error) {
      logger.error('Error creating notification:', error);
      // Don't throw to avoid breaking user flow
    }
  }

  /**
   * Create a like notification
   */
  async notifyLike(postId: string, postAuthorId: string, likerId: string): Promise<void> {
    if (postAuthorId === likerId) return; // Don't notify self

    await this.createNotification({
      recipientId: postAuthorId,
      actorId: likerId,
      type: 'like',
      entityId: postId,
      entityType: 'post',
    });
  }

  /**
   * Create a reply notification
   */
  async notifyReply(postId: string, postAuthorId: string, replierId: string, replyId: string): Promise<void> {
    if (postAuthorId === replierId) return; // Don't notify self

    await this.createNotification({
      recipientId: postAuthorId,
      actorId: replierId,
      type: 'reply',
      entityId: replyId,
      entityType: 'reply',
    });
  }

  /**
   * Create a repost notification
   */
  async notifyRepost(postId: string, postAuthorId: string, reposterId: string): Promise<void> {
    if (postAuthorId === reposterId) return; // Don't notify self

    await this.createNotification({
      recipientId: postAuthorId,
      actorId: reposterId,
      type: 'repost',
      entityId: postId,
      entityType: 'post',
    });
  }

  /**
   * Create a follow notification
   */
  async notifyFollow(followedUserId: string, followerId: string): Promise<void> {
    if (followedUserId === followerId) return; // Don't notify self

    await this.createNotification({
      recipientId: followedUserId,
      actorId: followerId,
      type: 'follow',
      entityId: followedUserId,
      entityType: 'profile',
    });
  }

  /**
   * Create mention notifications from content
   */
  async notifyMentions(content: string, postId: string, authorId: string): Promise<void> {
    try {
      // Extract mentions from content
      const mentionRegex = /@(\w+)/g;
      const mentions = content.match(mentionRegex);

      if (!mentions) return;

      // Get unique usernames
      const usernames = [...new Set(mentions.map(mention => mention.slice(1)))];

      // Create notifications for each mention
      const mentionPromises = usernames.map(async (username) => {
        if (username === authorId) return; // Don't notify self

        // In a real app, you'd resolve username to user ID
        // For now, assume username is the user ID
        return this.createNotification({
          recipientId: username,
          actorId: authorId,
          type: 'mention',
          entityId: postId,
          entityType: 'post',
        });
      });

      await Promise.all(mentionPromises);
    } catch (error) {
      logger.error('Error creating mention notifications:', error);
    }
  }

  /**
   * Create a quote notification
   */
  async notifyQuote(originalPostId: string, originalAuthorId: string, quoterId: string, quoteId: string): Promise<void> {
    if (originalAuthorId === quoterId) return; // Don't notify self

    await this.createNotification({
      recipientId: originalAuthorId,
      actorId: quoterId,
      type: 'quote',
      entityId: quoteId,
      entityType: 'post',
    });
  }
}

export const notificationCreationService = new NotificationCreationService();
