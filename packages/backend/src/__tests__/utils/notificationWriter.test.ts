/**
 * `createNotification` against real rows — the notification WRITER.
 *
 * The whole point of this file is one guarantee: **the unique index IS the
 * idempotency.** `notifications_dedup_key` on
 * `(recipient_id, actor_id, type, entity_id)` is what stops a second like from
 * the same actor on the same post minting a second row, and the Mongo version
 * expressed that as read-then-write — two concurrent callers could both pass the
 * read. The port moved it into `ON CONFLICT DO NOTHING` on those four columns.
 *
 * A test that only asserted "a row exists" would pass against a writer with no
 * conflict handling at all, so every case below asserts the ROW COUNT, and the
 * side effects (socket emit, push) are counted too: a repeat that silently
 * re-notified would be invisible in the table.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  getRuntimeSocketServer: vi.fn(),
  formatPushForNotification: vi.fn(),
  sendPushToUser: vi.fn(),
  getUserById: vi.fn(),
}));

vi.mock('../../runtime/socketServer', () => ({
  getRuntimeSocketServer: mocks.getRuntimeSocketServer,
}));

// Push delivery has its own suite; here it is only counted.
vi.mock('../../utils/push', () => ({
  formatPushForNotification: mocks.formatPushForNotification,
  sendPushToUser: mocks.sendPushToUser,
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ getUserById: mocks.getUserById }),
}));

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { notifications } from '../../db/schema/discovery';
import { createNotification, createWelcomeNotification } from '../../utils/notificationUtils';

let db: Database;
const createdRecipientIds: string[] = [];

/** A recipient id unique to one test, so rows cannot leak between them. */
function recipientId(): string {
  const id = `oxy-recipient-${randomUUID()}`;
  createdRecipientIds.push(id);
  return id;
}

function rowsFor(recipient: string) {
  return db.select().from(notifications).where(eq(notifications.recipientId, recipient));
}

/** The room a socket payload was emitted to, plus the payload itself. */
function captureEmits() {
  const emitted: { room: string; event: string; payload: unknown }[] = [];
  const to = vi.fn((room: string) => ({
    emit: (event: string, payload: unknown) => {
      emitted.push({ room, event, payload });
    },
  }));
  mocks.getRuntimeSocketServer.mockReturnValue({ of: () => ({ to }) });
  return emitted;
}

beforeAll(async () => {
  db = await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRuntimeSocketServer.mockReturnValue(undefined);
  mocks.formatPushForNotification.mockResolvedValue({ title: 't', body: 'b', data: {} });
  mocks.sendPushToUser.mockResolvedValue(undefined);
  mocks.getUserById.mockResolvedValue({
    id: 'oxy-actor',
    username: 'actor',
    name: { displayName: 'Actor' },
  });
});

afterEach(async () => {
  if (createdRecipientIds.length > 0) {
    await db.delete(notifications).where(inArray(notifications.recipientId, createdRecipientIds));
    createdRecipientIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('createNotification idempotency', () => {
  it('writes exactly ONE row for the same (recipient, actor, type, entity) twice', async () => {
    const recipient = recipientId();
    const data = {
      recipientId: recipient,
      actorId: 'oxy-actor',
      type: 'like' as const,
      entityId: 'post-1',
      entityType: 'post' as const,
    };

    await createNotification(data);
    // The second call must NOT throw: the conflict is handled in the statement,
    // not caught as a duplicate-key error after the fact.
    await expect(createNotification(data)).resolves.toBeUndefined();

    const rows = await rowsFor(recipient);
    expect(rows).toHaveLength(1);
  });

  it('refreshes createdAt on the repeat, so the row floats back to the top', async () => {
    const recipient = recipientId();
    const data = {
      recipientId: recipient,
      actorId: 'oxy-actor',
      type: 'like' as const,
      entityId: 'post-1',
      entityType: 'post' as const,
    };

    await createNotification(data);
    const [first] = await rowsFor(recipient);
    // Backdate the row so the refresh is unambiguous rather than a same-tick tie.
    const backdated = new Date(first.createdAt.getTime() - 60_000);
    await db.update(notifications).set({ createdAt: backdated }).where(eq(notifications.id, first.id));

    await createNotification(data);

    const [refreshed] = await rowsFor(recipient);
    expect(refreshed.id).toBe(first.id);
    expect(refreshed.createdAt.getTime()).toBeGreaterThan(backdated.getTime());
  });

  it('notifies exactly once — a repeat emits no socket event and sends no push', async () => {
    const recipient = recipientId();
    const emitted = captureEmits();
    const data = {
      recipientId: recipient,
      actorId: 'oxy-actor',
      type: 'like' as const,
      entityId: 'post-1',
      entityType: 'post' as const,
    };

    await createNotification(data);
    await createNotification(data);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].room).toBe(`user:${recipient}`);
    expect(emitted[0].event).toBe('notification');
    expect(mocks.sendPushToUser).toHaveBeenCalledTimes(1);
  });

  it('treats a DIFFERENT type on the same entity as a different notification', async () => {
    // The dedupe key includes `type`: a like and a boost on one post are two
    // notifications, and collapsing them would silently swallow engagement.
    const recipient = recipientId();
    const base = {
      recipientId: recipient,
      actorId: 'oxy-actor',
      entityId: 'post-1',
      entityType: 'post' as const,
    };

    await createNotification({ ...base, type: 'like' });
    await createNotification({ ...base, type: 'boost' });

    const rows = await rowsFor(recipient);
    expect(rows.map((row) => row.type).sort()).toEqual(['boost', 'like']);
  });

  it('treats a DIFFERENT actor on the same entity as a different notification', async () => {
    const recipient = recipientId();
    const base = {
      recipientId: recipient,
      type: 'like' as const,
      entityId: 'post-1',
      entityType: 'post' as const,
    };

    await createNotification({ ...base, actorId: 'oxy-actor-a' });
    await createNotification({ ...base, actorId: 'oxy-actor-b' });

    const rows = await rowsFor(recipient);
    expect(rows).toHaveLength(2);
  });
});

describe('createNotification refusals', () => {
  it('never notifies a user about their own action', async () => {
    const recipient = recipientId();
    await createNotification({
      recipientId: recipient,
      actorId: recipient,
      type: 'like',
      entityId: 'post-1',
      entityType: 'post',
    });

    expect(await rowsFor(recipient)).toEqual([]);
    expect(mocks.sendPushToUser).not.toHaveBeenCalled();
  });

  it('swallows a persistence failure by default and rethrows when asked to', async () => {
    // `entity_type` is CHECK-constrained; an unlisted value is the cheapest real
    // write failure. The default is fire-and-forget (a like must not 500 because
    // its notification failed); the durable-worker variant needs the rejection.
    const recipient = recipientId();
    const invalid = {
      recipientId: recipient,
      actorId: 'oxy-actor',
      type: 'like' as const,
      entityId: 'post-1',
      // The CHECK is what this exercises, so the value is deliberately outside
      // the union the type declares.
      entityType: 'not-a-real-entity-type' as 'post',
    };

    await expect(createNotification(invalid)).resolves.toBeUndefined();
    await expect(createNotification(invalid, true, true)).rejects.toThrow();
    expect(await rowsFor(recipient)).toEqual([]);
  });
});

describe('the socket payload is the wire DTO', () => {
  it('emits _id (not id) and the entity fields the client contract requires', async () => {
    // `ZRawNotification` in the frontend declares `_id`, `recipientId`, `actorId`,
    // `type`, `entityId`, `entityType`, `read` and `createdAt` as REQUIRED. A
    // payload keyed on drizzle's `id` would fail validation on every client.
    const recipient = recipientId();
    const emitted = captureEmits();

    await createNotification({
      recipientId: recipient,
      actorId: 'oxy-actor',
      type: 'reply',
      entityId: 'post-9',
      entityType: 'reply',
    });

    const [row] = await rowsFor(recipient);
    expect(emitted[0].payload).toMatchObject({
      _id: row.id,
      recipientId: recipient,
      actorId: 'oxy-actor',
      type: 'reply',
      entityId: 'post-9',
      entityType: 'reply',
      read: false,
      actorId_populated: { _id: 'oxy-actor', username: 'actor' },
    });
    expect(emitted[0].payload).not.toHaveProperty('id');
  });

  it('does not emit at all when the caller opted out', async () => {
    const recipient = recipientId();
    const emitted = captureEmits();

    await createNotification(
      {
        recipientId: recipient,
        actorId: 'oxy-actor',
        type: 'like',
        entityId: 'post-1',
        entityType: 'post',
      },
      false,
    );

    expect(emitted).toEqual([]);
    expect(await rowsFor(recipient)).toHaveLength(1);
  });
});

describe('welcome notifications', () => {
  it('stores the system actor and the user id as the profile entity', async () => {
    // `entity_id` is polymorphic and carries NO foreign key: for a `profile`
    // notification it holds an Oxy account id, not a `posts.id`.
    const recipient = recipientId();
    await createWelcomeNotification(recipient);

    const [row] = await rowsFor(recipient);
    expect(row).toMatchObject({
      actorId: 'system',
      type: 'welcome',
      entityId: recipient,
      entityType: 'profile',
    });
  });
});

describe('the dedupe constraint itself', () => {
  it('rejects a hand-written duplicate, so the writer is not the only thing enforcing it', async () => {
    // The vacuity floor for this whole file: if the unique index were missing,
    // every assertion above could still pass on a writer that simply never
    // inserted twice by accident.
    const recipient = recipientId();
    const values = {
      recipientId: recipient,
      actorId: 'oxy-actor',
      type: 'like' as const,
      entityId: 'post-1',
      entityType: 'post' as const,
    };
    await db.insert(notifications).values(values);
    await expect(db.insert(notifications).values(values)).rejects.toThrow();

    const rows = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.recipientId, recipient), eq(notifications.entityId, 'post-1')));
    expect(rows).toHaveLength(1);
  });
});
