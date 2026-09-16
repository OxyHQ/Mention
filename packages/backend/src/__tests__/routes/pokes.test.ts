/**
 * `/pokes` against real rows, including the notification it writes.
 *
 * A poke is one active row per ORDERED pair (`pokes_poker_id_poked_id_key`), so
 * A→B and B→A are two rows and a repeat of A→B is none. That matters beyond the
 * table: `POST /pokes/:userId` only notifies when a row was actually created, so
 * a double-tap must not send a second "poked you". `createNotification` is the
 * REAL writer here — the whole poke path is one cluster and asserting against a
 * spy would prove only that the route called something.
 */

import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, or } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  getUsersByIds: vi.fn(),
  getUserById: vi.fn(),
  getUserFollowers: vi.fn(),
  getUserFollowing: vi.fn(),
  sendPushToUser: vi.fn(),
  formatPushForNotification: vi.fn(),
  isUserBlocked: vi.fn(),
  userScopedClient: vi.fn(),
  getBlockedUserIds: vi.fn(),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUsersByIds: mocks.getUsersByIds,
    getUserById: mocks.getUserById,
    getUserFollowers: mocks.getUserFollowers,
    getUserFollowing: mocks.getUserFollowing,
  }),
  // A stand-in for the caller's own bearer-scoped client — real shape
  // verified in `oxyHelpers.test.ts`; here only the one method the block
  // check calls is exercised.
  createUserScopedOxyServices: (...args: unknown[]) => mocks.userScopedClient(...args),
  // The route also asks for this to feed `getBlockedUserIds`; its own return
  // value is irrelevant since that function is mocked below.
  createScopedOxyClient: () => ({}),
}));

vi.mock('../../utils/privacyHelpers', () => ({
  getBlockedUserIds: (...args: unknown[]) => mocks.getBlockedUserIds(...args),
}));

vi.mock('../../utils/push', () => ({
  sendPushToUser: mocks.sendPushToUser,
  formatPushForNotification: mocks.formatPushForNotification,
}));

vi.mock('../../runtime/socketServer', () => ({
  getRuntimeSocketServer: () => undefined,
}));

vi.mock('../../utils/mediaResolver', () => ({
  resolveAvatarUrl: (value?: string) => value,
}));

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { notifications } from '../../db/schema/discovery';
import { pokes } from '../../db/schema/engagement';
import pokesRouter from '../../routes/pokes';

let db: Database;
const createdUserIds: string[] = [];

function userId(label: string): string {
  const id = `oxy-${label}-${randomUUID()}`;
  createdUserIds.push(id);
  return id;
}

function oxyUser(id: string) {
  return { id, username: `user-${id.slice(-4)}`, name: { displayName: 'Someone' }, avatar: 'file-1' };
}

function makeApp(viewer: string | undefined) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (viewer) (req as typeof req & { user: { id: string } }).user = { id: viewer };
    next();
  });
  app.use('/', pokesRouter);
  return app;
}

beforeAll(async () => {
  db = await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUsersByIds.mockImplementation(async (ids: string[]) => ids.map(oxyUser));
  mocks.getUserById.mockImplementation(async (id: string) => oxyUser(id));
  mocks.getUserFollowers.mockResolvedValue([]);
  mocks.getUserFollowing.mockResolvedValue([]);
  mocks.formatPushForNotification.mockResolvedValue({ title: 't', body: 'b', data: {} });
  mocks.isUserBlocked.mockResolvedValue(false);
  mocks.userScopedClient.mockReturnValue({ isUserBlocked: mocks.isUserBlocked });
  mocks.getBlockedUserIds.mockResolvedValue([]);
});

afterEach(async () => {
  if (createdUserIds.length > 0) {
    await db
      .delete(pokes)
      .where(or(inArray(pokes.pokerId, createdUserIds), inArray(pokes.pokedId, createdUserIds)));
    await db.delete(notifications).where(inArray(notifications.recipientId, createdUserIds));
    createdUserIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('POST /pokes/:userId', () => {
  it('creates one row and one notification, and a repeat creates neither', async () => {
    const poker = userId('poker');
    const poked = userId('poked');
    const app = makeApp(poker);

    await request(app).post(`/${poked}`).expect(200, { poked: true });
    await request(app).post(`/${poked}`).expect(200, { poked: true });

    const rows = await db
      .select()
      .from(pokes)
      .where(and(eq(pokes.pokerId, poker), eq(pokes.pokedId, poked)));
    expect(rows).toHaveLength(1);

    // The notification is the observable half: a second "poked you" would reach
    // the recipient even though the table looked correct.
    const notified = await db
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, poked));
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({
      actorId: poker,
      type: 'poke',
      entityId: poker,
      entityType: 'profile',
    });
    expect(mocks.sendPushToUser).toHaveBeenCalledTimes(1);
  });

  it('treats the reverse direction as a separate poke', async () => {
    // The unique key is on the ORDERED pair, so a poke back is its own row.
    const first = userId('first');
    const second = userId('second');

    await request(makeApp(first)).post(`/${second}`).expect(200);
    await request(makeApp(second)).post(`/${first}`).expect(200);

    const rows = await db
      .select()
      .from(pokes)
      .where(inArray(pokes.pokerId, [first, second]));
    expect(rows).toHaveLength(2);
  });

  it('refuses a self-poke and an anonymous caller', async () => {
    const poker = userId('poker');
    await request(makeApp(poker)).post(`/${poker}`).expect(400);
    await request(makeApp(undefined)).post('/someone').expect(401);
    expect(await db.select().from(pokes).where(eq(pokes.pokerId, poker))).toEqual([]);
  });
});

describe('POST /pokes/:userId — the block relationship gate', () => {
  it('refuses the first poke when a block exists between the two accounts, with zero side effects', async () => {
    const poker = userId('poker');
    const poked = userId('poked');
    mocks.isUserBlocked.mockResolvedValue(true);

    await request(makeApp(poker)).post(`/${poked}`).expect(403);

    expect(mocks.isUserBlocked).toHaveBeenCalledWith(poked);
    expect(await db.select().from(pokes).where(eq(pokes.pokerId, poker))).toEqual([]);
    expect(await db.select().from(notifications).where(eq(notifications.recipientId, poked))).toEqual([]);
    expect(mocks.sendPushToUser).not.toHaveBeenCalled();
  });

  it('refuses in the reverse direction the same way', async () => {
    const poker = userId('poker');
    const poked = userId('poked');
    mocks.isUserBlocked.mockResolvedValue(true);

    await request(makeApp(poked)).post(`/${poker}`).expect(403);
    expect(await db.select().from(pokes).where(eq(pokes.pokerId, poked))).toEqual([]);
  });

  it('fails closed, not open, when the block relationship cannot be verified', async () => {
    const poker = userId('poker');
    const poked = userId('poked');
    mocks.isUserBlocked.mockRejectedValue(new Error('Oxy privacy graph unavailable'));

    await request(makeApp(poker)).post(`/${poked}`).expect(403);
    expect(await db.select().from(pokes).where(eq(pokes.pokerId, poker))).toEqual([]);
  });

  it('fails closed when no user-scoped Oxy client is available for the request', async () => {
    const poker = userId('poker');
    const poked = userId('poked');
    mocks.userScopedClient.mockReturnValue(undefined);

    await request(makeApp(poker)).post(`/${poked}`).expect(403);
    expect(await db.select().from(pokes).where(eq(pokes.pokerId, poker))).toEqual([]);
  });

  it('still lets an unblocked poke through', async () => {
    const poker = userId('poker');
    const poked = userId('poked');
    mocks.isUserBlocked.mockResolvedValue(false);

    await request(makeApp(poker)).post(`/${poked}`).expect(200, { poked: true });
    expect(await db.select().from(pokes).where(eq(pokes.pokerId, poker))).toHaveLength(1);
  });
});

describe('DELETE /pokes/:userId', () => {
  it('removes only the caller’s own poke in that direction', async () => {
    const poker = userId('poker');
    const poked = userId('poked');
    await request(makeApp(poker)).post(`/${poked}`).expect(200);
    await request(makeApp(poked)).post(`/${poker}`).expect(200);

    await request(makeApp(poker)).delete(`/${poked}`).expect(200, { poked: false });

    const remaining = await db.select().from(pokes).where(inArray(pokes.pokerId, [poker, poked]));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].pokerId).toBe(poked);
  });
});

describe('GET /pokes/received', () => {
  it('lists pokes newest first, with pokedBack derived from the reverse row', async () => {
    const viewer = userId('viewer');
    const older = userId('older');
    const newer = userId('newer');

    await db.insert(pokes).values([
      { pokerId: older, pokedId: viewer, createdAt: new Date('2026-07-01T00:00:00.000Z') },
      { pokerId: newer, pokedId: viewer, createdAt: new Date('2026-07-02T00:00:00.000Z') },
      // The viewer poked `older` back — the reverse-direction row.
      { pokerId: viewer, pokedId: older, createdAt: new Date('2026-07-03T00:00:00.000Z') },
    ]);

    const res = await request(makeApp(viewer)).get('/received').expect(200);

    expect(res.body.pokes.map((poke: { user: { id: string } }) => poke.user.id)).toEqual([
      newer,
      older,
    ]);
    // `pokedBack` is a correlated fact about a SECOND row; a subquery that
    // silently matched nothing would read `false` for both and look plausible.
    const byUser = new Map(
      res.body.pokes.map((poke: { user: { id: string }; pokedBack: boolean }) => [
        poke.user.id,
        poke.pokedBack,
      ]),
    );
    expect(byUser.get(older)).toBe(true);
    expect(byUser.get(newer)).toBe(false);
    expect(res.body.pokes[0]).toMatchObject({ pokeCount: 1 });
    expect(typeof res.body.pokes[0].id).toBe('string');
  });

  it('drops a poker Oxy cannot resolve rather than emitting a bare id', async () => {
    const viewer = userId('viewer');
    const ghost = userId('ghost');
    await db.insert(pokes).values({ pokerId: ghost, pokedId: viewer });
    mocks.getUsersByIds.mockResolvedValue([]);

    const res = await request(makeApp(viewer)).get('/received').expect(200);
    expect(res.body.pokes).toEqual([]);
  });

  it('hides a poke from someone the viewer has since blocked, without deleting the row', async () => {
    const viewer = userId('viewer');
    const blocked = userId('blocked');
    const other = userId('other');
    await db.insert(pokes).values([
      { pokerId: blocked, pokedId: viewer },
      { pokerId: other, pokedId: viewer },
    ]);
    mocks.getBlockedUserIds.mockResolvedValue([blocked]);

    const res = await request(makeApp(viewer)).get('/received').expect(200);

    expect(res.body.pokes.map((poke: { user: { id: string } }) => poke.user.id)).toEqual([other]);
    // Blocking does not rewrite history — the row itself survives.
    expect(await db.select().from(pokes).where(eq(pokes.pokerId, blocked))).toHaveLength(1);
  });
});

describe('GET /pokes/sent and /status', () => {
  it('lists sent pokes and reports status per direction', async () => {
    const viewer = userId('viewer');
    const target = userId('target');
    await request(makeApp(viewer)).post(`/${target}`).expect(200);

    const sent = await request(makeApp(viewer)).get('/sent').expect(200);
    expect(sent.body.pokes.map((poke: { user: { id: string } }) => poke.user.id)).toEqual([target]);

    expect((await request(makeApp(viewer)).get(`/${target}/status`)).body).toEqual({ poked: true });
    // The reverse direction is a different fact.
    expect((await request(makeApp(target)).get(`/${viewer}/status`)).body).toEqual({ poked: false });
  });
});

describe('GET /pokes/suggested', () => {
  it('excludes people the caller has already poked, and the caller themselves', async () => {
    const viewer = userId('viewer');
    const alreadyPoked = userId('poked');
    const fresh = userId('fresh');

    mocks.getUserFollowers.mockResolvedValue({ followers: [oxyUser(alreadyPoked)] });
    mocks.getUserFollowing.mockResolvedValue({ following: [oxyUser(fresh), oxyUser(viewer)] });
    await request(makeApp(viewer)).post(`/${alreadyPoked}`).expect(200);

    const res = await request(makeApp(viewer)).get('/suggested').expect(200);

    expect(res.body.suggestions.map((entry: { user: { id: string } }) => entry.user.id)).toEqual([
      fresh,
    ]);
  });

  it('excludes a follow-graph member the caller has blocked', async () => {
    const viewer = userId('viewer');
    const blocked = userId('blocked');
    const fresh = userId('fresh');

    mocks.getUserFollowers.mockResolvedValue({ followers: [oxyUser(blocked), oxyUser(fresh)] });
    mocks.getBlockedUserIds.mockResolvedValue([blocked]);

    const res = await request(makeApp(viewer)).get('/suggested').expect(200);

    expect(res.body.suggestions.map((entry: { user: { id: string } }) => entry.user.id)).toEqual([
      fresh,
    ]);
  });
});
