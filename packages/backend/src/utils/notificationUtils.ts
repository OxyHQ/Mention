import Notification from '../models/Notification';
import { oxy } from '../../server';
import { formatPushForNotification, sendPushToUser } from './push';

export interface CreateNotificationData {
  recipientId: string;
  actorId: string;
  type: 'like' | 'reply' | 'mention' | 'follow' | 'repost' | 'quote' | 'welcome' | 'post';
  entityId: string;
  entityType: 'post' | 'reply' | 'profile';
}

/**
 * Creates a notification for a user action
 * Handles duplicate prevention and emits real-time events
 */
export const createNotification = async (
  data: CreateNotificationData,
  emitEvent: boolean = true
): Promise<void> => {
  try {
    // Check if notification already exists to prevent duplicates
    const existingNotification = await Notification.findOne({
      recipientId: data.recipientId,
      actorId: data.actorId,
      type: data.type,
      entityId: data.entityId,
    });

    if (existingNotification) {
      // Update timestamp if notification already exists
      await Notification.findByIdAndUpdate(existingNotification._id, {
        createdAt: new Date(),
      });
      return;
    }

    // Don't create notification if actor and recipient are the same
    if (data.actorId === data.recipientId) {
      return;
    }

    const notification = new Notification(data);
    await notification.save();

  // Emit real-time notification if requested with actor profile data
    if (emitEvent && (global as any).io) {
      let actor: any = null;
      try {
        if (data.actorId && data.actorId !== 'system') {
          actor = await oxy.getUserById(data.actorId);
        } else if (data.actorId === 'system') {
          actor = { id: 'system', username: 'system', name: { full: 'System' } };
        }
      } catch (e) {
        // ignore actor resolution failures
      }
      const payload = {
        ...notification.toObject(),
        actorId_populated: actor ? {
          _id: actor.id || actor._id || data.actorId,
          username: actor.username || data.actorId,
          name: actor.name?.full || actor.name || actor.username || data.actorId,
          avatar: actor.avatar
        } : undefined
      };
      const notificationsNamespace = (global as any).io.of('/notifications');
      notificationsNamespace.to(`user:${data.recipientId}`).emit('notification', payload);
    }

    // Fire push notification (best-effort, non-blocking)
    try {
      const push = await formatPushForNotification(notification);
      await sendPushToUser(data.recipientId, push);
    } catch (e) {
      // ignore push failures
    }

    console.log(`Notification created: ${data.type} from ${data.actorId} to ${data.recipientId}`);
  } catch (error) {
    console.error('Error creating notification:', error);
    // Don't throw error to avoid breaking the main flow
  }
};

/**
 * Creates notifications for mentions in content
 */
export const createMentionNotifications = async (
  content: string,
  postId: string,
  actorId: string,
  emitEvent: boolean = true
): Promise<void> => {
  try {
    // Extract mentions from content (simple regex for @username)
    const mentionRegex = /@(\w+)/g;
    const mentions = content.match(mentionRegex);

    if (!mentions) return;

    // Get unique usernames
    const usernames = [...new Set(mentions.map(mention => mention.slice(1)))];

    // For each mentioned user, resolve username to Oxy userId and create a notification
    for (const username of usernames) {
      try {
        // Resolve Oxy user by username
        const profile: any = await oxy.getProfileByUsername(username);
        const recipientId = profile?.id || profile?._id || profile?.user?.id;
        if (!recipientId) continue;
        if (recipientId === actorId) continue;

        await createNotification({
          recipientId,
          actorId,
          type: 'mention',
          entityId: postId,
          entityType: 'post',
        }, emitEvent);
      } catch (e) {
        // If resolution fails, skip silently
        console.error('Mention resolution failed for', username, e);
      }
    }
  } catch (error) {
    console.error('Error creating mention notifications:', error);
  }
};

/**
 * Creates a welcome notification for new users
 */
export const createWelcomeNotification = async (
  userId: string,
  emitEvent: boolean = true
): Promise<void> => {
  try {
    await createNotification({
      recipientId: userId,
      actorId: 'system', // System-generated notification
      type: 'welcome',
      entityId: userId,
      entityType: 'profile',
    }, emitEvent);
  } catch (error) {
    console.error('Error creating welcome notification:', error);
  }
};

/**
 * Batch create notifications for multiple recipients
 */
export const createBatchNotifications = async (
  notifications: CreateNotificationData[],
  emitEvent: boolean = true
): Promise<void> => {
  try {
    const promises = notifications.map(notification =>
      createNotification(notification, emitEvent)
    );
    await Promise.all(promises);
  } catch (error) {
    console.error('Error creating batch notifications:', error);
  }
};
