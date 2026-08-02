/**
 * The Lanes API, driven through the real routers against real rows.
 *
 * This suite used to mock `Lane`, `LaneMute`, `Post` and `Channel`. Porting the
 * reads made every one of those mocks inert, so it is rewritten against
 * Postgres; only `resolveUserSummaries` is still stubbed, because identity
 * resolution is another suite's subject.
 *
 * Four things here fail SILENTLY if they regress:
 *
 *  1. **Deleting a lane RELEASES its posts and drops its mutes.** In Mongo that
 *     was three hand-sequenced writes whose order was load-bearing; here it is
 *     `posts.lane_id ON DELETE SET NULL` plus
 *     `lane_mutes.lane_id ON DELETE CASCADE`, so one statement does all three
 *     atomically. The property is the same either way: leave a post pointing at
 *     a lane that no longer exists and the profile exclusion query stops
 *     matching, so posts the owner had tucked away REAPPEAR on their profile.
 *  2. **The 409 is the unique CONSTRAINT, not the pre-check.** A count is not a
 *     lock, so a duplicate name is caught by `lanes_owner_name_lower_key` or not
 *     at all.
 *  3. **Muting your own lane is refused.** It would delete your own posts from
 *     your own Following feed.
 *  4. **A channel's lanes answer to the channel's OWNER, and to nobody else.**
 *     The lookups that decide this gated on `ObjectId.isValid` and were inert
 *     for every uuid v7 — answering `false`, which refuses. So a channel owner
 *     was locked out of their own lanes; the cases naming a channel below are
 *     what would have caught it.
 */

import express, { type NextFunction, type Response } from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { OxyAuthRequest } from '@oxyhq/core/server';
import { MAX_LANES_PER_OWNER, MAX_LANE_NAME_LENGTH, MAX_MUTED_LANES } from '@mention/shared-types';

const mocks = vi.hoisted(() => ({ resolveUserSummaries: vi.fn() }));

vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: mocks.resolveUserSummaries,
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
import { channels, laneMutes, lanes } from '../../db/schema/channels';
import { uuidv7 } from '../../db/schema/columns';
import lanesRouter, { publicLanesRouter } from '../../routes/lanes.routes';
import { clearPostScope, postScope, readPostRow, seedPost } from '../helpers/postFixtures';

const scope = postScope('lanes-routes');

const run = randomUUID().replace(/-/g, '').slice(0, 8);
const VIEWER_ID = `viewer-${run}`;
const OTHER_USER_ID = `stranger-${run}`;

let authUserId: string | undefined = VIEWER_ID;
const createdLaneIds: string[] = [];
const createdChannelIds: string[] = [];
let nameSeq = 0;

const app = express();
app.use(express.json());
app.use((req: OxyAuthRequest, _res: Response, next: NextFunction) => {
  req.user = authUserId ? { id: authUserId } : undefined;
  next();
});
app.use('/lanes', publicLanesRouter);
app.use('/lanes', lanesRouter);

/** A lane name nothing else in the run can hold. */
function uniqueName(): string {
  return `Lane ${run} ${(nameSeq += 1)}`;
}

async function seedLane(
  overrides: Partial<typeof lanes.$inferInsert> = {},
): Promise<typeof lanes.$inferSelect> {
  const name = overrides.name ?? uniqueName();
  const [row] = await getDb()
    .insert(lanes)
    .values({
      ownerType: 'user',
      ownerId: VIEWER_ID,
      name,
      nameLower: name.trim().replace(/\s+/g, ' ').toLowerCase(),
      ...overrides,
    })
    .returning();
  createdLaneIds.push(row.id);
  return row;
}

async function seedChannel(
  ownerOxyUserId: string,
): Promise<typeof channels.$inferSelect> {
  const handle = `l${run}${(nameSeq += 1).toString().padStart(3, '0')}`;
  const [row] = await getDb()
    .insert(channels)
    .values({ handle, handleLower: handle, title: 'a channel', ownerOxyUserId })
    .returning();
  createdChannelIds.push(row.id);
  return row;
}

/** Create a lane through the ROUTE, so assertions cover a real write path. */
async function createLane(body: Record<string, unknown> = {}): Promise<request.Response> {
  const res = await request(app).post('/lanes').send({ name: uniqueName(), ...body });
  if (res.status === 201) createdLaneIds.push(res.body.data.id);
  return res;
}

async function readLane(id: string): Promise<typeof lanes.$inferSelect | undefined> {
  const [row] = await getDb().select().from(lanes).where(eq(lanes.id, id));
  return row;
}

async function mutesOf(viewerOxyUserId: string): Promise<Array<typeof laneMutes.$inferSelect>> {
  return getDb().select().from(laneMutes).where(eq(laneMutes.viewerOxyUserId, viewerOxyUserId));
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
});

afterEach(async () => {
  await clearPostScope(scope);
  const db = getDb();
  // Mutes go with their lane by `ON DELETE CASCADE`; a mute of a lane this file
  // never created would not, so remove the viewers' rows explicitly first.
  await db.delete(laneMutes).where(inArray(laneMutes.viewerOxyUserId, [VIEWER_ID, OTHER_USER_ID]));
  if (createdLaneIds.length > 0) {
    await db.delete(lanes).where(inArray(lanes.id, createdLaneIds.splice(0)));
  }
  if (createdChannelIds.length > 0) {
    await db.delete(channels).where(inArray(channels.id, createdChannelIds.splice(0)));
  }
});

describe('GET /lanes (public)', () => {
  it("lists only the publisher's `tab` lanes", async () => {
    const tab = await seedLane({ displayMode: 'tab' });
    await seedLane({ displayMode: 'mixed' });
    await seedLane({ displayMode: 'hidden' });

    const res = await request(app).get(`/lanes?ownerType=user&ownerId=${VIEWER_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.data.map((lane: { id: string }) => lane.id)).toEqual([tab.id]);
  });

  it('accepts a channel publisher', async () => {
    const channel = await seedChannel(VIEWER_ID);
    const lane = await seedLane({
      ownerType: 'channel',
      ownerId: channel.id,
      displayMode: 'tab',
    });

    const res = await request(app).get(`/lanes?ownerType=channel&ownerId=${channel.id}`);

    expect(res.body.data.map((item: { id: string }) => item.id)).toEqual([lane.id]);
  });

  it('rejects a missing owner and an unknown owner type', async () => {
    expect((await request(app).get('/lanes?ownerType=user')).status).toBe(400);
    expect((await request(app).get(`/lanes?ownerType=group&ownerId=${VIEWER_ID}`)).status).toBe(400);
  });

  it('is reader-agnostic — an anonymous visitor gets the same list', async () => {
    const tab = await seedLane({ displayMode: 'tab' });
    authUserId = undefined;

    const res = await request(app).get(`/lanes?ownerType=user&ownerId=${VIEWER_ID}`);

    expect(res.body.data.map((lane: { id: string }) => lane.id)).toEqual([tab.id]);
  });
});

describe('GET /lanes/mine', () => {
  it("returns the caller's lanes with counts aggregated on read", async () => {
    const withPosts = await seedLane();
    const empty = await seedLane();
    await seedPost(scope, { oxyUserId: VIEWER_ID, laneId: withPosts.id });
    await seedPost(scope, { oxyUserId: VIEWER_ID, laneId: withPosts.id });

    const res = await request(app).get('/lanes/mine');

    expect(res.status).toBe(200);
    const counts = new Map(
      (res.body.data as Array<{ id: string; postCount: number }>).map((lane) => [
        lane.id,
        lane.postCount,
      ]),
    );
    expect(counts.get(withPosts.id)).toBe(2);
    // A lane with no posts is absent from the aggregate, which the route reads
    // as zero rather than as `undefined`.
    expect(counts.get(empty.id)).toBe(0);
  });

  it('answers an empty list when the caller has no lanes', async () => {
    const res = await request(app).get('/lanes/mine');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('GET /lanes/muted', () => {
  it('resolves each publisher through the shared identity path', async () => {
    const lane = await seedLane({ ownerId: OTHER_USER_ID, name: 'Their lane' });
    await getDb().insert(laneMutes).values({
      viewerOxyUserId: VIEWER_ID,
      laneId: lane.id,
      laneOwnerOxyUserId: OTHER_USER_ID,
    });
    mocks.resolveUserSummaries.mockImplementation((ids: string[]) =>
      Promise.resolve(new Map(ids.map((id) => [id, { user: { id, username: id, name: {} } }]))),
    );

    const res = await request(app).get('/lanes/muted');

    expect(res.status).toBe(200);
    expect(mocks.resolveUserSummaries).toHaveBeenCalledWith([OTHER_USER_ID]);
    expect(res.body.data).toEqual([
      {
        lane: { id: lane.id, name: 'Their lane', displayMode: 'mixed' },
        owner: { id: OTHER_USER_ID, username: OTHER_USER_ID, name: {} },
        createdAt: expect.any(String),
      },
    ]);
  });

  it('drops a mute whose publisher the identity path could not resolve', async () => {
    const lane = await seedLane({ ownerId: OTHER_USER_ID });
    await getDb().insert(laneMutes).values({
      viewerOxyUserId: VIEWER_ID,
      laneId: lane.id,
      laneOwnerOxyUserId: OTHER_USER_ID,
    });

    const res = await request(app).get('/lanes/muted');

    expect(res.body.data).toEqual([]);
  });

  it('short-circuits with no mutes', async () => {
    const res = await request(app).get('/lanes/muted');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('POST /lanes', () => {
  it('creates a lane owned by the caller, defaulting to mixed', async () => {
    const res = await createLane({ name: '  Fotos  De  Viaje ' });

    expect(res.status).toBe(201);
    expect(res.body.data.ownerType).toBe('user');
    expect(res.body.data.ownerId).toBe(VIEWER_ID);
    expect(res.body.data.displayMode).toBe('mixed');
    expect(res.body.data.postCount).toBe(0);
    // `name_lower` is DERIVED by the repository, and it is what the unique
    // constraint is built on.
    expect((await readLane(res.body.data.id))?.nameLower).toBe('fotos de viaje');
  });

  it('answers 409 from the unique constraint, not from the pre-check', async () => {
    const existing = await seedLane({ name: 'Dev' });

    const res = await request(app).post('/lanes').send({ name: '  DEV ' });

    expect(res.status).toBe(409);
    expect(existing.nameLower).toBe('dev');
  });

  it('enforces the per-publisher cap', async () => {
    for (let index = 0; index < MAX_LANES_PER_OWNER; index += 1) {
      await seedLane();
    }

    const res = await request(app).post('/lanes').send({ name: uniqueName() });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain(String(MAX_LANES_PER_OWNER));
  });

  it('rejects a name that normalizes to nothing', async () => {
    const res = await request(app).post('/lanes').send({ name: '   ' });
    expect(res.status).toBe(400);
  });

  it('rejects a display mode outside the enum', async () => {
    const res = await request(app).post('/lanes').send({ name: uniqueName(), displayMode: 'secret' });
    expect(res.status).toBe(400);
  });

  it('rejects a name past the shared length cap', async () => {
    const res = await request(app)
      .post('/lanes')
      .send({ name: 'x'.repeat(MAX_LANE_NAME_LENGTH + 1) });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /lanes/:id', () => {
  it("updates the caller's own lane", async () => {
    const lane = await seedLane({ name: 'Before' });

    const res = await request(app)
      .patch(`/lanes/${lane.id}`)
      .send({ name: '  After  Words ', displayMode: 'tab' });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('After  Words');
    expect(res.body.data.displayMode).toBe('tab');
    // The rename moves `name_lower` with it, or two spellings of one name would
    // both satisfy the unique constraint.
    expect((await readLane(lane.id))?.nameLower).toBe('after words');
  });

  it('answers 404 for a lane that does not exist', async () => {
    const res = await request(app).patch(`/lanes/${uuidv7()}`).send({ displayMode: 'tab' });
    expect(res.status).toBe(404);
  });

  it("answers 404 for somebody else's lane — never a 403 that confirms it exists", async () => {
    const lane = await seedLane({ ownerId: OTHER_USER_ID });

    const res = await request(app).patch(`/lanes/${lane.id}`).send({ displayMode: 'hidden' });

    expect(res.status).toBe(404);
    expect((await readLane(lane.id))?.displayMode).toBe('mixed');
  });

  it('rejects an empty update and a malformed id', async () => {
    const lane = await seedLane();

    expect((await request(app).patch(`/lanes/${lane.id}`).send({})).status).toBe(400);
    expect((await request(app).patch('/lanes/not-an-id').send({ displayMode: 'tab' })).status).toBe(
      400,
    );
  });

  it('answers 409 when the rename collides', async () => {
    await seedLane({ name: 'Taken' });
    const lane = await seedLane({ name: 'Free' });

    const res = await request(app).patch(`/lanes/${lane.id}`).send({ name: 'taken' });

    expect(res.status).toBe(409);
    expect((await readLane(lane.id))?.name).toBe('Free');
  });
});

describe('DELETE /lanes/:id', () => {
  it('releases the posts and drops the mutes along with the lane', async () => {
    const lane = await seedLane();
    const post = await seedPost(scope, { oxyUserId: VIEWER_ID, laneId: lane.id });
    await getDb().insert(laneMutes).values({
      viewerOxyUserId: OTHER_USER_ID,
      laneId: lane.id,
      laneOwnerOxyUserId: VIEWER_ID,
    });

    const res = await request(app).delete(`/lanes/${lane.id}`);

    expect(res.status).toBe(200);
    expect(await readLane(lane.id)).toBeUndefined();
    // EXISTS first: deleting the lane must remove the CURATION, never the posts.
    const released = await readPostRow(post.id);
    expect(released).toBeDefined();
    expect(released?.laneId).toBeNull();
    expect(await mutesOf(OTHER_USER_ID)).toEqual([]);
  });

  it('writes NULL rather than leaving the post pointing at a lane that is gone', async () => {
    // `post_lane_chrono_v1` is partial on `lane_id is not null`, and the profile
    // exclusion reads `lane_id`: a dangling value would put a post the owner had
    // tucked away back on their profile.
    const lane = await seedLane({ displayMode: 'hidden' });
    const post = await seedPost(scope, { oxyUserId: VIEWER_ID, laneId: lane.id });

    await request(app).delete(`/lanes/${lane.id}`);

    expect((await readPostRow(post.id))?.laneId).toBeNull();
  });

  it("answers 404 for somebody else's lane and writes nothing", async () => {
    const lane = await seedLane({ ownerId: OTHER_USER_ID });

    const res = await request(app).delete(`/lanes/${lane.id}`);

    expect(res.status).toBe(404);
    expect(await readLane(lane.id)).toBeDefined();
  });

  it('answers 404 for a lane that does not exist', async () => {
    const res = await request(app).delete(`/lanes/${uuidv7()}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /lanes/:id/mute', () => {
  it("mutes another publisher's lane and denormalizes its owner", async () => {
    const lane = await seedLane({ ownerId: OTHER_USER_ID });

    const res = await request(app).post(`/lanes/${lane.id}/mute`);

    expect(res.status).toBe(201);
    const stored = await mutesOf(VIEWER_ID);
    expect(stored).toHaveLength(1);
    // Denormalized so the settings screen groups a reader's mutes by publisher
    // with no join.
    expect(stored[0].laneOwnerOxyUserId).toBe(OTHER_USER_ID);
  });

  it('refuses to mute your OWN lane', async () => {
    // It would delete your own posts from your own Following feed, which nobody
    // means to ask for.
    const lane = await seedLane();

    const res = await request(app).post(`/lanes/${lane.id}/mute`);

    expect(res.status).toBe(400);
    expect(await mutesOf(VIEWER_ID)).toEqual([]);
  });

  it("refuses to MUTE a channel's lane — there is no push to suppress", async () => {
    // A channel post is never pushed anywhere, and storing the mute would put a
    // CHANNEL id into `lane_owner_oxy_user_id`, which `GET /lanes/muted`
    // resolves as a user id.
    const channel = await seedChannel(OTHER_USER_ID);
    const lane = await seedLane({ ownerType: 'channel', ownerId: channel.id });

    const res = await request(app).post(`/lanes/${lane.id}/mute`);

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('unfollow the channel');
    expect(await mutesOf(VIEWER_ID)).toEqual([]);
  });

  it('is idempotent — a repeat succeeds and writes no second row', async () => {
    const lane = await seedLane({ ownerId: OTHER_USER_ID });

    await request(app).post(`/lanes/${lane.id}/mute`);
    const second = await request(app).post(`/lanes/${lane.id}/mute`);

    expect(second.status).toBe(200);
    expect(await mutesOf(VIEWER_ID)).toHaveLength(1);
  });

  it('enforces the mute cap', async () => {
    const rows = await getDb()
      .insert(lanes)
      .values(
        Array.from({ length: MAX_MUTED_LANES }, (_unused, index) => {
          const name = `cap ${run} ${index}`;
          return { ownerType: 'user' as const, ownerId: OTHER_USER_ID, name, nameLower: name };
        }),
      )
      .returning({ id: lanes.id });
    createdLaneIds.push(...rows.map((row) => row.id));
    await getDb()
      .insert(laneMutes)
      .values(
        rows.map((row) => ({
          viewerOxyUserId: VIEWER_ID,
          laneId: row.id,
          laneOwnerOxyUserId: OTHER_USER_ID,
        })),
      );
    const oneMore = await seedLane({ ownerId: OTHER_USER_ID });

    const res = await request(app).post(`/lanes/${oneMore.id}/mute`);

    expect(res.status).toBe(400);
    expect(res.body.message).toContain(String(MAX_MUTED_LANES));
  });

  it('answers 404 for a lane that does not exist', async () => {
    const res = await request(app).post(`/lanes/${uuidv7()}/mute`);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /lanes/:id/mute', () => {
  it('unmutes, and answers the same success when there was nothing to unmute', async () => {
    const lane = await seedLane({ ownerId: OTHER_USER_ID });
    await request(app).post(`/lanes/${lane.id}/mute`);

    const first = await request(app).delete(`/lanes/${lane.id}/mute`);
    const second = await request(app).delete(`/lanes/${lane.id}/mute`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await mutesOf(VIEWER_ID)).toEqual([]);
  });

  it("leaves another reader's mute of the same lane alone", async () => {
    const lane = await seedLane({ ownerId: OTHER_USER_ID });
    await getDb().insert(laneMutes).values({
      viewerOxyUserId: OTHER_USER_ID,
      laneId: lane.id,
      laneOwnerOxyUserId: OTHER_USER_ID,
    });

    await request(app).delete(`/lanes/${lane.id}/mute`);

    expect(await mutesOf(OTHER_USER_ID)).toHaveLength(1);
  });
});

/**
 * A channel curates its page the way a user curates a profile, and its lanes
 * belong to the channel's OWNER alone — a publisher publishes into them, it does
 * not define them.
 */
describe('channel-owned lanes', () => {
  it('creates a lane on a channel the caller owns', async () => {
    const channel = await seedChannel(VIEWER_ID);

    const res = await createLane({ channelId: channel.id, displayMode: 'tab' });

    expect(res.status).toBe(201);
    expect(res.body.data.ownerType).toBe('channel');
    expect(res.body.data.ownerId).toBe(channel.id);
  });

  it("counts the cap PER PUBLISHER, not against the caller's own lanes", async () => {
    const channel = await seedChannel(VIEWER_ID);
    for (let index = 0; index < MAX_LANES_PER_OWNER; index += 1) {
      await seedLane();
    }

    const res = await createLane({ channelId: channel.id });

    // A prolific personal lane list must not eat the channel's budget.
    expect(res.status).toBe(201);
  });

  it("403s a caller who is not the channel's owner", async () => {
    const channel = await seedChannel(OTHER_USER_ID);

    const res = await request(app)
      .post('/lanes')
      .send({ name: uniqueName(), channelId: channel.id });

    expect(res.status).toBe(403);
  });

  it('404s an unknown channel — no existence oracle', async () => {
    const res = await request(app).post('/lanes').send({ name: uniqueName(), channelId: uuidv7() });

    expect(res.status).toBe(404);
  });

  it("GET /lanes/mine?channelId= serves the channel's management view", async () => {
    // Unlike the public list this includes `mixed` and `hidden` — it is the
    // owner's own screen, not the profile's tabs.
    const channel = await seedChannel(VIEWER_ID);
    const hidden = await seedLane({
      ownerType: 'channel',
      ownerId: channel.id,
      displayMode: 'hidden',
    });

    const res = await request(app).get(`/lanes/mine?channelId=${channel.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data.map((lane: { id: string }) => lane.id)).toEqual([hidden.id]);
  });

  it("releases EVERY publisher's posts when a channel lane is deleted", async () => {
    // The Mongo delete scoped its post update to the lane's publisher, so a post
    // written by a different publisher kept a dangling `laneId`. The foreign key
    // is unscoped, which is what the invariant actually says.
    const channel = await seedChannel(VIEWER_ID);
    const lane = await seedLane({ ownerType: 'channel', ownerId: channel.id });
    const byOwner = await seedPost(scope, {
      oxyUserId: VIEWER_ID,
      channelId: channel.id,
      laneId: lane.id,
    });
    const byPublisher = await seedPost(scope, {
      oxyUserId: OTHER_USER_ID,
      channelId: channel.id,
      laneId: lane.id,
    });

    const res = await request(app).delete(`/lanes/${lane.id}`);

    expect(res.status).toBe(200);
    expect((await readPostRow(byOwner.id))?.laneId).toBeNull();
    expect((await readPostRow(byPublisher.id))?.laneId).toBeNull();
  });

  it('404s deleting a channel lane the caller does not own', async () => {
    const channel = await seedChannel(OTHER_USER_ID);
    const lane = await seedLane({ ownerType: 'channel', ownerId: channel.id });

    const res = await request(app).delete(`/lanes/${lane.id}`);

    expect(res.status).toBe(404);
    expect(await readLane(lane.id)).toBeDefined();
  });

  it('lets the channel owner edit a channel lane, which the id guard used to refuse', async () => {
    // `callerManagesLane` short-circuited on `ObjectId.isValid(lane.ownerId)`,
    // which is `false` for every uuid v7 channel — so this answered 404 to the
    // one person entitled to it.
    const channel = await seedChannel(VIEWER_ID);
    const lane = await seedLane({ ownerType: 'channel', ownerId: channel.id });

    const res = await request(app).patch(`/lanes/${lane.id}`).send({ displayMode: 'tab' });

    expect(res.status).toBe(200);
    expect((await readLane(lane.id))?.displayMode).toBe('tab');
  });
});
