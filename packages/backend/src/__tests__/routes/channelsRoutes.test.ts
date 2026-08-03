/**
 * The Channels API, driven through the real routers against real rows.
 *
 * This suite used to mock all five Mongoose models. Porting the reads made every
 * one of those mocks inert — the route would have queried an unconnected pool
 * and the assertions would still have described the mock — so the whole file is
 * rewritten against Postgres. Only two things are still stubbed, and both are
 * other suites' subjects: identity resolution (`resolveUserSummaries`) and the
 * notification write.
 *
 * Six things here fail SILENTLY if they regress, which is why each has a case of
 * its own rather than being implied by a happy path:
 *
 *  1. **Deleting a channel RELEASES its posts.** `posts.channel_id` is
 *     `ON DELETE CASCADE`, so the release is what stands between deleting a
 *     channel and deleting every post ever published to it — other publishers'
 *     included.
 *  2. **The 409 is the unique CONSTRAINT, not a pre-check.** A `select` is not a
 *     lock.
 *  3. **The owner's membership row is written in the create's own transaction**,
 *     which is what makes "may publish" ONE question with ONE answer.
 *  4. **The owner's row can never be removed**, or the channel becomes one
 *     nobody can publish to, its owner included.
 *  5. **Cancelling a PENDING invitation must not decrement `member_count`** —
 *     only `accept` ever incremented it.
 *  6. **A uuid v7 channel id must resolve.** `couldNameAChannel` gated on
 *     `ObjectId.isValid`, which rejects every id this instance now mints, so the
 *     public param route handed a real channel's own page to `next()` and it
 *     404ed. That could not fire before the port, because every channel id in
 *     the database was still a Mongo ObjectId.
 *
 * ## The directory is a GLOBAL list, and the suite runs beside others
 *
 * `GET /channels` has no owner scope, so channels seeded by suites running in
 * parallel are legitimately in its result. Every ordering assertion therefore
 * gives this file's channels a `follower_count` in a band far above anything
 * another suite writes (nothing else sets the column above single digits), which
 * puts them deterministically at the head of `follower_count desc, id desc`.
 * Membership assertions read a specific row instead and need no band.
 *
 * ## One branch here is deliberately not covered
 *
 * `GET /channels/following` drops a follow whose channel vanished between the
 * two statements that read them. `channel_follows.channel_id` is
 * `ON DELETE CASCADE`, so no fixture can produce an orphan — only a race can,
 * and a test that could stage it would be staging a race in the database rather
 * than in this route.
 */

import express, { type NextFunction, type Response } from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import type { OxyAuthRequest } from '@oxyhq/core/server';
import { MAX_CHANNEL_MEMBERS, MAX_CHANNELS_PER_OWNER } from '@mention/shared-types';

const mocks = vi.hoisted(() => ({
  resolveUserSummaries: vi.fn(),
  createNotification: vi.fn(),
}));

// Identity resolution belongs to `PostHydrationService`'s own suite. Stubbed so
// this file is about the channel queries, never about how a user is hydrated.
vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: mocks.resolveUserSummaries,
}));
vi.mock('../../utils/notificationUtils', () => ({
  createNotification: mocks.createNotification,
}));
vi.mock('@oxyhq/core/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oxyhq/core/server')>();
  return {
    ...actual,
    requireOxyAuth: (_req: unknown, _res: unknown, next: NextFunction) => next(),
    getRequiredOxyUserId: (req: OxyAuthRequest) => req.user?.id ?? '',
  };
});

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { channelFollows, channelMembers, channels, lanes } from '../../db/schema/channels';
import channelsRouter, { publicChannelsRouter } from '../../routes/channels.routes';
import { uuidv7 } from '../../db/schema/columns';
import { clearPostScope, postScope, readPostRow, seedPost } from '../helpers/postFixtures';

const scope = postScope('channels-routes');

const run = randomUUID().replace(/-/g, '').slice(0, 8);
const VIEWER_ID = `viewer-${run}`;
const OTHER_USER_ID = `stranger-${run}`;

/**
 * `follower_count` floor for this file's directory fixtures — see the module
 * docblock. High enough that no other suite's channel can interleave.
 */
const DIRECTORY_BAND = 1_000_000;

/**
 * The per-caller read ceiling `routes/channels.routes.ts` applies to the three
 * lists with no cursor of their own. Restated here rather than exported from the
 * route: the number is a product decision the API's behaviour has to keep, and a
 * test that imported it would agree with whatever the route was changed to.
 */
const MAX_CALLER_CHANNEL_ROWS = 500;

let authUserId: string | undefined = VIEWER_ID;
/** Channels this file created, through the route or directly, for teardown. */
const createdChannelIds: string[] = [];
/** Lanes this file created, for teardown (their mutes cascade). */
const createdLaneIds: string[] = [];
let handleSeq = 0;

/** A handle nothing else in the run can hold. Hex is `[a-z0-9]`, so it is legal. */
function uniqueHandle(): string {
  return `c${run}${(handleSeq += 1).toString().padStart(3, '0')}`;
}

/**
 * Mount order MIRRORS PRODUCTION (`appRoutes.ts` + `app.ts`): the public router
 * first, the authenticated one after it. That ordering is what makes the
 * `/channels/mine` collision reachable at all — the public `/:idOrHandle` route
 * sees that segment before the caller-scoped list does — so a test app that
 * mounted them the other way round would pass while production 404s.
 */
const app = express();
app.use(express.json());
app.use((req: OxyAuthRequest, _res: Response, next: NextFunction) => {
  req.user = authUserId ? { id: authUserId } : undefined;
  next();
});
app.use('/channels', publicChannelsRouter);
app.use('/channels', channelsRouter);

/** Insert a channel directly, for the cases that need a foreign owner or counters. */
async function seedChannel(
  overrides: Partial<typeof channels.$inferInsert> = {},
): Promise<typeof channels.$inferSelect> {
  const handle = overrides.handle ?? uniqueHandle();
  const [row] = await getDb()
    .insert(channels)
    .values({
      handle,
      handleLower: handle.toLowerCase(),
      title: 'a channel',
      ownerOxyUserId: VIEWER_ID,
      ...overrides,
    })
    .returning();
  createdChannelIds.push(row.id);
  return row;
}

/** Create a channel through the ROUTE, so assertions cover a real write path. */
async function createChannel(body: Record<string, unknown> = {}): Promise<request.Response> {
  const res = await request(app)
    .post('/channels')
    .send({ handle: uniqueHandle(), title: 'A channel', ...body });
  if (res.status === 201) createdChannelIds.push(res.body.data.id);
  return res;
}

async function seedMember(
  channelId: string,
  oxyUserId: string,
  overrides: Partial<typeof channelMembers.$inferInsert> = {},
): Promise<void> {
  await getDb().insert(channelMembers).values({ channelId, oxyUserId, ...overrides });
}

async function readMember(
  channelId: string,
  oxyUserId: string,
): Promise<typeof channelMembers.$inferSelect | undefined> {
  const [row] = await getDb()
    .select()
    .from(channelMembers)
    .where(
      and(eq(channelMembers.channelId, channelId), eq(channelMembers.oxyUserId, oxyUserId)),
    );
  return row;
}

async function counters(
  channelId: string,
): Promise<{ followerCount: number; memberCount: number } | undefined> {
  const [row] = await getDb()
    .select({ followerCount: channels.followerCount, memberCount: channels.memberCount })
    .from(channels)
    .where(eq(channels.id, channelId));
  return row;
}

/** Only the channels this file owns, so a parallel suite cannot move an assertion. */
function mine(items: Array<{ handle: string }>): Array<{ handle: string }> {
  return items.filter((item) => item.handle.startsWith(`c${run}`));
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  authUserId = VIEWER_ID;
  mocks.resolveUserSummaries.mockReset().mockResolvedValue(new Map());
  mocks.createNotification.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  // Posts first: `posts.channel_id` is `ON DELETE CASCADE`, so a channel removed
  // ahead of them takes its posts with it — and a post the suite believes it
  // deleted itself is a post whose absence proves nothing.
  await clearPostScope(scope);
  const db = getDb();
  if (createdLaneIds.length > 0) {
    await db.delete(lanes).where(inArray(lanes.id, createdLaneIds.splice(0)));
  }
  if (createdChannelIds.length > 0) {
    await db.delete(channels).where(inArray(channels.id, createdChannelIds.splice(0)));
  }
});

describe('GET /channels/:idOrHandle', () => {
  it('resolves by handle as well as by id — /c/<handle> needs no lookup first', async () => {
    const channel = await seedChannel({ title: 'The Newsroom' });

    const res = await request(app).get(`/channels/${channel.handle}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(channel.id);
    expect(res.body.data.title).toBe('The Newsroom');
  });

  it('resolves by its uuid v7 id — the shape every channel now has', async () => {
    // THE CASE THE PORT ADDS. `couldNameAChannel` gated on `ObjectId.isValid`,
    // and a uuid is not a legal handle either (it carries dashes), so both arms
    // said no and the request fell through to a 404 on the channel's own page.
    const channel = await seedChannel();

    const res = await request(app).get(`/channels/${channel.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(channel.id);
  });

  it('falls through to the handle when a 24-hex id matches nothing', async () => {
    // A 24-hex string is a LEGAL handle, so refusing to fall through would make
    // that one handle permanently unreachable.
    const handle = `${'a'.repeat(16)}${run}`;
    const channel = await seedChannel({ handle });

    const res = await request(app).get(`/channels/${handle}`);

    expect(handle).toHaveLength(24);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(channel.id);
  });

  it('404s an unknown channel', async () => {
    const res = await request(app).get(`/channels/${uuidv7()}`);
    expect(res.status).toBe(404);
  });

  it("carries the caller's own viewerState", async () => {
    const channel = await seedChannel();
    await seedMember(channel.id, VIEWER_ID, { role: 'owner', status: 'accepted' });
    await getDb()
      .insert(channelFollows)
      .values({ channelId: channel.id, oxyUserId: VIEWER_ID, notify: false });

    const res = await request(app).get(`/channels/${channel.id}`);

    expect(res.body.data.viewerState).toEqual({
      isFollowing: true,
      notify: false,
      role: 'owner',
      memberStatus: 'accepted',
    });
  });

  it('omits viewerState entirely for an anonymous reader', async () => {
    // A `viewerState` full of falses is one a client could mistake for a real
    // answer about somebody.
    const channel = await seedChannel();
    authUserId = undefined;

    const res = await request(app).get(`/channels/${channel.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('viewerState');
  });
});

describe('POST /channels', () => {
  it("creates the channel AND the owner's membership row", async () => {
    const res = await createChannel({ title: 'The Newsroom' });

    expect(res.status).toBe(201);
    expect(res.body.data.title).toBe('The Newsroom');
    expect(res.body.data.memberCount).toBe(1);
    expect(res.body.data.viewerState).toEqual({
      isFollowing: false,
      notify: false,
      role: 'owner',
      memberStatus: 'accepted',
    });

    const membership = await readMember(res.body.data.id, VIEWER_ID);
    expect(membership?.role).toBe('owner');
    expect(membership?.status).toBe('accepted');
  });

  it('canonicalizes the handle it stores', async () => {
    const handle = uniqueHandle();

    const res = await createChannel({ handle: `  @${handle.toUpperCase()} ` });

    expect(res.status).toBe(201);
    expect(res.body.data.handle).toBe(handle);
  });

  it('400s a reserved or malformed handle before any write', async () => {
    const before = await getDb()
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.ownerOxyUserId, VIEWER_ID));

    for (const handle of ['mine', 'invites', 'following', 'ab', 'news room']) {
      const res = await request(app).post('/channels').send({ handle, title: 'T' });
      expect(res.status).toBe(400);
    }

    const after = await getDb()
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.ownerOxyUserId, VIEWER_ID));
    expect(after).toHaveLength(before.length);
  });

  it('409s on the unique constraint rather than on a pre-check', async () => {
    const taken = await seedChannel({ ownerOxyUserId: OTHER_USER_ID });

    const res = await request(app).post('/channels').send({ handle: taken.handle, title: 'T' });

    expect(res.status).toBe(409);
  });

  it('enforces the per-owner cap', async () => {
    for (let index = 0; index < MAX_CHANNELS_PER_OWNER; index += 1) {
      await seedChannel();
    }

    const res = await request(app).post('/channels').send({ handle: uniqueHandle(), title: 'T' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain(String(MAX_CHANNELS_PER_OWNER));
  });
});

describe('the caller-scoped lists', () => {
  it('GET /channels/mine returns the channels the caller may PUBLISH to', async () => {
    const publishable = await seedChannel({ ownerOxyUserId: OTHER_USER_ID });
    const pending = await seedChannel({ ownerOxyUserId: OTHER_USER_ID });
    await seedMember(publishable.id, VIEWER_ID, { status: 'accepted' });
    await seedMember(pending.id, VIEWER_ID, { status: 'pending' });

    const res = await request(app).get('/channels/mine');

    expect(res.status).toBe(200);
    expect(mine(res.body.data).map((item) => item.handle)).toEqual([publishable.handle]);
  });

  it('GET /channels/mine short-circuits with no memberships', async () => {
    const res = await request(app).get('/channels/mine');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('GET /channels/invites returns only PENDING invitations', async () => {
    const invited = await seedChannel({ ownerOxyUserId: OTHER_USER_ID });
    const joined = await seedChannel({ ownerOxyUserId: OTHER_USER_ID });
    await seedMember(invited.id, VIEWER_ID, { status: 'pending' });
    await seedMember(joined.id, VIEWER_ID, { status: 'accepted' });

    const res = await request(app).get('/channels/invites');

    expect(mine(res.body.data).map((item) => item.handle)).toEqual([invited.handle]);
  });

  it('GET /channels/invites short-circuits with none', async () => {
    const res = await request(app).get('/channels/invites');
    expect(res.body.data).toEqual([]);
  });

  it('the PUBLIC /:idOrHandle route hands all three segments on instead of 404ing them', async () => {
    // `mine`, `invites` and `following` are RESERVED handles, so
    // `normalizeChannelHandle` rejects them and `couldNameAChannel` declines —
    // which is the only reason the authenticated routes behind the public param
    // route are reachable at all.
    for (const segment of ['mine', 'invites', 'following']) {
      const res = await request(app).get(`/channels/${segment}`);
      expect(res.status).toBe(200);
    }
  });

  it('CONTROL: an ordinary segment IS claimed by the public param route', async () => {
    const res = await request(app).get('/channels/definitelynotachannelhandle');
    expect(res.status).toBe(404);
  });
});

describe('PUT /channels/:id', () => {
  it('renames the handle and canonicalizes it', async () => {
    const channel = await seedChannel();
    const renamed = uniqueHandle();

    const res = await request(app)
      .put(`/channels/${channel.id}`)
      .send({ handle: `@${renamed.toUpperCase()}` });

    expect(res.status).toBe(200);
    expect(res.body.data.handle).toBe(renamed);
    const [stored] = await getDb().select().from(channels).where(eq(channels.id, channel.id));
    expect(stored.handleLower).toBe(renamed);
  });

  it('flips signPosts', async () => {
    const channel = await seedChannel();

    const res = await request(app).put(`/channels/${channel.id}`).send({ signPosts: true });

    expect(res.body.data.signPosts).toBe(true);
  });

  it('400s an illegal handle before saving', async () => {
    const channel = await seedChannel();

    const res = await request(app).put(`/channels/${channel.id}`).send({ handle: 'mine' });

    expect(res.status).toBe(400);
    const [stored] = await getDb().select().from(channels).where(eq(channels.id, channel.id));
    expect(stored.handle).toBe(channel.handle);
  });

  it('409s a taken handle from the unique constraint', async () => {
    const channel = await seedChannel();
    const rival = await seedChannel({ ownerOxyUserId: OTHER_USER_ID });

    const res = await request(app).put(`/channels/${channel.id}`).send({ handle: rival.handle });

    expect(res.status).toBe(409);
  });

  it('403s a non-owner', async () => {
    const channel = await seedChannel({ ownerOxyUserId: OTHER_USER_ID });

    const res = await request(app).put(`/channels/${channel.id}`).send({ title: 'Hijacked' });

    expect(res.status).toBe(403);
    const [stored] = await getDb().select().from(channels).where(eq(channels.id, channel.id));
    expect(stored.title).toBe('a channel');
  });

  it('404s an unknown channel', async () => {
    const res = await request(app).put(`/channels/${uuidv7()}`).send({ title: 'T' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /channels/:id', () => {
  it("RELEASES the channel's posts rather than letting the foreign key take them", async () => {
    const channel = await seedChannel();
    const [lane] = await getDb()
      .insert(lanes)
      .values({
        ownerType: 'channel',
        ownerId: channel.id,
        name: 'Lane',
        nameLower: 'lane',
        displayMode: 'tab',
      })
      .returning();
    createdLaneIds.push(lane.id);
    const post = await seedPost(scope, { channelId: channel.id, laneId: lane.id });

    const res = await request(app).delete(`/channels/${channel.id}`);

    expect(res.status).toBe(200);
    // EXISTS first, then its columns: `posts.channel_id` is `ON DELETE CASCADE`,
    // so the failure guarded against is the row being GONE — against which an
    // assertion on `row?.channelId` reads `undefined` and passes.
    const released = await readPostRow(post.id);
    expect(released).toBeDefined();
    expect(released?.channelId).toBeNull();
    expect(released?.laneId).toBeNull();
  });

  it("takes the channel's lanes, members and followers with it", async () => {
    const channel = await seedChannel();
    const [lane] = await getDb()
      .insert(lanes)
      .values({
        ownerType: 'channel',
        ownerId: channel.id,
        name: 'Lane',
        nameLower: 'lane',
        displayMode: 'tab',
      })
      .returning();
    createdLaneIds.push(lane.id);
    await seedMember(channel.id, OTHER_USER_ID, { status: 'accepted' });
    await getDb().insert(channelFollows).values({ channelId: channel.id, oxyUserId: OTHER_USER_ID });

    await request(app).delete(`/channels/${channel.id}`);

    const db = getDb();
    expect(await db.select().from(channels).where(eq(channels.id, channel.id))).toEqual([]);
    expect(await db.select().from(lanes).where(eq(lanes.id, lane.id))).toEqual([]);
    expect(
      await db.select().from(channelMembers).where(eq(channelMembers.channelId, channel.id)),
    ).toEqual([]);
    expect(
      await db.select().from(channelFollows).where(eq(channelFollows.channelId, channel.id)),
    ).toEqual([]);
  });

  it('403s a non-owner and writes nothing', async () => {
    const channel = await seedChannel({ ownerOxyUserId: OTHER_USER_ID });

    const res = await request(app).delete(`/channels/${channel.id}`);

    expect(res.status).toBe(403);
    expect(
      await getDb().select({ id: channels.id }).from(channels).where(eq(channels.id, channel.id)),
    ).toHaveLength(1);
  });
});

describe('membership', () => {
  it('invites, and notifies with the channel_invite type', async () => {
    const channel = await seedChannel();

    const res = await request(app)
      .post(`/channels/${channel.id}/members`)
      .send({ oxyUserId: OTHER_USER_ID });

    expect(res.status).toBe(201);
    const member = await readMember(channel.id, OTHER_USER_ID);
    expect(member?.status).toBe('pending');
    expect(member?.role).toBe('publisher');
    expect(member?.invitedByOxyUserId).toBe(VIEWER_ID);
    expect(mocks.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: OTHER_USER_ID,
        actorId: VIEWER_ID,
        type: 'channel_invite',
        entityId: channel.id,
        entityType: 'channel',
      }),
    );
  });

  it('403s an invite from a non-owner', async () => {
    const channel = await seedChannel({ ownerOxyUserId: OTHER_USER_ID });

    const res = await request(app)
      .post(`/channels/${channel.id}/members`)
      .send({ oxyUserId: `third-${run}` });

    expect(res.status).toBe(403);
    expect(await readMember(channel.id, `third-${run}`)).toBeUndefined();
  });

  it('enforces the member cap', async () => {
    const channel = await seedChannel();
    await getDb()
      .insert(channelMembers)
      .values(
        Array.from({ length: MAX_CHANNEL_MEMBERS }, (_unused, index) => ({
          channelId: channel.id,
          oxyUserId: `filler-${run}-${index}`,
          status: 'accepted' as const,
        })),
      );

    const res = await request(app)
      .post(`/channels/${channel.id}/members`)
      .send({ oxyUserId: OTHER_USER_ID });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain(String(MAX_CHANNEL_MEMBERS));
  });

  it('400s the owner inviting themselves', async () => {
    const channel = await seedChannel();

    const res = await request(app)
      .post(`/channels/${channel.id}/members`)
      .send({ oxyUserId: VIEWER_ID });

    expect(res.status).toBe(400);
  });

  it('409s an invite to somebody already invited', async () => {
    const channel = await seedChannel();
    await seedMember(channel.id, OTHER_USER_ID, { status: 'pending' });

    const res = await request(app)
      .post(`/channels/${channel.id}/members`)
      .send({ oxyUserId: OTHER_USER_ID });

    expect(res.status).toBe(409);
  });

  it('409s an invite to a member who already ACCEPTED', async () => {
    const channel = await seedChannel();
    await seedMember(channel.id, OTHER_USER_ID, { status: 'accepted' });

    const res = await request(app)
      .post(`/channels/${channel.id}/members`)
      .send({ oxyUserId: OTHER_USER_ID });

    expect(res.status).toBe(409);
    // The upsert must not have reset a live membership back to `pending`.
    expect((await readMember(channel.id, OTHER_USER_ID))?.status).toBe('accepted');
  });

  it('re-invites a previously declined member by resetting their existing row', async () => {
    // The unique `(channel_id, oxy_user_id)` constraint means there is only ever
    // one row, so a re-invite is an UPDATE of it rather than a second row.
    const channel = await seedChannel();
    await seedMember(channel.id, OTHER_USER_ID, {
      status: 'declined',
      respondedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const res = await request(app)
      .post(`/channels/${channel.id}/members`)
      .send({ oxyUserId: OTHER_USER_ID });

    expect(res.status).toBe(201);
    const rows = await getDb()
      .select()
      .from(channelMembers)
      .where(
        and(
          eq(channelMembers.channelId, channel.id),
          eq(channelMembers.oxyUserId, OTHER_USER_ID),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].role).toBe('publisher');
    // Cleared, or the invitee's card shows an answer they have not given yet.
    expect(rows[0].respondedAt).toBeNull();
  });

  it('re-invites a REMOVED member the same way', async () => {
    const channel = await seedChannel();
    await seedMember(channel.id, OTHER_USER_ID, { status: 'removed' });

    const res = await request(app)
      .post(`/channels/${channel.id}/members`)
      .send({ oxyUserId: OTHER_USER_ID });

    expect(res.status).toBe(201);
    expect((await readMember(channel.id, OTHER_USER_ID))?.status).toBe('pending');
  });

  it('accepts an invite as a CLAIM, so the counter moves exactly once', async () => {
    const channel = await seedChannel({ memberCount: 1 });
    await seedMember(channel.id, OTHER_USER_ID, { status: 'pending' });
    authUserId = OTHER_USER_ID;

    const res = await request(app).post(`/channels/${channel.id}/members/accept`);

    expect(res.status).toBe(200);
    expect((await readMember(channel.id, OTHER_USER_ID))?.status).toBe('accepted');
    expect((await counters(channel.id))?.memberCount).toBe(2);
  });

  it('404s a second accept and does NOT move the counter again', async () => {
    const channel = await seedChannel({ memberCount: 1 });
    await seedMember(channel.id, OTHER_USER_ID, { status: 'pending' });
    authUserId = OTHER_USER_ID;

    await request(app).post(`/channels/${channel.id}/members/accept`);
    const second = await request(app).post(`/channels/${channel.id}/members/accept`);

    expect(second.status).toBe(404);
    expect((await counters(channel.id))?.memberCount).toBe(2);
  });

  it('declines an invite as a CLAIM, and never touches the member count', async () => {
    const channel = await seedChannel({ memberCount: 1 });
    await seedMember(channel.id, OTHER_USER_ID, { status: 'pending' });
    authUserId = OTHER_USER_ID;

    const res = await request(app).post(`/channels/${channel.id}/members/decline`);

    expect(res.status).toBe(200);
    expect((await readMember(channel.id, OTHER_USER_ID))?.status).toBe('declined');
    expect((await counters(channel.id))?.memberCount).toBe(1);
  });

  it('404s a decline with no pending invitation', async () => {
    const channel = await seedChannel();
    authUserId = OTHER_USER_ID;

    const res = await request(app).post(`/channels/${channel.id}/members/decline`);

    expect(res.status).toBe(404);
  });

  it('removes an ACCEPTED publisher and decrements the member count once', async () => {
    const channel = await seedChannel({ memberCount: 2 });
    await seedMember(channel.id, OTHER_USER_ID, { status: 'accepted' });

    const res = await request(app).delete(`/channels/${channel.id}/members/${OTHER_USER_ID}`);

    expect(res.status).toBe(200);
    expect((await readMember(channel.id, OTHER_USER_ID))?.status).toBe('removed');
    expect((await counters(channel.id))?.memberCount).toBe(1);
  });

  it('does NOT decrement when cancelling a still-PENDING invitation', async () => {
    // Only an ACCEPTED member was ever counted, so decrementing here subtracts a
    // count the invitation never contributed — and `channels_counts_check` is
    // the floor a channel that cancels a few invites would eventually hit.
    const channel = await seedChannel({ memberCount: 1 });
    await seedMember(channel.id, OTHER_USER_ID, { status: 'pending' });

    const res = await request(app).delete(`/channels/${channel.id}/members/${OTHER_USER_ID}`);

    expect(res.status).toBe(200);
    expect((await readMember(channel.id, OTHER_USER_ID))?.status).toBe('removed');
    expect((await counters(channel.id))?.memberCount).toBe(1);
  });

  it('lets a publisher remove THEMSELVES without being the owner', async () => {
    const channel = await seedChannel({ ownerOxyUserId: OTHER_USER_ID, memberCount: 2 });
    await seedMember(channel.id, VIEWER_ID, { status: 'accepted' });

    const res = await request(app).delete(`/channels/${channel.id}/members/${VIEWER_ID}`);

    expect(res.status).toBe(200);
    expect((await counters(channel.id))?.memberCount).toBe(1);
  });

  it('403s removing somebody else when you are neither the owner nor that member', async () => {
    const channel = await seedChannel({ ownerOxyUserId: OTHER_USER_ID });
    const victim = `third-${run}`;
    await seedMember(channel.id, victim, { status: 'accepted' });

    const res = await request(app).delete(`/channels/${channel.id}/members/${victim}`);

    expect(res.status).toBe(403);
    expect((await readMember(channel.id, victim))?.status).toBe('accepted');
  });

  it('404s removing a member who has no active row', async () => {
    const channel = await seedChannel();
    await seedMember(channel.id, OTHER_USER_ID, { status: 'removed' });

    const res = await request(app).delete(`/channels/${channel.id}/members/${OTHER_USER_ID}`);

    expect(res.status).toBe(404);
  });

  it('refuses to remove the OWNER', async () => {
    // `canPublishToChannel` answers from the membership row, so removing the
    // owner's would leave a channel nobody can publish to, its owner included.
    const channel = await seedChannel();
    await seedMember(channel.id, VIEWER_ID, { role: 'owner', status: 'accepted' });

    const res = await request(app).delete(`/channels/${channel.id}/members/${VIEWER_ID}`);

    expect(res.status).toBe(400);
    expect((await readMember(channel.id, VIEWER_ID))?.status).toBe('accepted');
  });
});

describe('following', () => {
  it('follows once and bumps the counter once', async () => {
    const channel = await seedChannel({ ownerOxyUserId: OTHER_USER_ID });

    const res = await request(app).post(`/channels/${channel.id}/follow`);

    expect(res.status).toBe(201);
    expect((await counters(channel.id))?.followerCount).toBe(1);
  });

  it('is idempotent — a second follow neither writes nor bumps', async () => {
    const channel = await seedChannel({ ownerOxyUserId: OTHER_USER_ID });

    await request(app).post(`/channels/${channel.id}/follow`);
    const second = await request(app).post(`/channels/${channel.id}/follow`);

    expect(second.status).toBe(200);
    expect((await counters(channel.id))?.followerCount).toBe(1);
    expect(
      await getDb()
        .select()
        .from(channelFollows)
        .where(eq(channelFollows.channelId, channel.id)),
    ).toHaveLength(1);
  });

  it('unfollow only decrements when a row really went away', async () => {
    const channel = await seedChannel({ ownerOxyUserId: OTHER_USER_ID });
    await request(app).post(`/channels/${channel.id}/follow`);

    await request(app).delete(`/channels/${channel.id}/follow`);
    const again = await request(app).delete(`/channels/${channel.id}/follow`);

    expect(again.status).toBe(200);
    // A second decrement would take the counter below zero, which
    // `channels_counts_check` refuses — so the bug would surface as a 500 rather
    // than as a wrong number. Either way this is the assertion that sees it.
    expect((await counters(channel.id))?.followerCount).toBe(0);
  });

  it('PATCH toggles notify — the state EntityFollow could not have carried', async () => {
    const channel = await seedChannel({ ownerOxyUserId: OTHER_USER_ID });
    await request(app).post(`/channels/${channel.id}/follow`);

    const res = await request(app).patch(`/channels/${channel.id}/follow`).send({ notify: false });

    expect(res.status).toBe(200);
    expect(res.body.data.notify).toBe(false);
    const [row] = await getDb()
      .select()
      .from(channelFollows)
      .where(eq(channelFollows.channelId, channel.id));
    expect(row.notify).toBe(false);
  });

  it('PATCH 404s when the caller does not follow the channel', async () => {
    const channel = await seedChannel({ ownerOxyUserId: OTHER_USER_ID });

    const res = await request(app).patch(`/channels/${channel.id}/follow`).send({ notify: false });

    expect(res.status).toBe(404);
  });
});

describe('GET /channels — the directory', () => {
  it('keyset-pages on {followerCount, id} and emits a two-part cursor', async () => {
    const top = await seedChannel({ followerCount: DIRECTORY_BAND + 3 });
    const middle = await seedChannel({ followerCount: DIRECTORY_BAND + 2 });
    await seedChannel({ followerCount: DIRECTORY_BAND + 1 });

    const res = await request(app).get('/channels?limit=2');

    expect(res.status).toBe(200);
    expect(res.body.data.items.map((item: { handle: string }) => item.handle)).toEqual([
      top.handle,
      middle.handle,
    ]);
    expect(res.body.data.hasMore).toBe(true);
    expect(res.body.data.nextCursor).toBe(`${DIRECTORY_BAND + 2}_${middle.id}`);
  });

  it('honours a two-part cursor as a keyset, not a skip', async () => {
    await seedChannel({ followerCount: DIRECTORY_BAND + 3 });
    const middle = await seedChannel({ followerCount: DIRECTORY_BAND + 2 });
    const last = await seedChannel({ followerCount: DIRECTORY_BAND + 1 });

    const res = await request(app).get(
      `/channels?limit=2&cursor=${DIRECTORY_BAND + 2}_${middle.id}`,
    );

    expect(mine(res.body.data.items).map((item) => item.handle)).toEqual([last.handle]);
  });

  it('ignores a malformed cursor rather than 400ing a client that stored an old format', async () => {
    const top = await seedChannel({ followerCount: DIRECTORY_BAND + 1 });

    const res = await request(app).get('/channels?limit=1&cursor=garbage');

    expect(res.status).toBe(200);
    expect(res.body.data.items[0].handle).toBe(top.handle);
  });

  it('clamps an oversized limit', async () => {
    const res = await request(app).get('/channels?limit=9999');

    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeLessThanOrEqual(50);
  });

  it('excludeFollowed drops the channels the caller already follows', async () => {
    const followed = await seedChannel({ followerCount: DIRECTORY_BAND + 2 });
    const unfollowed = await seedChannel({ followerCount: DIRECTORY_BAND + 1 });
    await getDb()
      .insert(channelFollows)
      .values({ channelId: followed.id, oxyUserId: VIEWER_ID });

    const res = await request(app).get('/channels?limit=10&excludeFollowed=true');

    expect(mine(res.body.data.items).map((item) => item.handle)).toEqual([unfollowed.handle]);
  });
});

describe('GET /channels?search= — the same route, ranked', () => {
  it('ranks by relevance and answers with offset paging, never a keyset cursor', async () => {
    const term = `srch${run}`;
    const exact = await seedChannel({ handle: term });
    const inTitle = await seedChannel({ title: `About ${term}` });

    const res = await request(app).get(`/channels?search=${term}&limit=1`);

    expect(res.status).toBe(200);
    // The exact handle wins even though both channels tie on followers — an
    // exact handle is an ANSWER, not a candidate.
    expect(res.body.data.items.map((item: { id: string }) => item.id)).toEqual([exact.id]);
    expect(res.body.data.hasMore).toBe(true);
    expect(res.body.data.nextOffset).toBe(1);
    expect(res.body.data).not.toHaveProperty('nextCursor');
    expect(inTitle.id).not.toBe(exact.id);
  });

  it('omits nextOffset on the last page', async () => {
    const term = `srch${run}b`;
    await seedChannel({ title: `About ${term}` });

    const res = await request(app).get(`/channels?search=${term}&limit=10`);

    expect(res.body.data.hasMore).toBe(false);
    expect(res.body.data).not.toHaveProperty('nextOffset');
  });

  it('an empty or whitespace-only term is not a search — it is the directory', async () => {
    const channel = await seedChannel({ followerCount: DIRECTORY_BAND + 1 });

    const res = await request(app).get('/channels?search=%20%20&limit=1');

    // A search box that has not been typed in has not asked a question, so this
    // is the browse path — which answers a keyset cursor, not an offset.
    expect(res.body.data.items[0].handle).toBe(channel.handle);
    expect(res.body.data).not.toHaveProperty('nextOffset');
  });

  it('a browse cursor cannot move a searched page', async () => {
    // The two paging modes share NO state: a cursor reinterpreted on the wrong
    // axis would return plausible, wrong rows on page two with nothing saying so.
    const term = `srch${run}c`;
    const only = await seedChannel({ handle: term });

    const res = await request(app).get(`/channels?search=${term}&cursor=999999_${uuidv7()}`);

    expect(res.body.data.items.map((item: { id: string }) => item.id)).toEqual([only.id]);
  });

  it('ignores a search offset while browsing', async () => {
    const channel = await seedChannel({ followerCount: DIRECTORY_BAND + 1 });

    const res = await request(app).get('/channels?limit=1&offset=5');

    expect(res.body.data.items[0].handle).toBe(channel.handle);
  });

  it('honours excludeFollowed while searching, so the parameter keeps meaning something', async () => {
    const term = `srch${run}d`;
    const followed = await seedChannel({ handle: term });
    const other = await seedChannel({ title: `About ${term}` });
    await getDb()
      .insert(channelFollows)
      .values({ channelId: followed.id, oxyUserId: VIEWER_ID });

    const res = await request(app).get(`/channels?search=${term}&excludeFollowed=true`);

    expect(res.body.data.items.map((item: { id: string }) => item.id)).toEqual([other.id]);
  });
});

describe('GET /channels/:idOrHandle/members', () => {
  async function withMembers(): Promise<typeof channels.$inferSelect> {
    const channel = await seedChannel();
    await seedMember(channel.id, VIEWER_ID, { role: 'owner', status: 'accepted' });
    await seedMember(channel.id, `pending-${run}`, { status: 'pending' });
    await seedMember(channel.id, `declined-${run}`, { status: 'declined' });
    await seedMember(channel.id, `removed-${run}`, { status: 'removed' });
    mocks.resolveUserSummaries.mockImplementation((ids: string[]) =>
      Promise.resolve(new Map(ids.map((id) => [id, { user: { id, username: id, name: {} } }]))),
    );
    return channel;
  }

  it('shows a stranger only ACCEPTED members', async () => {
    const channel = await withMembers();
    authUserId = OTHER_USER_ID;

    const res = await request(app).get(`/channels/${channel.id}/members`);

    expect(res.body.data.map((item: { user: { id: string } }) => item.user.id)).toEqual([
      VIEWER_ID,
    ]);
  });

  it('shows the owner their pending and declined invitations too — never a removed row', async () => {
    const channel = await withMembers();

    const res = await request(app).get(`/channels/${channel.id}/members`);

    const ids = res.body.data.map((item: { user: { id: string } }) => item.user.id);
    expect(ids).toContain(`pending-${run}`);
    expect(ids).toContain(`declined-${run}`);
    expect(ids).not.toContain(`removed-${run}`);
  });

  it('resolves members through the canonical identity path, never by hand', async () => {
    const channel = await withMembers();

    await request(app).get(`/channels/${channel.id}/members`);

    expect(mocks.resolveUserSummaries).toHaveBeenCalledTimes(1);
    expect(mocks.resolveUserSummaries).toHaveBeenCalledWith(expect.arrayContaining([VIEWER_ID]));
  });

  it('drops a member the identity path could not resolve', async () => {
    const channel = await withMembers();
    mocks.resolveUserSummaries.mockResolvedValue(new Map());

    const res = await request(app).get(`/channels/${channel.id}/members`);

    expect(res.body.data).toEqual([]);
  });
});

describe('GET /channels/following', () => {
  /** Follow `channelId` at a fixed instant, so the keyset is deterministic. */
  async function follow(channelId: string, createdAt: Date, notify = true): Promise<void> {
    await getDb()
      .insert(channelFollows)
      .values({ channelId, oxyUserId: VIEWER_ID, notify, createdAt });
  }

  it("returns the followed channels with the caller's own viewerState", async () => {
    const channel = await seedChannel({ ownerOxyUserId: OTHER_USER_ID });
    await follow(channel.id, new Date('2026-02-01T00:00:00.000Z'), false);

    const res = await request(app).get('/channels/following');

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    // `notify` rides on the row being paged, so the mute switch needs no second
    // request per channel.
    expect(res.body.data.items[0].viewerState).toEqual({ isFollowing: true, notify: false });
  });

  it('carries the membership for EVERY row of the page, not just the first', async () => {
    // A partial `viewerState` would be worse than none: an absent `role` is
    // documented to mean "not a member", not "not loaded".
    const first = await seedChannel({ ownerOxyUserId: OTHER_USER_ID });
    const second = await seedChannel({ ownerOxyUserId: OTHER_USER_ID });
    await seedMember(first.id, VIEWER_ID, { status: 'accepted' });
    await seedMember(second.id, VIEWER_ID, { status: 'pending' });
    await follow(first.id, new Date('2026-02-02T00:00:00.000Z'));
    await follow(second.id, new Date('2026-02-01T00:00:00.000Z'));

    const res = await request(app).get('/channels/following');

    expect(res.body.data.items.map((item: { viewerState: unknown }) => item.viewerState)).toEqual([
      { isFollowing: true, notify: true, role: 'publisher', memberStatus: 'accepted' },
      { isFollowing: true, notify: true, role: 'publisher', memberStatus: 'pending' },
    ]);
  });

  it('emits a two-part keyset cursor over {createdAt, id}', async () => {
    const newer = await seedChannel({ ownerOxyUserId: OTHER_USER_ID });
    const older = await seedChannel({ ownerOxyUserId: OTHER_USER_ID });
    await follow(newer.id, new Date('2026-02-02T00:00:00.000Z'));
    await follow(older.id, new Date('2026-02-01T00:00:00.000Z'));

    const res = await request(app).get('/channels/following?limit=1');

    expect(res.body.data.items[0].id).toBe(newer.id);
    expect(res.body.data.hasMore).toBe(true);
    // The timestamp half is the FOLLOW's own `created_at`, in milliseconds —
    // which is all `created_at` holds, because the column default truncates to
    // what a JavaScript `Date` can represent. Without that a cursor built from a
    // read would sit below the row it came from and the page would not advance.
    expect(res.body.data.nextCursor.split('_')[0]).toBe(
      String(new Date('2026-02-02T00:00:00.000Z').getTime()),
    );
  });

  it('honours that cursor as a keyset, not a skip', async () => {
    const newer = await seedChannel({ ownerOxyUserId: OTHER_USER_ID });
    const older = await seedChannel({ ownerOxyUserId: OTHER_USER_ID });
    await follow(newer.id, new Date('2026-02-02T00:00:00.000Z'));
    await follow(older.id, new Date('2026-02-01T00:00:00.000Z'));

    const page = await request(app).get('/channels/following?limit=1');
    const next = await request(app).get(
      `/channels/following?limit=1&cursor=${page.body.data.nextCursor}`,
    );

    expect(next.body.data.items.map((item: { id: string }) => item.id)).toEqual([older.id]);
    expect(next.body.data.hasMore).toBe(false);
  });

  it('ignores a malformed cursor rather than 400ing a client on an old format', async () => {
    const channel = await seedChannel({ ownerOxyUserId: OTHER_USER_ID });
    await follow(channel.id, new Date('2026-02-01T00:00:00.000Z'));

    const res = await request(app).get('/channels/following?cursor=garbage');

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
  });

  it('short-circuits an empty list', async () => {
    const res = await request(app).get('/channels/following');

    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.hasMore).toBe(false);
  });

  it('clamps an oversized limit', async () => {
    const res = await request(app).get('/channels/following?limit=9999');

    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeLessThanOrEqual(50);
  });
});

/**
 * The per-caller lists have no cursor of their own, and NOTHING caps how many
 * channels one person may join, be invited to, or follow. `/invites` is the one
 * that matters, because THIRD PARTIES grow that set: anyone who runs a channel
 * can invite you, so its size is not under the victim's control.
 */
describe('per-caller channel lists are bounded', () => {
  /** `count` channels the caller has a membership row on, in two statements. */
  async function seedMemberships(count: number, status: 'accepted' | 'pending'): Promise<void> {
    const rows = await getDb()
      .insert(channels)
      .values(
        Array.from({ length: count }, (_unused, index) => {
          const handle = `c${run}m${index}`;
          return {
            handle,
            handleLower: handle,
            title: 'bulk',
            ownerOxyUserId: OTHER_USER_ID,
          };
        }),
      )
      .returning({ id: channels.id });
    createdChannelIds.push(...rows.map((row) => row.id));
    await getDb()
      .insert(channelMembers)
      .values(rows.map((row) => ({ channelId: row.id, oxyUserId: VIEWER_ID, status })));
  }

  it('bounds GET /channels/invites — a set THIRD PARTIES grow', async () => {
    await seedMemberships(MAX_CALLER_CHANNEL_ROWS + 1, 'pending');

    const res = await request(app).get('/channels/invites');

    expect(res.body.data).toHaveLength(MAX_CALLER_CHANNEL_ROWS);
  });

  it('bounds GET /channels/mine', async () => {
    await seedMemberships(MAX_CALLER_CHANNEL_ROWS + 1, 'accepted');

    const res = await request(app).get('/channels/mine');

    expect(res.body.data).toHaveLength(MAX_CALLER_CHANNEL_ROWS);
  });

  it('bounds the excludeFollowed set — and truncating it is the SAFE direction', async () => {
    // A follow past the ceiling means a channel the reader already follows shows
    // up in the directory. Never a channel they cannot see: `excludeFollowed` is
    // a convenience on a directory, not a permission.
    const rows = await getDb()
      .insert(channels)
      .values(
        Array.from({ length: MAX_CALLER_CHANNEL_ROWS + 1 }, (_unused, index) => {
          const handle = `c${run}f${index}`;
          return {
            handle,
            handleLower: handle,
            title: 'bulk',
            ownerOxyUserId: OTHER_USER_ID,
            // In the band, so all of them sort above every other suite's rows
            // and the survivor is on the first page whichever one it is.
            followerCount: DIRECTORY_BAND + index,
          };
        }),
      )
      .returning({ id: channels.id });
    createdChannelIds.push(...rows.map((row) => row.id));
    await getDb()
      .insert(channelFollows)
      .values(rows.map((row) => ({ channelId: row.id, oxyUserId: VIEWER_ID })));

    const res = await request(app).get('/channels?limit=50&excludeFollowed=true');

    expect(mine(res.body.data.items)).toHaveLength(1);
  });
});

/**
 * `avatar`/`banner` are BARE Oxy file ids, which the DTO documents and the route
 * enforces.
 *
 * Bloom's `ImageResolver` passes `http:`/`https:`/`data:` through untouched, so a
 * URL stored here is fetched by every visitor to the channel page AND by everyone
 * who sees a post it signs — handing the channel's owner the IP, User-Agent and
 * Referer of readers who never visited their host.
 */
describe('channel media ids are file ids, not URLs', () => {
  const FILE_ID = 'a'.repeat(24);

  it('accepts a bare Oxy file id', async () => {
    const res = await createChannel({ avatar: FILE_ID });

    expect(res.status).toBe(201);
    expect(res.body.data.avatar).toBe(FILE_ID);
  });

  it.each([
    ['an https URL', 'https://attacker.example/pixel.png'],
    ['an http URL', 'http://attacker.example/pixel.png'],
    ['a data URI', 'data:image/png;base64,iVBORw0KGgo='],
    ['a protocol-relative URL', '//attacker.example/pixel.png'],
  ])('rejects %s on create', async (_label, value) => {
    const handle = uniqueHandle();

    const res = await request(app).post('/channels').send({ handle, title: 'T', avatar: value });

    expect(res.status).toBe(400);
    expect(
      await getDb()
        .select({ id: channels.id })
        .from(channels)
        .where(eq(channels.handleLower, handle)),
    ).toEqual([]);
  });

  it('rejects a URL on UPDATE too — both schemas, or the edit path reopens it', async () => {
    const channel = await seedChannel();

    const res = await request(app)
      .put(`/channels/${channel.id}`)
      .send({ banner: 'https://attacker.example/pixel.png' });

    expect(res.status).toBe(400);
    const [stored] = await getDb().select().from(channels).where(eq(channels.id, channel.id));
    expect(stored.banner).toBeNull();
  });
});
