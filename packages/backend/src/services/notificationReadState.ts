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
 *
 * ## The scope is a LIST, and that is what makes the narrowing visible
 *
 * A viewer's inbox is their own rows plus every CHANNEL they operate — a channel
 * has no session of its own, so its notifications are reachable no other way
 * (`services/notificationInbox`). Both functions therefore take the resolved id
 * set rather than one id, so a caller that means "just this person" has to say
 * so. The socket handlers in `server.ts` do exactly that, deliberately and with
 * their reason written beside them; passing a bare `userId` would have been the
 * same narrowing made by accident and invisible in review.
 */

import { and, eq, inArray } from 'drizzle-orm';
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
 * Mark one notification read, within `recipientIds` — the viewer plus any
 * channel they operate.
 *
 * @returns The enriched notification, or `undefined` when no notification with
 *   that id belongs to any of those recipients — which the caller must treat as
 *   "not theirs, or not there", never as a write that silently did nothing.
 */
export async function markNotificationRead(
  recipientIds: readonly string[],
  notificationId: string,
): Promise<EnrichedNotification | undefined> {
  // An empty scope must match NOTHING. Drizzle renders `inArray(col, [])` as a
  // false constant, so this is already the safe direction — asserted rather than
  // assumed, because the alternative rendering would mark every row in the table
  // read for a caller whose scope failed to resolve.
  if (recipientIds.length === 0) return undefined;

  const [notification] = await getDb()
    .update(notifications)
    .set({ read: true })
    .where(
      and(
        eq(notifications.id, notificationId),
        inArray(notifications.recipientId, [...recipientIds]),
      ),
    )
    .returning();

  if (!notification) return undefined;
  return enrichNotificationActor(notification);
}

/**
 * Mark every notification addressed to `recipientIds` read.
 *
 * Clears the CHANNEL rows too. A channel's inbox is shared by its operators (one
 * row per event, not one per operator), so this is deliberately a shared action:
 * leaving them out would leave the badge permanently non-zero with no control
 * that clears it.
 */
export async function markAllNotificationsRead(recipientIds: readonly string[]): Promise<void> {
  if (recipientIds.length === 0) return;

  await getDb()
    .update(notifications)
    .set({ read: true })
    .where(inArray(notifications.recipientId, [...recipientIds]));
}
