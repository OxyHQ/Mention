import { and, eq } from 'drizzle-orm';
import {
  isMentionBroadcast,
  MAX_MENTION_NOTIFICATIONS_PER_POST,
} from '@mention/shared-types/mentions';
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
import { mapWithConcurrency } from './concurrency';

/**
 * In-flight notification writes per fan-out.
 *
 * Every `createNotification` is an INSERT plus an Oxy actor lookup plus a push,
 * so an unbounded fan-out competes with the request path for both the Postgres
 * pool (`PG_MAX_POOL_SIZE`, 20) and Oxy's per-IP rate limit. Eight matches
 * `DEFAULT_CONCURRENCY` and `PostHydrationService`'s own Oxy fallback pool —
 * the same reasoning, so the same number rather than a second one to keep in
 * step.
 */
const NOTIFICATION_FANOUT_CONCURRENCY = 8;

/** Mentions are capped at eight recipients, so this bound is the cap, not a throttle. */
const MENTION_NOTIFICATION_CONCURRENCY = NOTIFICATION_FANOUT_CONCURRENCY;

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

    // One notification per mentioned user, OVERLAPPED rather than serial.
    //
    // This ran as a `for` loop with an `await` inside, so a post mentioning the
    // maximum eight people paid eight sequential round trips — each one an
    // INSERT plus, inside `createNotification`, an Oxy lookup and a push — while
    // `POST /posts` held the request open waiting for all of them. They are
    // independent by construction: distinct recipients, no shared state, and each
    // one's failure is already swallowed per item.
    //
    // Bounded rather than a bare `Promise.all`: the cap is eight today, but the
    // bound is what makes this safe to read at the next cap, and `Promise.all`
    // would also abandon the remaining items on the first rejection — which the
    // per-item `catch` this replaces did not do.
    const recipients = uniqueUserIds.filter((recipientId) => recipientId !== actorId);
    const settled = await mapWithConcurrency(
      recipients,
      MENTION_NOTIFICATION_CONCURRENCY,
      (recipientId) =>
        createNotification({
          recipientId,
          actorId,
          type: 'mention',
          entityId: postId,
          entityType,
        }, emitEvent),
    );
    for (const result of settled) {
      if (result.status === 'rejected') {
        logger.error('[Notifications] failed to create mention notification', result.reason);
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
 * Create notifications for many recipients, at bounded concurrency.
 *
 * "Batch" names the CALLER's intent, not the storage: there is no multi-row
 * insert here, and each recipient still costs an INSERT, an Oxy actor lookup and
 * a push. That is worth stating because the name reads like one round trip and
 * the biggest caller is not small — `PostCreationService`'s subscriber fan-out
 * selects every row of `post_subscriptions` for the author with no LIMIT, so a
 * popular author's post arrives here with as many entries as they have
 * subscribers.
 *
 * It used to be a bare `Promise.all` over that list, which had two faults on the
 * `POST /posts` request path: every write went in flight at once, so one popular
 * post could saturate a 20-connection pool and Oxy's per-IP limit together; and
 * `Promise.all` rejects on the FIRST failure, so a single bad recipient
 * abandoned the rest and the surrounding `catch` logged one error for an unknown
 * number of undelivered notifications.
 *
 * `mapWithConcurrency` fixes both: the pool is bounded, and every recipient is
 * attempted regardless of its neighbours, with failures reported per item.
 */
export const createBatchNotifications = async (
  notifications: CreateNotificationData[],
  emitEvent: boolean = true
): Promise<void> => {
  try {
    const settled = await mapWithConcurrency(
      notifications,
      NOTIFICATION_FANOUT_CONCURRENCY,
      (notification) => createNotification(notification, emitEvent),
    );
    const failed = settled.filter((result) => result.status === 'rejected');
    if (failed.length > 0) {
      logger.error('[Notifications] batch notification writes failed', {
        failed: failed.length,
        total: notifications.length,
        reason: (failed[0] as PromiseRejectedResult).reason,
      });
    }
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
