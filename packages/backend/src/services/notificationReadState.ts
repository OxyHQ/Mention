/**
 * Marking notifications read — the ONE implementation, shared by the REST route
 * and the socket handler.
 *
 * ## Why this module exists
 *
 * There were two implementations and they addressed different databases.
 * `routes/notifications.ts` read and wrote `notifications` in Postgres; the
 * `markNotificationRead` / `markAllNotificationsRead` socket handlers in
 * `server.ts` still wrote the Mongoose model, which nothing reads any more. A
 * notification marked read over the socket therefore came back UNREAD on the
 * next load, for every user, with nothing in any log: both halves behaved
 * correctly on their own and simply disagreed about where the state lived.
 *
 * One store was the fix; one implementation is what stops it recurring. The two
 * call sites also emitted different shapes for the same event — the socket sent
 * a raw Mongoose document with a populated `actorId`, the route sent the
 * enriched wire DTO — so they now agree on that too.
 *
 * ## Recipient scoping lives in the UPDATE's predicate
 *
 * Not a read followed by a write: an id naming someone else's notification
 * updates no row and reports nothing, with no window in which the ownership that
 * was checked differs from the ownership that was written.
 */

import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { notifications } from '../db/schema/discovery';
import {
  toPopulatedActor,
  type NotificationActorProfile as ActorProfile,
} from '../utils/notificationActor';
import { serializeNotification } from '../utils/notificationUtils';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { logger } from '../utils/logger';

/**
 * Minimal read-surface of an actor profile consumed by `toPopulatedActor`.
 * `getUsersByIds`/`getUserById` return full `User` objects (assignable to this),
 * while the synthetic `system` actor only needs these fields.
 */
export const SYSTEM_ACTOR: ActorProfile = {
  id: 'system',
  username: 'system',
  name: { displayName: 'System' },
  avatar: undefined,
};

/** The wire shape both the REST response and the socket event carry. */
export type EnrichedNotification = ReturnType<typeof serializeNotification> & {
  actorId_populated: ReturnType<typeof toPopulatedActor>;
};

/**
 * Enrich a single notification with its actor profile the SAME way the GET list
 * handler does. `actorId` holds an Oxy user id, NOT a relation, so the actor must
 * be resolved through Oxy. On a lookup failure the notification is returned
 * unenriched so the read-state write is never blocked.
 */
export async function enrichNotificationActor(
  notification: typeof notifications.$inferSelect,
): Promise<EnrichedNotification> {
  const actorId = notification.actorId;
  let actor: ActorProfile | undefined;
  if (actorId === 'system') {
    actor = SYSTEM_ACTOR;
  } else if (actorId) {
    try {
      const [profile] = await getServiceOxyClient().getUsersByIds([actorId]);
      if (profile?.id) actor = profile;
    } catch (e) {
      logger.warn('[Notifications] Failed to resolve actor profile:', e);
    }
  }
  return {
    ...serializeNotification(notification),
    actorId_populated: toPopulatedActor(actor, actorId),
  };
}

/**
 * Mark one of `recipientId`'s notifications read.
 *
 * @returns The enriched notification, or `undefined` when no notification with
 *   that id belongs to this recipient — which the caller must treat as "not
 *   theirs, or not there", never as a write that silently did nothing.
 */
export async function markNotificationRead(
  recipientId: string,
  notificationId: string,
): Promise<EnrichedNotification | undefined> {
  const [notification] = await getDb()
    .update(notifications)
    .set({ read: true })
    .where(and(eq(notifications.id, notificationId), eq(notifications.recipientId, recipientId)))
    .returning();

  if (!notification) return undefined;
  return enrichNotificationActor(notification);
}

/** Mark every one of `recipientId`'s notifications read. */
export async function markAllNotificationsRead(recipientId: string): Promise<void> {
  await getDb()
    .update(notifications)
    .set({ read: true })
    .where(eq(notifications.recipientId, recipientId));
}
