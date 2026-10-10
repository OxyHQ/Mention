import { and, eq, inArray } from 'drizzle-orm';
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
import {
  formatPushForNotification,
  loadPushTargets,
  sendPushToTokens,
  type PushLookups,
} from './push';
import { loadPostRecord } from '../db/posts/postRepository';
import { logger } from './logger';
import type { PostAuthorshipEntry } from '@mention/shared-types';
import { getNotificationRecipients, normalizeAuthorship } from './postAuthorship';
import { toPopulatedActor, type NotificationActorProfile } from './notificationActor';
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
 * value is the row's `text` primary key. There is no `__v` — no client reads it
 * and `CONVENTIONS.md` forbids the column.
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
 * second row. A read-then-write could be passed by two concurrent callers;
 * `ON CONFLICT DO NOTHING` on the same four columns is
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
 * dedupe branch was unreachable for exactly these rows.
 */
export const createNotification = async (
  data: CreateNotificationData,
  emitEvent: boolean = true,
  throwOnPersistenceError: boolean = false,
): Promise<void> => {
  await writeNotifications([data], { emitEvent, throwOnPersistenceError });
};

/** Rows per INSERT. Far under Postgres's 65 535 bind-parameter ceiling at 5 per row. */
const NOTIFICATION_INSERT_CHUNK = 500;

const NOTIFICATION_CONFLICT_TARGET = [
  notifications.recipientId,
  notifications.actorId,
  notifications.type,
  notifications.entityId,
];

function dedupKey(
  n: Pick<CreateNotificationData, 'recipientId' | 'actorId' | 'type' | 'entityId'>,
): string {
  return `${n.recipientId}\u0000${n.actorId}\u0000${n.type}\u0000${n.entityId}`;
}

/**
 * Write a fan-out's notifications and deliver the NEW ones — the one path every
 * writer in this module goes through.
 *
 * One multi-row `INSERT … ON CONFLICT DO NOTHING RETURNING` per chunk, rather
 * than a statement per recipient: `RETURNING` names exactly the rows that were
 * inserted, which is the "was this new?" answer the single-row writer read off
 * an empty result, for every recipient at once. The repeats — rows the unique
 * index already held — get their `createdAt` refreshed in one UPDATE per
 * (actor, type, entity), which in a fan-out is almost always a single statement.
 *
 * A chunk is written or refused as a whole. The one-recipient-at-a-time version
 * isolated each recipient's INSERT, but the failures that isolation guarded
 * against — a CHECK violation, a lost connection — are properties of the
 * statement, not of one recipient, so they would have failed every row alike.
 */
async function writeNotifications(
  items: readonly CreateNotificationData[],
  {
    emitEvent = true,
    throwOnPersistenceError = false,
  }: {
    emitEvent?: boolean;
    throwOnPersistenceError?: boolean;
  } = {},
): Promise<void> {
  // Never notify yourself; and one row per dedup key, since the same key twice
  // in one INSERT would only ever insert once anyway.
  const unique = new Map<string, CreateNotificationData>();
  for (const item of items) {
    if (item.actorId === item.recipientId) continue;
    const key = dedupKey(item);
    if (!unique.has(key)) unique.set(key, item);
  }
  if (unique.size === 0) return;

  const inserted: (typeof notifications.$inferSelect)[] = [];
  try {
    const db = getDb();
    const all = [...unique.values()];
    for (let i = 0; i < all.length; i += NOTIFICATION_INSERT_CHUNK) {
      const chunk = all.slice(i, i + NOTIFICATION_INSERT_CHUNK);
      const rows = await db
        .insert(notifications)
        .values(
          chunk.map(({ recipientId, actorId, type, entityId, entityType }) => ({
            recipientId,
            actorId,
            type,
            entityId,
            entityType,
          })),
        )
        .onConflictDoNothing({ target: NOTIFICATION_CONFLICT_TARGET })
        .returning();
      inserted.push(...rows);

      const insertedKeys = new Set(rows.map(dedupKey));
      await refreshRepeatedNotifications(chunk.filter((n) => !insertedKeys.has(dedupKey(n))));
    }
  } catch (error) {
    logger.error('[Notifications] Error creating notification:', error);
    if (throwOnPersistenceError) throw error;
    return;
  }

  await deliverNotifications(inserted, emitEvent);
}

/**
 * Already notified: refresh the timestamp so the existing row floats back to the
 * top of the recipient's list, exactly as before. `updated_at` moves with it via
 * the column's own `$onUpdate`. A repeat is not
 * news, so it is neither emitted nor pushed.
 */
async function refreshRepeatedNotifications(
  repeats: readonly CreateNotificationData[],
): Promise<void> {
  if (repeats.length === 0) return;
  const groups = new Map<string, { sample: CreateNotificationData; recipients: string[] }>();
  for (const n of repeats) {
    const key = dedupKey({ ...n, recipientId: '' });
    const group = groups.get(key);
    if (group) group.recipients.push(n.recipientId);
    else groups.set(key, { sample: n, recipients: [n.recipientId] });
  }
  const db = getDb();
  for (const { sample, recipients } of groups.values()) {
    await db
      .update(notifications)
      .set({ createdAt: new Date() })
      .where(
        and(
          inArray(notifications.recipientId, recipients),
          eq(notifications.actorId, sample.actorId),
          eq(notifications.type, sample.type),
          eq(notifications.entityId, sample.entityId),
        ),
      );
  }
}

const SYSTEM_ACTOR: NotificationActorProfile = {
  id: 'system',
  username: 'system',
  displayName: 'System',
};

/**
 * The actor and post lookups for ONE fan-out, memoized. Every notification of a
 * fan-out is about the same actor (and usually the same post), and the socket
 * payload and the push body both need the actor: without the memo, a post to 200
 * subscribers asked Oxy for its author 400 times. A failure resolves to `null`
 * — both consumers already degrade to a neutral name.
 */
function createDeliveryLookups(): PushLookups & {
  actor(actorId: string): Promise<NotificationActorProfile | null>;
} {
  const actors = new Map<string, Promise<NotificationActorProfile | null>>();
  const posts = new Map<string, ReturnType<PushLookups['post']>>();
  return {
    actor(actorId) {
      if (actorId === 'system') return Promise.resolve(SYSTEM_ACTOR);
      let pending = actors.get(actorId);
      if (!pending) {
        pending = getServiceOxyClient()
          .users.get(actorId)
          .then((user): NotificationActorProfile | null => user ?? null)
          .catch(() => null);
        actors.set(actorId, pending);
      }
      return pending;
    },
    post(postId) {
      let pending = posts.get(postId);
      if (!pending) {
        pending = loadPostRecord(postId).catch(() => null);
        posts.set(postId, pending);
      }
      return pending;
    },
  };
}

/**
 * Emit and push the notifications that were just INSERTED (never the repeats).
 *
 * The push targets are read in one query per notification type for the whole
 * fan-out (`loadPushTargets`: devices and settings together), so a recipient with
 * no device — most of them — costs nothing past that query. Best-effort
 * throughout: a failure here never undoes or fails the write.
 */
async function deliverNotifications(
  rows: readonly (typeof notifications.$inferSelect)[],
  emitEvent: boolean,
): Promise<void> {
  if (rows.length === 0) return;
  const lookups = createDeliveryLookups();

  const io = emitEvent ? getRuntimeSocketServer() : undefined;
  if (io) {
    const notificationsNamespace = io.of('/notifications');
    await Promise.all(
      rows.map(async (row) => {
        const actor = row.actorId ? await lookups.actor(row.actorId) : null;
        notificationsNamespace.to(`user:${row.recipientId}`).emit('notification', {
          ...serializeNotification(row),
          actorId_populated: toPopulatedActor(actor, row.actorId),
        });
      }),
    );
  }

  try {
    const byType = new Map<(typeof rows)[number]['type'], (typeof rows)[number][]>();
    for (const row of rows) {
      const group = byType.get(row.type);
      if (group) group.push(row);
      else byType.set(row.type, [row]);
    }
    for (const [type, group] of byType) {
      const targets = await loadPushTargets(
        group.map((row) => row.recipientId),
        type,
      );
      if (targets.size === 0) continue;
      await mapWithConcurrency(
        group.filter((row) => targets.has(row.recipientId)),
        NOTIFICATION_FANOUT_CONCURRENCY,
        async (row) => {
          const push = await formatPushForNotification(row, lookups);
          await sendPushToTokens(targets.get(row.recipientId) ?? [], push);
        },
      );
    }
  } catch (error) {
    logger.debug('[Notifications] push delivery failed', { error });
  }

  logger.debug('[Notifications] notifications created', { count: rows.length });
}

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
  emitEvent: boolean = true,
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

    await writeNotifications(
      uniqueUserIds.map((recipientId) => ({
        recipientId,
        actorId,
        type: 'mention' as const,
        entityId: postId,
        entityType,
      })),
      { emitEvent },
    );
  } catch (error) {
    logger.error('[Notifications] Error creating mention notifications:', error);
  }
};

/**
 * Creates a welcome notification for new users
 */
export const createWelcomeNotification = async (
  userId: string,
  emitEvent: boolean = true,
): Promise<void> => {
  try {
    await createNotification(
      {
        recipientId: userId,
        actorId: 'system', // System-generated notification
        type: 'welcome',
        entityId: userId,
        entityType: 'profile',
      },
      emitEvent,
    );
  } catch (error) {
    logger.error('[Notifications] Error creating welcome notification:', error);
  }
};

/**
 * Create notifications for many recipients — `PostCreationService`'s subscriber
 * fan-out is the big caller, and it selects every `post_subscriptions` row for
 * the author with no LIMIT, so a popular author's post arrives here with as many
 * entries as they have subscribers.
 *
 * It costs a multi-row INSERT per 500 recipients, one Oxy lookup for the actor,
 * one push-target query, and an FCM send per recipient that has a device — see
 * {@link writeNotifications}. It once cost an INSERT, an Oxy lookup (twice, for
 * the socket and the push) and two SELECTs per recipient.
 */
export const createBatchNotifications = async (
  notifications: CreateNotificationData[],
  emitEvent: boolean = true,
): Promise<void> => {
  try {
    await writeNotifications(notifications, { emitEvent });
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
  await writeNotifications(recipients.map((recipientId) => ({ ...data, recipientId })));
};

/** Durable-worker variant: persistence failures reject for outbox retry. */
export const createPostAuthorNotificationsStrict = async (
  authorship: PostAuthorshipEntry[] | undefined,
  data: Omit<CreateNotificationData, 'recipientId'>,
): Promise<void> => {
  const recipients = getNotificationRecipients(normalizeAuthorship(authorship));
  await writeNotifications(
    recipients.map((recipientId) => ({ ...data, recipientId })),
    { throwOnPersistenceError: true },
  );
};
