/**
 * `/notifications` against real rows — pagination, read state, and push tokens.
 *
 * Three properties are load-bearing here and none of them is visible in a mock:
 *
 *  - **Keyset pagination.** The list orders by `(created_at DESC, id DESC)` and
 *    the cursor compares the same PAIR, served whole by
 *    `notifications_recipient_keyset_idx`. The order is strictly total because
 *    `id` is unique — take the range or the order off the SAME columns and a page
 *    boundary starts repeating or skipping rows. That the leading key is
 *    `created_at` rather than `id` is the subject of
 *    `notificationsCursorOrdering.test.ts`; the cases HERE seed one id shape, so
 *    `id DESC` and `created_at DESC` agree and they cannot see it.
 *  - **Recipient scoping is inside every predicate**, so one user can never read,
 *    mark or delete another's notification. A read-then-write would have a window
 *    where the ownership that was checked is not the ownership that was written.
 *  - **`push_tokens.token` is GLOBALLY unique** — one device, one row, owned by
 *    whichever account registered it last. A re-registration must MOVE the row.
 *
 * `PostHydrationService` is stubbed — the referenced posts are not what this
 * file is about; everything it IS about is a real row in a real database.
 */

import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  hydratePosts: vi.fn(),
  getUsersByIds: vi.fn(),
  createScopedOxyClient: vi.fn(),
  loadFollowedAuthorIds: vi.fn(),
}));

vi.mock('../../middleware/rateLimiter', () => ({
  apiRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: mocks.hydratePosts },
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: mocks.createScopedOxyClient,
  // The route hands this to `resolveNotificationInboxIds`; a module factory
  // replaces the WHOLE module, so an export the route calls and this factory
  // omits is `undefined is not a function` on every request. Which recipient ids
  // the inbox covers is `notificationsChannelInbox.test.ts`'s subject; held at
  // "just the viewer" here so these cases stay about pagination and ordering.
  createUserScopedOxyServices: () => undefined,
  getServiceOxyClient: () => ({ getUsersByIds: mocks.getUsersByIds }),
}));

vi.mock('../../utils/mediaResolver', () => ({
  resolveAvatarUrl: (value?: string) => value,
}));

vi.mock('../../utils/push', () => ({
  sendPushToUser: vi.fn(),
  formatPushForNotification: vi.fn(),
}));

vi.mock('../../services/viewerFollowGraph', () => ({
  loadFollowedAuthorIds: mocks.loadFollowedAuthorIds,
}));

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { uuidv7 } from '../../db/schema/columns';
import { decodeChronoCursor, encodeChronoCursor } from '../../utils/chronoCursor';
import { notifications, pushTokens } from '../../db/schema/discovery';
import notificationsRouter from '../../routes/notifications';

let db: Database;
const createdRecipientIds: string[] = [];
const createdTokens: string[] = [];

function viewerId(): string {
  const id = `oxy-viewer-${randomUUID()}`;
  createdRecipientIds.push(id);
  return id;
}

/**
 * A 24-char ObjectId-shaped id, ascending with `index`.
 *
 * Pre-cutover rows keep their ObjectId verbatim, so this is the id shape the
 * list actually pages over today — and, being zero-padded hex, its lexicographic
 * order is its numeric order, which makes the expected page contents readable
 * rather than something the test has to sort for itself.
 */
function objectIdShaped(index: number): string {
  return index.toString(16).padStart(24, '0');
}

interface SeedOptions {
  id: string;
  actorId?: string;
  type?: 'like' | 'reply' | 'mention' | 'post' | 'follow';
  entityId?: string;
  entityType?: 'post' | 'reply' | 'profile';
  read?: boolean;
}

/**
 * `entityId` defaults to the row id because `notifications_dedup_key` is
 * `(recipient, actor, type, entity)` — seeding several rows for one recipient
 * with a shared entity is a duplicate, not a fixture.
 */
async function seed(recipient: string, options: SeedOptions) {
  const [row] = await db
    .insert(notifications)
    .values({
      id: options.id,
      recipientId: recipient,
      actorId: options.actorId ?? 'oxy-actor-1',
      type: options.type ?? 'like',
      entityId: options.entityId ?? `post-${options.id}`,
      entityType: options.entityType ?? 'post',
      read: options.read ?? false,
    })
    .returning();
  return row;
}

function makeApp(viewer: string | undefined, emitted: unknown[] = []) {
  const app = express();
  app.use(express.json());
  app.set('notificationsNamespace', {
    to: () => ({ emit: (event: string, payload: unknown) => emitted.push({ event, payload }) }),
  });
  app.use((req, _res, next) => {
    if (viewer) (req as typeof req & { user: { id: string } }).user = { id: viewer };
    next();
  });
  app.use('/', notificationsRouter);
  return app;
}

beforeAll(async () => {
  db = await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUsersByIds.mockResolvedValue([]);
  mocks.createScopedOxyClient.mockReturnValue({ scope: 'viewer' });
  mocks.loadFollowedAuthorIds.mockResolvedValue(new Set<string>());
  mocks.hydratePosts.mockResolvedValue([]);
});

afterEach(async () => {
  if (createdRecipientIds.length > 0) {
    await db.delete(notifications).where(inArray(notifications.recipientId, createdRecipientIds));
    createdRecipientIds.length = 0;
  }
  if (createdTokens.length > 0) {
    await db.delete(pushTokens).where(inArray(pushTokens.token, createdTokens));
    createdTokens.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('GET /notifications keyset pagination', () => {
  it('walks every row exactly once across pages, with no repeat and no gap', async () => {
    const viewer = viewerId();
    for (let index = 1; index <= 5; index += 1) {
      await seed(viewer, { id: objectIdShaped(index), entityId: `post-${index}` });
    }

    const app = makeApp(viewer);
    const first = await request(app).get('/').query({ limit: 2 }).expect(200);
    expect(first.body.notifications.map((n: { _id: string }) => n._id)).toEqual([
      objectIdShaped(5),
      objectIdShaped(4),
    ]);
    expect(first.body.hasMore).toBe(true);
    // The cursor is an OPAQUE token over the `(created_at, id)` pair the page is
    // ordered on, not the bare id it used to be — asserted by decoding rather
    // than by shape, so the assertion says which ROW it anchors on.
    expect(decodeChronoCursor(first.body.nextCursor)?.id).toBe(objectIdShaped(4));

    const second = await request(app)
      .get('/')
      .query({ limit: 2, cursor: first.body.nextCursor })
      .expect(200);
    expect(second.body.notifications.map((n: { _id: string }) => n._id)).toEqual([
      objectIdShaped(3),
      objectIdShaped(2),
    ]);

    const third = await request(app)
      .get('/')
      .query({ limit: 2, cursor: second.body.nextCursor })
      .expect(200);
    expect(third.body.notifications.map((n: { _id: string }) => n._id)).toEqual([
      objectIdShaped(1),
    ]);
    expect(third.body.hasMore).toBe(false);
    expect(third.body.nextCursor).toBeUndefined();

    // The union of the three pages IS the seeded set — the assertion a
    // duplicated or skipped row cannot survive.
    const seen = [first, second, third].flatMap((response) =>
      response.body.notifications.map((n: { _id: string }) => n._id),
    );
    expect(new Set(seen).size).toBe(5);
  });

  it('pages over uuid v7 ids too, which is every row created after the cutover', async () => {
    // Sorted, because two v7s minted in the same millisecond differ only in
    // their random bits — the ORDER is what this asserts, not the generator.
    const ids = [uuidv7(), uuidv7(), uuidv7(), uuidv7()].sort();
    const viewer = viewerId();
    for (const id of ids) await seed(viewer, { id });

    const app = makeApp(viewer);
    const first = await request(app).get('/').query({ limit: 2 }).expect(200);
    expect(first.body.notifications.map((n: { _id: string }) => n._id)).toEqual(
      [...ids].reverse().slice(0, 2),
    );

    const second = await request(app)
      .get('/')
      .query({ limit: 2, cursor: first.body.nextCursor })
      .expect(200);
    expect(second.body.notifications.map((n: { _id: string }) => n._id)).toEqual(
      [...ids].reverse().slice(2),
    );
  });

  it('never returns another user’s notifications', async () => {
    const viewer = viewerId();
    const stranger = viewerId();
    await seed(viewer, { id: objectIdShaped(1) });
    await seed(stranger, { id: objectIdShaped(2) });

    const res = await request(makeApp(viewer)).get('/').expect(200);
    expect(res.body.notifications.map((n: { _id: string }) => n._id)).toEqual([objectIdShaped(1)]);
  });

  it('400s a malformed cursor rather than silently serving an arbitrary page', async () => {
    // Every column in the keyset is comparable against nonsense, so a tampered
    // token would return a plausible-looking page. `nonsense` is the shape a
    // client sends by mistake; a bare id is the shape the PREVIOUS wire contract
    // used, and it is refused too — the format changed as a clean cut, so a
    // client still holding one gets one 400 and refetches page 1.
    const viewer = viewerId();
    await seed(viewer, { id: objectIdShaped(1) });

    for (const cursor of ['nonsense', objectIdShaped(1), uuidv7()]) {
      const res = await request(makeApp(viewer)).get('/').query({ cursor }).expect(400);
      expect(res.body.error).toBe('INVALID_CURSOR');
    }
  });

  it('accepts a cursor anchored on either live id shape', async () => {
    const viewer = viewerId();
    for (const id of [objectIdShaped(9), uuidv7()]) {
      const cursor = encodeChronoCursor(new Date('2026-01-01T00:00:00.000Z'), id);
      await request(makeApp(viewer)).get('/').query({ cursor }).expect(200);
    }
  });

  it('clamps the page size and rejects an anonymous viewer', async () => {
    const viewer = viewerId();
    for (let index = 1; index <= 3; index += 1) await seed(viewer, { id: objectIdShaped(index) });

    const clamped = await request(makeApp(viewer)).get('/').query({ limit: 5000 }).expect(200);
    expect(clamped.body.limit).toBe(50);

    const floored = await request(makeApp(viewer)).get('/').query({ limit: -3 }).expect(200);
    expect(floored.body.limit).toBe(1);
    expect(floored.body.notifications).toHaveLength(1);

    await request(makeApp(undefined)).get('/').expect(401);
  });
});

describe('GET /notifications wire format', () => {
  it('emits the exact keys the frontend contract declares required', async () => {
    const viewer = viewerId();
    const row = await seed(viewer, {
      id: objectIdShaped(1),
      actorId: 'oxy-actor-7',
      type: 'reply',
      entityId: 'post-42',
      entityType: 'reply',
    });

    const res = await request(makeApp(viewer)).get('/').expect(200);
    const [notification] = res.body.notifications;

    // `ZRawNotification` requires all of these; `entityId` is a string and
    // `createdAt` an ISO string over the wire.
    expect(notification).toMatchObject({
      _id: row.id,
      recipientId: viewer,
      actorId: 'oxy-actor-7',
      type: 'reply',
      entityId: 'post-42',
      entityType: 'reply',
      read: false,
    });
    expect(typeof notification.createdAt).toBe('string');
    expect(new Date(notification.createdAt).toISOString()).toBe(notification.createdAt);
    expect(notification).not.toHaveProperty('__v');
    expect(notification).not.toHaveProperty('id');
  });

  it('counts unread separately from the page, and both endpoints agree', async () => {
    const viewer = viewerId();
    await seed(viewer, { id: objectIdShaped(1), read: false, entityId: 'a' });
    await seed(viewer, { id: objectIdShaped(2), read: false, entityId: 'b' });
    await seed(viewer, { id: objectIdShaped(3), read: true, entityId: 'c' });

    const list = await request(makeApp(viewer)).get('/').query({ limit: 1 }).expect(200);
    // A single-row PAGE, but the aggregate is over every unread row.
    expect(list.body.notifications).toHaveLength(1);
    expect(list.body.unreadCount).toBe(2);

    const counted = await request(makeApp(viewer)).get('/unread-count').expect(200);
    expect(counted.body.count).toBe(2);
  });
});

describe('read state', () => {
  it.each(['put', 'patch'] as const)('%ss a single notification read and emits it', async (method) => {
    const viewer = viewerId();
    const row = await seed(viewer, { id: objectIdShaped(1) });
    const emitted: unknown[] = [];

    const res = await request(makeApp(viewer, emitted))[method](`/${row.id}/read`).expect(200);
    expect(res.body.notification._id).toBe(row.id);
    expect(res.body.notification.read).toBe(true);
    expect(emitted).toHaveLength(1);

    const [stored] = await db.select().from(notifications).where(eq(notifications.id, row.id));
    expect(stored.read).toBe(true);
  });

  it('refuses to mark another user’s notification, and leaves it unread', async () => {
    const viewer = viewerId();
    const stranger = viewerId();
    const row = await seed(stranger, { id: objectIdShaped(1) });

    await request(makeApp(viewer)).put(`/${row.id}/read`).expect(404);

    // A rejection that had ALSO written would pass an assertion on the status
    // alone, so the row is checked.
    const [stored] = await db.select().from(notifications).where(eq(notifications.id, row.id));
    expect(stored.read).toBe(false);
  });

  it('404s an id that names no row, whatever its shape', async () => {
    const viewer = viewerId();
    for (const id of [uuidv7(), 'not-an-id-at-all']) {
      await request(makeApp(viewer)).put(`/${id}/read`).expect(404);
    }
  });

  it('marks all of the viewer’s notifications read and nobody else’s', async () => {
    const viewer = viewerId();
    const stranger = viewerId();
    await seed(viewer, { id: objectIdShaped(1), entityId: 'a' });
    await seed(viewer, { id: objectIdShaped(2), entityId: 'b' });
    const other = await seed(stranger, { id: objectIdShaped(3) });

    await request(makeApp(viewer)).put('/read-all').expect(200);

    const mine = await db.select().from(notifications).where(eq(notifications.recipientId, viewer));
    expect(mine.every((row) => row.read)).toBe(true);
    const [theirs] = await db.select().from(notifications).where(eq(notifications.id, other.id));
    expect(theirs.read).toBe(false);
  });

  it('archives by marking read and emits the row id', async () => {
    const viewer = viewerId();
    const row = await seed(viewer, { id: objectIdShaped(1) });
    const emitted: { event: string; payload: unknown }[] = [];

    await request(makeApp(viewer, emitted)).patch(`/${row.id}/archive`).expect(200);
    expect(emitted[0]).toEqual({ event: 'notificationArchived', payload: row.id });
  });
});

describe('DELETE /notifications/:id', () => {
  it('deletes the viewer’s own notification and emits its id', async () => {
    const viewer = viewerId();
    const row = await seed(viewer, { id: objectIdShaped(1) });
    const emitted: { event: string; payload: unknown }[] = [];

    await request(makeApp(viewer, emitted)).delete(`/${row.id}`).expect(200);
    expect(emitted[0]).toEqual({ event: 'notificationDeleted', payload: row.id });
    expect(await db.select().from(notifications).where(eq(notifications.id, row.id))).toEqual([]);
  });

  it('refuses another user’s notification and leaves the row in place', async () => {
    const viewer = viewerId();
    const stranger = viewerId();
    const row = await seed(stranger, { id: objectIdShaped(1) });

    await request(makeApp(viewer)).delete(`/${row.id}`).expect(404);
    expect(await db.select().from(notifications).where(eq(notifications.id, row.id))).toHaveLength(1);
  });
});

describe('push tokens', () => {
  function token(): string {
    const value = `fcm-token-${randomUUID()}`;
    createdTokens.push(value);
    return value;
  }

  it('registers a device, then MOVES it when another account registers the same token', async () => {
    // `push_tokens_token_key` is global: one device, one row. A re-registration
    // by a second account must transfer ownership, not fail — otherwise a shared
    // or handed-down handset keeps pushing to the previous owner.
    const first = viewerId();
    const second = viewerId();
    const deviceToken = token();

    await request(makeApp(first))
      .post('/push-token')
      .send({ token: deviceToken, platform: 'android', type: 'fcm', deviceId: 'device-1' })
      .expect(200);

    await request(makeApp(second))
      .post('/push-token')
      .send({ token: deviceToken, platform: 'ios', type: 'apns' })
      .expect(200);

    const rows = await db.select().from(pushTokens).where(eq(pushTokens.token, deviceToken));
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(second);
    expect(rows[0].platform).toBe('ios');
    // Mongoose dropped undefined paths from an update, so a re-registration that
    // omits `deviceId` must not blank the one already stored.
    expect(rows[0].deviceId).toBe('device-1');
  });

  it('falls back to the column default for a value the CHECK would reject', async () => {
    // Mongoose ran no validators on this upsert, so `platform: 'windows'` was
    // stored verbatim. The CHECK does not tolerate it; a client typo must not
    // become a 500.
    const viewer = viewerId();
    const deviceToken = token();

    await request(makeApp(viewer))
      .post('/push-token')
      .send({ token: deviceToken, platform: 'windows', type: 'expo' })
      .expect(200);

    const [row] = await db.select().from(pushTokens).where(eq(pushTokens.token, deviceToken));
    expect(row.platform).toBe('unknown');
    expect(row.type).toBe('unknown');
  });

  it('re-enables a token that delivery had disabled', async () => {
    const viewer = viewerId();
    const deviceToken = token();
    await request(makeApp(viewer)).post('/push-token').send({ token: deviceToken }).expect(200);
    await db.update(pushTokens).set({ enabled: false }).where(eq(pushTokens.token, deviceToken));

    await request(makeApp(viewer)).post('/push-token').send({ token: deviceToken }).expect(200);

    const [row] = await db.select().from(pushTokens).where(eq(pushTokens.token, deviceToken));
    expect(row.enabled).toBe(true);
    // `updated_at` is set explicitly on the conflict path: drizzle's `$onUpdate`
    // never fires for `ON CONFLICT ... DO UPDATE`, so a missing one would leave
    // the column frozen at creation time.
    expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(row.createdAt.getTime());
  });

  it('400s a missing or non-string token', async () => {
    const viewer = viewerId();
    await request(makeApp(viewer)).post('/push-token').send({}).expect(400);
    await request(makeApp(viewer)).post('/push-token').send({ token: ['a'] }).expect(400);
  });

  it('PRE-EXISTING BUG: DELETE /push-token is shadowed by DELETE /:id and never unregisters', async () => {
    /**
     * `router.delete('/:id')` is declared BEFORE `router.delete('/push-token')`,
     * so Express matches the parameterised route first and the unregister
     * handler is unreachable — a device can be registered but never removed, so
     * signing out does not stop the pushes.
     *
     * This predates the port and the port did not cause it, but it DID change
     * how it fails: Mongo cast `'push-token'` to an ObjectId, threw, and answered
     * 500, whereas a `text` id simply names no row and answers 404. Pinned here
     * rather than fixed, because reordering the routes revives a dead endpoint
     * and that is a behaviour change to decide deliberately, not a port. When
     * someone does fix it, this test goes red and points at the decision.
     */
    const owner = viewerId();
    const deviceToken = token();
    await request(makeApp(owner)).post('/push-token').send({ token: deviceToken }).expect(200);

    await request(makeApp(owner)).delete('/push-token').send({ token: deviceToken }).expect(404);
    expect(await db.select().from(pushTokens).where(eq(pushTokens.token, deviceToken))).toHaveLength(1);
  });
});
