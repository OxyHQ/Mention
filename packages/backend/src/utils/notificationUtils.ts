import {
  isMentionBroadcast,
  MAX_MENTION_NOTIFICATIONS_PER_POST,
} from '@mention/shared-types/mentions';
import Notification from '../models/Notification';
import { getServiceOxyClient } from './oxyHelpers';
import { getRuntimeSocketServer } from '../runtime/socketServer';
import { formatPushForNotification, sendPushToUser } from './push';
import { logger } from './logger';
import type { PostAuthorshipEntry } from '@mention/shared-types';
import { getNotificationRecipients, normalizeAuthorship } from './postAuthorship';
import {
  toPopulatedActor,
  type NotificationActorProfile,
} from './notificationActor';

export interface CreateNotificationData {
  recipientId: string;
  actorId: string;
  type: 'like' | 'reply' | 'mention' | 'follow' | 'boost' | 'quote' | 'welcome' | 'post' | 'poke' | 'collab_invite' | 'collab_accepted' | 'collab_declined';
  entityId: string;
  entityType: 'post' | 'reply' | 'profile';
}

/**
 * Creates a notification for a user action
 * Handles duplicate prevention and emits real-time events
 */
export const createNotification = async (
  data: CreateNotificationData,
  emitEvent: boolean = true,
  throwOnPersistenceError: boolean = false,
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
    const io = emitEvent ? getRuntimeSocketServer() : undefined;
    if (io) {
      let actor: NotificationActorProfile | null = null;
      try {
        if (data.actorId && data.actorId !== 'system') {
          const oxyActor = await getServiceOxyClient().getUserById(data.actorId);
          actor = oxyActor;
        } else if (data.actorId === 'system') {
          actor = { id: 'system', username: 'system', displayName: 'System' };
        }
      } catch (e) {
        // ignore actor resolution failures
      }
      const payload = {
        ...notification.toObject(),
        actorId_populated: toPopulatedActor(actor, data.actorId),
      };
      const notificationsNamespace = io.of('/notifications');
      notificationsNamespace.to(`user:${data.recipientId}`).emit('notification', payload);
    }

    // Fire push notification (best-effort, non-blocking)
    try {
      const push = await formatPushForNotification(notification);
      await sendPushToUser(data.recipientId, push);
    } catch (e) {
      // ignore push failures
    }

    logger.debug('[Notifications] notification created', {
      type: data.type,
    });
  } catch (error) {
    logger.error('[Notifications] Error creating notification:', error);
    if (throwOnPersistenceError) throw error;
  }
};

/**
 * Creates notifications for mentions in content
 *
 * A post that names more than `MAX_MENTION_NOTIFICATIONS_PER_POST` distinct users
 * is a broadcast, not a conversation, and notifies NOBODY — see
 * {@link isMentionBroadcast} for why nobody rather than the first N. This is the
 * fan-out backstop for EVERY caller: the native compose/reply/thread paths hand
 * this function the post's full persisted `mentions` allowlist, so the list it
 * receives IS the post's mention count and the gate below is exact for them. A
 * caller that holds only a SUBSET of a post's mentions (the federated inbox, which
 * narrows to local users before it gets here) cannot state the post's count from
 * this list and must apply the same predicate itself against the full count — this
 * gate would otherwise let a 30-mention broadcast through on the strength of its
 * one local recipient.
 *
 * @param mentionUserIds - Array of Oxy user IDs who were mentioned
 * @param postId - ID of the post containing the mentions
 * @param actorId - ID of the user who created the post
 * @param entityType - Type of entity ('post' or 'reply')
 * @param emitEvent - Whether to emit real-time events
 */
export const createMentionNotifications = async (
  mentionUserIds: string[],
  postId: string,
  actorId: string,
  entityType: 'post' | 'reply' = 'post',
  emitEvent: boolean = true
): Promise<void> => {
  try {
    if (!mentionUserIds || mentionUserIds.length === 0) return;

    // Get unique user IDs
    const uniqueUserIds = [...new Set(mentionUserIds)];

    if (isMentionBroadcast(uniqueUserIds.length)) {
      logger.warn('[Notifications] suppressed mention fan-out for a broadcast post', {
        mentioned: uniqueUserIds.length,
        cap: MAX_MENTION_NOTIFICATIONS_PER_POST,
      });
      return;
    }

    // Create notification for each mentioned user
    for (const recipientId of uniqueUserIds) {
      try {
        // Skip if user is mentioning themselves
        if (recipientId === actorId) continue;

        await createNotification({
          recipientId,
          actorId,
          type: 'mention',
          entityId: postId,
          entityType,
        }, emitEvent);
      } catch (e) {
        // If notification creation fails, log and continue
    logger.error('[Notifications] failed to create mention notification', e);
      }
    }
  } catch (error) {
    logger.error('[Notifications] Error creating mention notifications:', error);
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
    logger.error('[Notifications] Error creating welcome notification:', error);
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
    logger.error('[Notifications] Error creating batch notifications:', error);
  }
};

/** Notify owner + accepted collaborators (excludes actor). */
export const createPostAuthorNotifications = async (
  authorship: PostAuthorshipEntry[] | undefined,
  data: Omit<CreateNotificationData, 'recipientId'>,
): Promise<void> => {
  const recipients = getNotificationRecipients(normalizeAuthorship(authorship));
  await Promise.allSettled(
    recipients
      .filter((recipientId) => recipientId !== data.actorId)
      .map((recipientId) => createNotification({ ...data, recipientId })),
  );
};

/** Durable-worker variant: persistence failures reject for outbox retry. */
export const createPostAuthorNotificationsStrict = async (
  authorship: PostAuthorshipEntry[] | undefined,
  data: Omit<CreateNotificationData, 'recipientId'>,
): Promise<void> => {
  const recipients = getNotificationRecipients(normalizeAuthorship(authorship));
  await Promise.all(
    recipients
      .filter((recipientId) => recipientId !== data.actorId)
      .map((recipientId) =>
        createNotification(
          { ...data, recipientId },
          true,
          true,
        )),
  );
};
