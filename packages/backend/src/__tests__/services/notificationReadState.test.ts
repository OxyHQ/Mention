/**
 * Marking notifications read, against real rows.
 *
 * This exists because of a live bug: `server.ts`'s socket handlers wrote the
 * Mongoose model while `routes/notifications.ts` read and wrote Postgres, so a
 * notification marked read over the socket came back UNREAD on the next load,
 * for every user, with nothing in any log. Neither half was wrong on its own —
 * they simply disagreed about where the state lived, which is why no test
 * caught it: each side had tests, and each side passed.
 *
 * So the assertion that matters here is not "the update ran" but **the read
 * afterwards sees it** — the round trip is the whole guarantee, and it is the
 * only shape that could have failed while both halves looked healthy.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, like } from 'drizzle-orm';

vi.mock('../../utils/oxyHelpers', () => ({
  // The actor resolve is not what this file is about, and an unresolved actor
  // must never block the read-state write — that is asserted below.
  getServiceOxyClient: () => ({ getUsersByIds: async () => [] }),
}));

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { notifications } from '../../db/schema/discovery';
import {
  markAllNotificationsRead,
  markNotificationRead,
} from '../../services/notificationReadState';

/** Namespaces every row this file writes, so a parallel file cannot collide. */
const OWNER_PREFIX = 'oxy-notif-read-';
const RECIPIENT = `${OWNER_PREFIX}recipient`;
const OTHER = `${OWNER_PREFIX}someone-else`;

let seq = 0;

async function seedNotification(recipientId: string, read = false): Promise<string> {
  seq += 1;
  const [row] = await getDb()
    .insert(notifications)
    .values({
      recipientId,
      actorId: `${OWNER_PREFIX}actor`,
      type: 'like',
      entityId: `${OWNER_PREFIX}entity-${seq}`,
      entityType: 'post',
      read,
    })
    .returning({ id: notifications.id });
  return row.id;
}

async function isRead(id: string): Promise<boolean | undefined> {
  const [row] = await getDb()
    .select({ read: notifications.read })
    .from(notifications)
    .where(eq(notifications.id, id))
    .limit(1);
  return row?.read;
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await getDb().delete(notifications).where(like(notifications.recipientId, `${OWNER_PREFIX}%`));
});

afterAll(async () => {
  await closePostgres();
});

describe('marking one notification read', () => {
  /**
   * The round trip — the exact shape the split store broke.
   *
   * Asserting only that the call resolved would have passed throughout the bug:
   * the Mongoose write succeeded, it just landed somewhere nothing reads.
   */
  it('persists, so a later read sees it', async () => {
    const id = await seedNotification(RECIPIENT);

    const enriched = await markNotificationRead(RECIPIENT, id);

    expect(enriched).toBeDefined();
    expect(await isRead(id)).toBe(true);
  });

  /**
   * Recipient scoping lives in the UPDATE's own predicate.
   *
   * A read-then-write leaves a window in which the ownership that was checked is
   * not the ownership that was written; this asks the database to enforce it in
   * one statement, so someone else's notification is untouched AND unreported.
   */
  it('will not mark a notification belonging to someone else', async () => {
    const theirs = await seedNotification(OTHER);

    await expect(markNotificationRead(RECIPIENT, theirs)).resolves.toBeUndefined();

    expect(await isRead(theirs)).toBe(false);
  });

  /**
   * `undefined` means "not theirs, or not there" — never a write that silently
   * did nothing. Both callers turn it into a 404 / a skipped emit.
   */
  it('answers undefined for an id that names no notification', async () => {
    await expect(markNotificationRead(RECIPIENT, 'no-such-notification')).resolves.toBeUndefined();
  });

  /** An actor Oxy cannot resolve must not block the read-state write. */
  it('still marks read when the actor profile does not resolve', async () => {
    const id = await seedNotification(RECIPIENT);

    const enriched = await markNotificationRead(RECIPIENT, id);

    expect(enriched?.actorId_populated).toBeDefined();
    expect(await isRead(id)).toBe(true);
  });
});

describe('marking every notification read', () => {
  it('marks all of the recipient\'s own, and none of anyone else\'s', async () => {
    const mine = [await seedNotification(RECIPIENT), await seedNotification(RECIPIENT)];
    const theirs = await seedNotification(OTHER);

    await markAllNotificationsRead(RECIPIENT);

    for (const id of mine) expect(await isRead(id)).toBe(true);
    expect(await isRead(theirs)).toBe(false);
  });
});
