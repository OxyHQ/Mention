import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { EventDetails, type EventEdit, type EventState } from '@mention/contracts';
import { getDb, type Transaction } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { eventAttendance } from '../db/schema/events';
import { lockPostContent } from '../db/posts/postRepository';
import { invalidate } from './postDetailCache';
import { writeEventNotifications, deliverEventNotifications } from '../utils/notificationUtils';

type EventPost = typeof posts.$inferSelect;
export class EventError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export type EventAccess = {
  viewerId: string;
  /** Resolve network/pool reads before opening the transaction. */
  prepare?(): Promise<void>;
  assertCurrent?(row: EventPost): void | Promise<void>;
  /** Fresh ACL reads under the parent lock, using the same DB connection. */
  read(tx: Transaction): Promise<boolean>;
  manage(row?: EventPost): Promise<boolean>;
};
function notFound(): never {
  throw new EventError(404, 'not_found', 'Event not found');
}
async function locked(tx: Transaction, postId: string, access: EventAccess, management = false) {
  // Same order as content replacement: advisory content lock THEN parent row.
  await lockPostContent(tx, postId);
  const [row] = await tx.select().from(posts).where(eq(posts.id, postId)).for('update');
  if (
    !row ||
    row.status !== 'published' ||
    !row.contentEventName ||
    !row.contentEventDate ||
    row.federationActorUri ||
    row.contentHomiioCaseId
  )
    notFound();
  await access.assertCurrent?.(row);
  if (!(await access.read(tx)) || (management && !(await access.manage(row)))) notFound();
  return row;
}
async function count(tx: Transaction, postId: string): Promise<number> {
  const [row] = await tx
    .select({ value: sql<number>`count(*)::int` })
    .from(eventAttendance)
    .where(eq(eventAttendance.postId, postId));
  return row.value;
}
function details(row: EventPost) {
  return {
    name: row.contentEventName!,
    date: row.contentEventDate!.toISOString(),
    location: row.contentEventLocation ?? undefined,
    description: row.contentEventDescription ?? undefined,
    capacity: row.contentEventCapacity,
  };
}
async function state(tx: Transaction, row: EventPost, access: EventAccess): Promise<EventState> {
  const [own] = await tx
    .select({ public: eventAttendance.public })
    .from(eventAttendance)
    .where(and(eq(eventAttendance.postId, row.id), eq(eventAttendance.oxyUserId, access.viewerId)));
  return {
    ...details(row),
    postId: row.id,
    cancelled: row.contentEventCancelled,
    revision: row.contentEventRevision,
    attendingCount: await count(tx, row.id),
    viewerAttendance: own ?? null,
    canManage: await access.manage(row),
  };
}
export async function getEventState(postId: string, access: EventAccess) {
  await access.prepare?.();
  return getDb().transaction(async (tx) => state(tx, await locked(tx, postId, access), access));
}
export async function registerForEvent(
  postId: string,
  access: EventAccess,
  publicAttendance: boolean,
) {
  await access.prepare?.();
  return getDb().transaction(async (tx) => {
    const row = await locked(tx, postId, access);
    const [existing] = await tx
      .select()
      .from(eventAttendance)
      .where(
        and(eq(eventAttendance.postId, postId), eq(eventAttendance.oxyUserId, access.viewerId)),
      );
    if (
      (!existing || publicAttendance) &&
      (row.contentEventCancelled || row.contentEventDate!.getTime() <= Date.now())
    ) {
      throw new EventError(409, 'conflict', 'This event is closed');
    }
    if (
      !existing &&
      row.contentEventCapacity !== null &&
      (await count(tx, postId)) >= row.contentEventCapacity
    ) {
      throw new EventError(409, 'conflict', 'This event is full');
    }
    await tx
      .insert(eventAttendance)
      .values({ postId, oxyUserId: access.viewerId, public: publicAttendance })
      .onConflictDoUpdate({
        target: [eventAttendance.postId, eventAttendance.oxyUserId],
        set: { public: publicAttendance },
      });
    return state(tx, row, access);
  });
}
export async function cancelEventAttendance(postId: string, access: EventAccess) {
  // Cancellation always lets the person withdraw their own participation, even
  // after visibility was revoked. It discloses no event or attendee facts.
  await getDb().transaction(async (tx) => {
    await lockPostContent(tx, postId);
    await tx.select({ id: posts.id }).from(posts).where(eq(posts.id, postId)).for('update');
    await tx
      .delete(eventAttendance)
      .where(
        and(eq(eventAttendance.postId, postId), eq(eventAttendance.oxyUserId, access.viewerId)),
      );
  });
}
export async function editEvent(
  postId: string,
  access: EventAccess,
  input: EventEdit | { cancelled: true; revision: number },
) {
  await access.prepare?.();
  const result = await getDb().transaction(async (tx) => {
    const row = await locked(tx, postId, access, true);
    const cancelling = 'cancelled' in input;
    const next = cancelling ? details(row) : EventDetails.parse(input);
    next.date = new Date(next.date).toISOString();
    const unchanged = cancelling
      ? row.contentEventCancelled
      : JSON.stringify(next) === JSON.stringify(details(row));
    if (unchanged) return { result: await state(tx, row, access), notices: [] };
    if (row.contentEventRevision !== input.revision)
      throw new EventError(409, 'conflict', 'The event changed. Refresh before saving.');
    if (row.contentEventCancelled)
      throw new EventError(409, 'conflict', 'A cancelled event cannot be reopened');
    if (next.capacity !== null && next.capacity < (await count(tx, postId)))
      throw new EventError(409, 'conflict', 'Capacity cannot be lower than current attendance');
    const [updated] = await tx
      .update(posts)
      .set({
        contentEventName: next.name,
        contentEventDate: new Date(next.date),
        contentEventLocation: next.location ?? null,
        contentEventDescription: next.description ?? null,
        contentEventCapacity: next.capacity,
        contentEventCancelled: cancelling,
        contentEventRevision: row.contentEventRevision + 1,
      })
      .where(eq(posts.id, postId))
      .returning();
    const attendees = await tx
      .select({ id: eventAttendance.oxyUserId })
      .from(eventAttendance)
      .where(eq(eventAttendance.postId, postId));
    const notices = await writeEventNotifications(tx, {
      postId,
      actorId: access.viewerId,
      recipients: attendees.map((a) => a.id),
      cancelled: cancelling,
    });
    return { result: await state(tx, updated, access), notices };
  });
  await invalidate(postId);
  await deliverEventNotifications(result.notices);
  return result.result;
}
export async function listEventAttendees(
  postId: string,
  access: EventAccess,
  full: boolean,
  cursor?: string,
) {
  await access.prepare?.();
  return getDb().transaction(async (tx) => {
    await locked(tx, postId, access, full);
    let after: string | undefined;
    if (cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (parsed.postId !== postId || parsed.full !== full || typeof parsed.after !== 'string')
          throw new Error();
        after = parsed.after;
      } catch {
        throw new EventError(400, 'bad_request', 'Invalid cursor');
      }
    }
    const rows = await tx
      .select({ oxyUserId: eventAttendance.oxyUserId, public: eventAttendance.public })
      .from(eventAttendance)
      .where(
        and(
          eq(eventAttendance.postId, postId),
          full ? undefined : eq(eventAttendance.public, true),
          after ? gt(eventAttendance.oxyUserId, after) : undefined,
        ),
      )
      .orderBy(asc(eventAttendance.oxyUserId))
      .limit(51);
    const items = rows.slice(0, 50);
    return {
      items,
      nextCursor:
        rows.length > 50
          ? Buffer.from(JSON.stringify({ postId, full, after: items[49].oxyUserId })).toString(
              'base64url',
            )
          : null,
    };
  });
}
