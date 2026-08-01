import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import {
  notifications,
  type NOTIFICATION_ENTITY_TYPES,
  type NOTIFICATION_TYPES,
} from '../db/schema/discovery';
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
  /** Derived from the CHECK's own tuple, so the writer cannot drift from it. */
  type: (typeof NOTIFICATION_TYPES)[number];
  entityId: string;
  entityType: (typeof NOTIFICATION_ENTITY_TYPES)[number];
}

/**
 * A notification row exactly as it goes on the wire — the response DTO, the
 * socket payload, and nothing else.
 *
 * `_id` survives the port because the frontend's own contract requires it
 * (`ZRawNotification` in `frontend/types/validation.ts` declares `_id` and
 * `entityId` as required strings), and a port changes no response body. The
 * value is the same one Mongo held: the backfill copies `_id` verbatim into the
 * `text` primary key. Mongoose's `__v` is dropped — no client reads it and
 * `CONVENTIONS.md` forbids the column.
 */
export interface SerializedNotification {
  _id: string;
  recipientId: string;
  actorId: string;
  type: (typeof NOTIFICATION_TYPES)[number];
  entityId: string;
  entityType: (typeof NOTIFICATION_ENTITY_TYPES)[number];
  read: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** The one row → wire mapping, shared by the writer and the read routes. */
export function serializeNotification(
  row: typeof notifications.$inferSelect,
): SerializedNotification {
  return {
    _id: row.id,
    recipientId: row.recipientId,
    actorId: row.actorId,
    type: row.type,
    entityId: row.entityId,
    entityType: row.entityType,
    read: row.read,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Creates a notification for a user action
 * Handles duplicate prevention and emits real-time events
 *
 * ## The unique index IS the idempotency
 *
 * `notifications_dedup_key` — `(recipient_id, actor_id, type, entity_id)` — is
 * what makes a second like from the same actor on the same post unable to mint a
 * second row. Mongo expressed that as read-then-write, which two concurrent
 * callers could both pass; `ON CONFLICT DO NOTHING` on the same four columns is
 * atomic, so the loser is told it lost instead of raising a duplicate-key error
 * the caller would have had to translate.
 *
 * The conflict target is the COLUMN LIST rather than a bare `onConflictDoNothing()`
 * deliberately: an unqualified form would also swallow a future unique index on
 * this table, silently turning an unrelated constraint into "already notified".
 *
 * Whether a row was INSERTED is what gates the socket emit and the push — a
 * repeated like must not re-notify. `returning()` answers that with no `xmax`
 * trick: an empty result means the row already existed.
 *
 * The self-notification guard moved AHEAD of the dedupe read, because the insert
 * would otherwise create the very row the guard exists to prevent. The order is
 * behaviour-preserving: a self-notification can never have been written, so the
 * branch Mongo evaluated first was unreachable for exactly these rows.
 */
export const createNotification = async (
  data: CreateNotificationData,
  emitEvent: boolean = true,
  throwOnPersistenceError: boolean = false,
): Promise<void> => {
  try {
    // Don't create notification if actor and recipient are the same
    if (data.actorId === data.recipientId) {
      return;
    }

    const db = getDb();
    const [notification] = await db
      .insert(notifications)
      .values({
        recipientId: data.recipientId,
        actorId: data.actorId,
        type: data.type,
        entityId: data.entityId,
        entityType: data.entityType,
      })
      .onConflictDoNothing({
        target: [
          notifications.recipientId,
          notifications.actorId,
          notifications.type,
          notifications.entityId,
        ],
      })
      .returning();

    if (!notification) {
      // Already notified: refresh the timestamp so the existing row floats back
      // to the top of the recipient's list, exactly as before. `updated_at` moves
      // with it via the column's own `$onUpdate`, matching Mongoose's timestamps.
      await db
        .update(notifications)
        .set({ createdAt: new Date() })
        .where(
          and(
            eq(notifications.recipientId, data.recipientId),
            eq(notifications.actorId, data.actorId),
            eq(notifications.type, data.type),
            eq(notifications.entityId, data.entityId),
          ),
        );
      return;
    }

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
        ...serializeNotification(notification),
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
