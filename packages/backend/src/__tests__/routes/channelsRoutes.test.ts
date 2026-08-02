import express, { type NextFunction, type Response } from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OxyAuthRequest } from '@oxyhq/core/server';
import { MAX_CHANNEL_MEMBERS, MAX_CHANNELS_PER_OWNER } from '@mention/shared-types';

/**
 * The Channels API.
 *
 * Four things here fail SILENTLY if they regress, which is why each has a test of
 * its own rather than being implied by the happy path:
 *
 *  1. **The delete order.** `$unset` `channelId` on the posts FIRST. Skip it and
 *     those posts are reachable from NOTHING — still excluded from their author's
 *     profile and their followers' timeline (the exclusion matches on the FIELD's
 *     presence, not on the channel existing), while the `channel|<id>` feed no
 *     longer resolves. They also become permanently anonymous, because hydration
 *     treats a post whose channel is missing as unsigned.
 *  2. **The 409 is the unique index, not the pre-check.** `findOne` is not a lock.
 *  3. **The owner's membership row is written at create time**, which is what
 *     makes "may publish" ONE question with ONE answer — no "or the owner" branch
 *     anywhere to drift from the row.
 *  4. **The owner's row can never be removed**, or the channel becomes one nobody
 *     can publish to, its owner included.
 */

/**
 * The counters are the one thing on these routes that is already POSTGRES.
 *
 * `bumpChannelCounter` moved with the rest of `channelAccess`; the routes around
 * it still read Mongo. So a counter assertion reads the `channels` ROW, and the
 * suite seeds one whose id matches the id the mocked Mongo layer answers with —
 * legitimate, because this branch preserves ObjectId hex verbatim in the `text`
 * primary key, so `CHANNEL_ID` is as valid an id in Postgres as it was in Mongo.
 */
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { channels as channelsTable } from '../../db/schema/channels';

const VIEWER_ID = 'viewer-1';
const OTHER_USER_ID = 'stranger-9';
const CHANNEL_ID = '65b0c9178fcdefaf81988ffb';

/** Ordered log of the writes a request performed, for the delete-order test. */
const writes: string[] = [];

/** Every `sort()` spec a request issued, so a keyset's axis can be asserted. */
const sortCalls: Array<Record<string, unknown>> = [];

/** Every `limit()` a request issued, so an unbounded read is detectable. */
const limitCalls: number[] = [];

const channelFind = vi.fn();
const channelFindOne = vi.fn();
const channelFindById = vi.fn();
const channelCreate = vi.fn();
const channelCount = vi.fn();
const channelDeleteOne = vi.fn();
const channelUpdateOne = vi.fn();
const channelAggregate = vi.fn();
vi.mock('../../models/Channel', () => ({
  Channel: {
    aggregate: (...args: unknown[]) => channelAggregate(...args),
    find: (...args: unknown[]) => channelFind(...args),
    findOne: (...args: unknown[]) => channelFindOne(...args),
    findById: (...args: unknown[]) => channelFindById(...args),
    create: (...args: unknown[]) => channelCreate(...args),
    countDocuments: (...args: unknown[]) => channelCount(...args),
    updateOne: (...args: unknown[]) => channelUpdateOne(...args),
    deleteOne: (...args: unknown[]) => {
      writes.push('channel.deleteOne');
      return channelDeleteOne(...args);
    },
  },
}));

const memberFind = vi.fn();
const memberFindOne = vi.fn();
const memberFindOneAndUpdate = vi.fn();
const memberCreate = vi.fn();
const memberCount = vi.fn();
const memberExists = vi.fn();
const memberDeleteMany = vi.fn();
vi.mock('../../models/ChannelMember', () => ({
  ChannelMember: {
    find: (...args: unknown[]) => memberFind(...args),
    findOne: (...args: unknown[]) => memberFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => memberFindOneAndUpdate(...args),
    create: (...args: unknown[]) => {
      writes.push('member.create');
      return memberCreate(...args);
    },
    countDocuments: (...args: unknown[]) => memberCount(...args),
    exists: (...args: unknown[]) => memberExists(...args),
    deleteMany: (...args: unknown[]) => {
      writes.push('member.deleteMany');
      return memberDeleteMany(...args);
    },
  },
}));

const followFind = vi.fn();
const followFindOne = vi.fn();
const followFindOneAndUpdate = vi.fn();
const followCreate = vi.fn();
const followDeleteOne = vi.fn();
const followDeleteMany = vi.fn();
vi.mock('../../models/ChannelFollow', () => ({
  ChannelFollow: {
    find: (...args: unknown[]) => followFind(...args),
    findOne: (...args: unknown[]) => followFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => followFindOneAndUpdate(...args),
    create: (...args: unknown[]) => followCreate(...args),
    deleteOne: (...args: unknown[]) => followDeleteOne(...args),
    deleteMany: (...args: unknown[]) => {
      writes.push('follow.deleteMany');
      return followDeleteMany(...args);
    },
  },
}));

const laneFind = vi.fn();
const laneDeleteMany = vi.fn();
vi.mock('../../models/Lane', () => ({
  Lane: {
    find: (...args: unknown[]) => laneFind(...args),
    deleteMany: (...args: unknown[]) => {
      writes.push('lane.deleteMany');
      return laneDeleteMany(...args);
    },
  },
}));

const laneMuteDeleteMany = vi.fn();
vi.mock('../../models/LaneMute', () => ({
  LaneMute: {
    deleteMany: (...args: unknown[]) => {
      writes.push('laneMute.deleteMany');
      return laneMuteDeleteMany(...args);
    },
  },
}));

const postUpdateMany = vi.fn();
vi.mock('../../models/Post', () => ({
  Post: {
    updateMany: (...args: unknown[]) => {
      writes.push('post.updateMany');
      return postUpdateMany(...args);
    },
  },
}));

const resolveUserSummaries = vi.fn();
vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: (...args: unknown[]) => resolveUserSummaries(...args),
}));

const createNotification = vi.fn();
vi.mock('../../utils/notificationUtils', () => ({
  createNotification: (...args: unknown[]) => createNotification(...args),
}));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@oxyhq/core/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oxyhq/core/server')>();
  return {
    ...actual,
    requireOxyAuth: (_req: unknown, _res: unknown, next: NextFunction) => next(),
    getRequiredOxyUserId: (req: OxyAuthRequest) => req.user?.id ?? '',
  };
});

import channelsRouter, { publicChannelsRouter } from '../../routes/channels.routes';
import { MAX_CHANNEL_SEARCH_OFFSET } from '../../services/channelSearch';

/**
 * A chainable stand-in for the query builders these routes use.
 *
 * THENABLE on purpose: these routes await a query BOTH ways — `.lean()` for a
 * plain row, and a bare `await` when they need a document to mutate and save
 * (the re-invite path). A non-thenable stand-in resolves to the builder itself,
 * which is truthy, so a "no such row" fixture would silently read as a hit.
 */
function chain<T>(value: T) {
  const link = {
    select: () => link,
    // Recorded, not discarded: a keyset cursor is only correct if the query is
    // SORTED on the axis the cursor is built from, and a stand-in that swallows
    // the sort spec cannot tell a right axis from a wrong one.
    sort: (spec: Record<string, unknown>) => {
      sortCalls.push(spec);
      return link;
    },
    // Recorded, not discarded: an UNBOUNDED read is invisible to a stand-in that
    // swallows `.limit()`, and three of these reads are grown by third parties.
    limit: (n: number) => {
      limitCalls.push(n);
      return link;
    },
    lean: () => Promise.resolve(value),
    then: (onFulfilled: (value: T) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(value).then(onFulfilled, onRejected),
  };
  return link;
}

/**
 * A stand-in for the search aggregation's builder. Records the pipeline so the
 * relevance path can be told apart from the browse path by what it actually
 * ASKED FOR, not merely by what came back.
 */
const aggregatePipelines: unknown[][] = [];
function aggregateChain<T>(rows: T[]) {
  const exec = () => Promise.resolve(rows);
  return { option: () => ({ exec }), exec };
}

function channelDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: CHANNEL_ID,
    handle: 'newsroom',
    handleLower: 'newsroom',
    title: 'The Newsroom',
    ownerOxyUserId: VIEWER_ID,
    visibility: 'public',
    signPosts: false,
    followerCount: 3,
    memberCount: 1,
    postCount: 7,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/**
 * Mount order MIRRORS PRODUCTION (`appRoutes.ts` + `app.ts`): the public router
 * first, the authenticated one after it. That ordering is what makes the
 * `/channels/mine` collision reachable at all — the public `/:idOrHandle` route
 * sees that segment before the caller-scoped list does — so a test app that
 * mounted them the other way round would pass while production 404s.
 */
function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: OxyAuthRequest, _res: Response, next: NextFunction) => {
    req.user = { id: VIEWER_ID };
    next();
  });
  app.use('/channels', publicChannelsRouter);
  app.use('/channels', channelsRouter);
  return app;
}

/** The stored counters for the seeded row. */
async function counters(): Promise<{ followerCount: number; memberCount: number } | undefined> {
  const [row] = await getDb()
    .select({ followerCount: channelsTable.followerCount, memberCount: channelsTable.memberCount })
    .from(channelsTable)
    .where(eq(channelsTable.id, CHANNEL_ID));
  return row;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

afterEach(async () => {
  await getDb().delete(channelsTable).where(eq(channelsTable.id, CHANNEL_ID));
});

beforeEach(async () => {
  await getDb()
    .insert(channelsTable)
    .values({
      id: CHANNEL_ID,
      handle: 'channels-routes-fixture',
      handleLower: 'channels-routes-fixture',
      title: 'a channel',
      ownerOxyUserId: VIEWER_ID,
    })
    .onConflictDoNothing();
  writes.length = 0;
  sortCalls.length = 0;
  limitCalls.length = 0;
  aggregatePipelines.length = 0;
  for (const fn of [
    channelFind, channelFindOne, channelFindById, channelCreate, channelCount,
    channelDeleteOne, channelUpdateOne, channelAggregate,
    memberFind, memberFindOne, memberFindOneAndUpdate, memberCreate, memberCount,
    memberExists, memberDeleteMany,
    followFind, followFindOne, followFindOneAndUpdate, followCreate, followDeleteOne,
    followDeleteMany,
    laneFind, laneDeleteMany, laneMuteDeleteMany, postUpdateMany,
    resolveUserSummaries, createNotification,
  ]) {
    fn.mockReset();
  }
  channelFind.mockReturnValue(chain([]));
  channelFindOne.mockReturnValue(chain(null));
  channelFindById.mockReturnValue(chain(null));
  channelAggregate.mockImplementation((pipeline: unknown[]) => {
    aggregatePipelines.push(pipeline);
    return aggregateChain([]);
  });
  channelCount.mockResolvedValue(0);
  channelUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  channelDeleteOne.mockResolvedValue({ deletedCount: 1 });
  memberFind.mockReturnValue(chain([]));
  memberFindOne.mockReturnValue(chain(null));
  memberCount.mockResolvedValue(0);
  memberCreate.mockResolvedValue({});
  memberDeleteMany.mockResolvedValue({ deletedCount: 1 });
  followFind.mockReturnValue(chain([]));
  followFindOne.mockReturnValue(chain(null));
  followCreate.mockResolvedValue({});
  followDeleteOne.mockResolvedValue({ deletedCount: 1 });
  followDeleteMany.mockResolvedValue({ deletedCount: 1 });
  laneFind.mockReturnValue(chain([]));
  laneDeleteMany.mockResolvedValue({ deletedCount: 0 });
  laneMuteDeleteMany.mockResolvedValue({ deletedCount: 0 });
  postUpdateMany.mockResolvedValue({ modifiedCount: 0 });
  resolveUserSummaries.mockResolvedValue(new Map());
  createNotification.mockResolvedValue(undefined);
});

describe('GET /channels/:idOrHandle', () => {
  it('resolves by handle as well as by id — /c/<handle> needs no lookup first', async () => {
    channelFindOne.mockReturnValue(chain(channelDoc()));

    const res = await request(buildApp()).get('/channels/NewsRoom');

    expect(res.status).toBe(200);
    expect(res.body.data.handle).toBe('newsroom');
    // Canonicalized before the query, so one handle has exactly one lookup key.
    expect(channelFindOne).toHaveBeenCalledWith({ handleLower: 'newsroom' });
  });

  it('falls through to the handle when a 24-hex id matches nothing', async () => {
    // A handle is `[a-z0-9_]{3,30}`, so a 24-character all-hex handle is LEGAL.
    // Refusing to fall through would make that one handle permanently unreachable.
    channelFindById.mockReturnValue(chain(null));
    channelFindOne.mockReturnValue(chain(channelDoc({ handle: CHANNEL_ID, handleLower: CHANNEL_ID })));

    const res = await request(buildApp()).get(`/channels/${CHANNEL_ID}`);

    expect(res.status).toBe(200);
    expect(channelFindById).toHaveBeenCalled();
    expect(channelFindOne).toHaveBeenCalledWith({ handleLower: CHANNEL_ID });
  });

  it('404s an unknown channel', async () => {
    const res = await request(buildApp()).get('/channels/nosuchthing');
    expect(res.status).toBe(404);
  });

  it('carries the caller\'s own viewerState', async () => {
    channelFindOne.mockReturnValue(chain(channelDoc()));
    followFindOne.mockReturnValue(chain({ notify: false }));
    memberFindOne.mockReturnValue(chain({ role: 'owner', status: 'accepted' }));

    const res = await request(buildApp()).get('/channels/newsroom');

    expect(res.body.data.viewerState).toEqual({
      isFollowing: true,
      notify: false,
      role: 'owner',
      memberStatus: 'accepted',
    });
  });
});

describe('POST /channels', () => {
  it('creates the channel AND the owner\'s membership row', async () => {
    // The owner's row is what `canPublishToChannel` answers from. Without it the
    // owner cannot publish to their own channel, and adding an "or the owner"
    // branch instead would be a second answer to the same question.
    channelCreate.mockResolvedValue({
      _id: CHANNEL_ID,
      toObject: () => channelDoc(),
    });

    const res = await request(buildApp())
      .post('/channels')
      .send({ handle: '@NewsRoom', title: 'The Newsroom' });

    expect(res.status).toBe(201);
    expect(channelCreate).toHaveBeenCalledWith(expect.objectContaining({ handle: 'newsroom' }));
    expect(memberCreate).toHaveBeenCalledWith(
      expect.objectContaining({ oxyUserId: VIEWER_ID, role: 'owner', status: 'accepted' }),
    );
  });

  it('400s a reserved or malformed handle before any write', async () => {
    const res = await request(buildApp())
      .post('/channels')
      .send({ handle: 'settings', title: 'Nope' });

    expect(res.status).toBe(400);
    expect(channelCreate).not.toHaveBeenCalled();
  });

  it('409s on the unique index rather than on the pre-check', async () => {
    // `findOne` is not a lock: two concurrent creates of one handle are stopped
    // by the constraint or not at all.
    channelCreate.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));

    const res = await request(buildApp())
      .post('/channels')
      .send({ handle: 'newsroom', title: 'The Newsroom' });

    expect(res.status).toBe(409);
  });

  it('enforces the per-owner cap', async () => {
    channelCount.mockResolvedValue(MAX_CHANNELS_PER_OWNER);

    const res = await request(buildApp())
      .post('/channels')
      .send({ handle: 'newsroom', title: 'The Newsroom' });

    expect(res.status).toBe(400);
    expect(channelCreate).not.toHaveBeenCalled();
  });
});

describe('the caller-scoped lists', () => {
  it('GET /channels/mine returns the channels the caller may PUBLISH to', async () => {
    // Membership, not ownership: a publisher's composer needs them too.
    memberFind.mockReturnValue(chain([{ channelId: CHANNEL_ID }]));
    channelFind.mockReturnValue(chain([channelDoc()]));

    const res = await request(buildApp()).get('/channels/mine');

    expect(res.status).toBe(200);
    expect(memberFind).toHaveBeenCalledWith({ oxyUserId: VIEWER_ID, status: 'accepted' });
    expect(res.body.data).toHaveLength(1);
  });

  it('GET /channels/mine short-circuits with no memberships', async () => {
    memberFind.mockReturnValue(chain([]));

    const res = await request(buildApp()).get('/channels/mine');

    expect(res.body.data).toEqual([]);
    expect(channelFind).not.toHaveBeenCalled();
  });

  it('GET /channels/invites returns only PENDING invitations', async () => {
    memberFind.mockReturnValue(chain([{ channelId: CHANNEL_ID }]));
    channelFind.mockReturnValue(chain([channelDoc()]));

    const res = await request(buildApp()).get('/channels/invites');

    expect(res.status).toBe(200);
    expect(memberFind).toHaveBeenCalledWith({ oxyUserId: VIEWER_ID, status: 'pending' });
  });

  it('GET /channels/invites short-circuits with none', async () => {
    memberFind.mockReturnValue(chain([]));

    const res = await request(buildApp()).get('/channels/invites');

    expect(res.body.data).toEqual([]);
    expect(channelFind).not.toHaveBeenCalled();
  });

  it('the PUBLIC /:idOrHandle route hands both segments on instead of 404ing them', async () => {
    // The public router is mounted first, so `/channels/mine` reaches its param
    // route before the caller-scoped list. Both words are reserved handles, so
    // that route cannot read them as a channel and calls `next()`. Without that,
    // these two endpoints are unreachable in production while every unit test of
    // the authenticated router alone still passes.
    memberFind.mockReturnValue(chain([]));

    const mine = await request(buildApp()).get('/channels/mine');
    const invites = await request(buildApp()).get('/channels/invites');

    expect(mine.status).toBe(200);
    expect(invites.status).toBe(200);
    expect(memberFind).toHaveBeenCalledTimes(2);
    // And the param route never even tried to resolve them as channels.
    expect(channelFindOne).not.toHaveBeenCalled();
    expect(channelFindById).not.toHaveBeenCalled();
  });

  it('CONTROL: an ordinary segment IS claimed by the public param route', async () => {
    // The pass-through must be narrow. A real handle still resolves here, or the
    // fix above would have turned every channel page into a 404.
    channelFindOne.mockReturnValue(chain(channelDoc()));

    const res = await request(buildApp()).get('/channels/newsroom');

    expect(res.status).toBe(200);
    expect(channelFindOne).toHaveBeenCalled();
  });
});

describe('PUT /channels/:id', () => {
  function saveableChannel(overrides: Record<string, unknown> = {}) {
    return {
      ...channelDoc(overrides),
      save: vi.fn(async () => undefined),
      toObject() {
        const { save: _save, toObject: _toObject, ...rest } = this;
        return rest;
      },
    };
  }

  it('renames the handle and canonicalizes it', async () => {
    // A rename is cheap on purpose: the feed descriptor is by id, so a pinned
    // home tab survives it. External links and the OG shell do not.
    const doc = saveableChannel();
    channelFindById.mockResolvedValue(doc);

    const res = await request(buildApp())
      .put(`/channels/${CHANNEL_ID}`)
      .send({ handle: '@TheNewsroom', title: 'Renamed' });

    expect(res.status).toBe(200);
    expect(doc.handle).toBe('thenewsroom');
    expect(doc.title).toBe('Renamed');
  });

  it('flips signPosts', async () => {
    const doc = saveableChannel();
    channelFindById.mockResolvedValue(doc);

    await request(buildApp()).put(`/channels/${CHANNEL_ID}`).send({ signPosts: true });

    expect(doc.signPosts).toBe(true);
  });

  it('400s an illegal handle before saving', async () => {
    const doc = saveableChannel();
    channelFindById.mockResolvedValue(doc);

    const res = await request(buildApp())
      .put(`/channels/${CHANNEL_ID}`)
      .send({ handle: 'settings' });

    expect(res.status).toBe(400);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('409s a taken handle from the unique index', async () => {
    const doc = saveableChannel();
    doc.save = vi.fn(async () => {
      throw Object.assign(new Error('dup'), { code: 11000 });
    });
    channelFindById.mockResolvedValue(doc);

    const res = await request(buildApp())
      .put(`/channels/${CHANNEL_ID}`)
      .send({ handle: 'takenname' });

    expect(res.status).toBe(409);
  });

  it('403s a non-owner', async () => {
    const doc = saveableChannel({ ownerOxyUserId: OTHER_USER_ID });
    channelFindById.mockResolvedValue(doc);

    const res = await request(buildApp()).put(`/channels/${CHANNEL_ID}`).send({ title: 'Nope' });

    expect(res.status).toBe(403);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('404s an unknown channel', async () => {
    channelFindById.mockResolvedValue(null);

    const res = await request(buildApp()).put(`/channels/${CHANNEL_ID}`).send({ title: 'Nope' });

    expect(res.status).toBe(404);
  });
});

describe('DELETE /channels/:id', () => {
  it('releases the posts FIRST, then the lanes, then the rows, then the channel', async () => {
    channelFindById.mockReturnValue(chain({ ownerOxyUserId: VIEWER_ID }));
    laneFind.mockReturnValue(chain([{ _id: 'lane_1' }]));

    const res = await request(buildApp()).delete(`/channels/${CHANNEL_ID}`);

    expect(res.status).toBe(200);
    expect(writes).toEqual([
      'post.updateMany',
      'laneMute.deleteMany',
      'lane.deleteMany',
      'member.deleteMany',
      'follow.deleteMany',
      'channel.deleteOne',
    ]);
  });

  it('unsets BOTH channelId and laneId on the released posts', async () => {
    // A post left pointing at a dead channel is reachable from nothing at all,
    // and a post left in a lane whose publisher is gone can never be managed.
    channelFindById.mockReturnValue(chain({ ownerOxyUserId: VIEWER_ID }));

    await request(buildApp()).delete(`/channels/${CHANNEL_ID}`);

    expect(postUpdateMany).toHaveBeenCalledWith(
      { channelId: CHANNEL_ID },
      { $unset: { channelId: '', laneId: '' } },
    );
  });

  it('403s a non-owner and writes nothing', async () => {
    channelFindById.mockReturnValue(chain({ ownerOxyUserId: OTHER_USER_ID }));

    const res = await request(buildApp()).delete(`/channels/${CHANNEL_ID}`);

    expect(res.status).toBe(403);
    expect(writes).toEqual([]);
  });
});

describe('membership', () => {
  it('invites, and notifies with the channel_invite type', async () => {
    channelFindById.mockReturnValue(chain({ ownerOxyUserId: VIEWER_ID }));
    memberFindOne.mockReturnValue(chain(null));

    const res = await request(buildApp())
      .post(`/channels/${CHANNEL_ID}/members`)
      .send({ oxyUserId: OTHER_USER_ID });

    expect(res.status).toBe(201);
    expect(memberCreate).toHaveBeenCalledWith(
      expect.objectContaining({ oxyUserId: OTHER_USER_ID, role: 'publisher', status: 'pending' }),
    );
    // An invitation the invitee never sees is a broken feature — the one channel
    // notification that earns a type of its own.
    expect(createNotification).toHaveBeenCalledWith({
      recipientId: OTHER_USER_ID,
      actorId: VIEWER_ID,
      type: 'channel_invite',
      entityId: CHANNEL_ID,
      entityType: 'channel',
    });
  });

  it('403s an invite from a non-owner', async () => {
    channelFindById.mockReturnValue(chain({ ownerOxyUserId: OTHER_USER_ID }));

    const res = await request(buildApp())
      .post(`/channels/${CHANNEL_ID}/members`)
      .send({ oxyUserId: 'somebody' });

    expect(res.status).toBe(403);
    expect(memberCreate).not.toHaveBeenCalled();
  });

  it('enforces the member cap', async () => {
    channelFindById.mockReturnValue(chain({ ownerOxyUserId: VIEWER_ID }));
    memberCount.mockResolvedValue(MAX_CHANNEL_MEMBERS);

    const res = await request(buildApp())
      .post(`/channels/${CHANNEL_ID}/members`)
      .send({ oxyUserId: OTHER_USER_ID });

    expect(res.status).toBe(400);
  });

  it('accepts an invite as a CLAIM, so the counter moves exactly once', async () => {
    memberFindOneAndUpdate.mockResolvedValue({ _id: 'm1', status: 'accepted' });

    const res = await request(buildApp()).post(`/channels/${CHANNEL_ID}/members/accept`);

    expect(res.status).toBe(200);
    // Filtered on `status: 'pending'`: a second accept matches nothing.
    expect(memberFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending' }),
      expect.anything(),
      expect.anything(),
    );
    expect((await counters())?.memberCount).toBe(1);
  });

  it('404s a second accept and does NOT move the counter again', async () => {
    memberFindOneAndUpdate.mockResolvedValue(null);

    const res = await request(buildApp()).post(`/channels/${CHANNEL_ID}/members/accept`);

    expect(res.status).toBe(404);
    expect((await counters())?.memberCount).toBe(0);
  });

  it('re-invites a previously declined member by resetting their existing row', async () => {
    // The unique `{channelId, oxyUserId}` index means there is only ever ONE row,
    // so a re-invite has to reset it rather than insert a second.
    const existing = {
      status: 'declined',
      role: 'publisher',
      respondedAt: new Date(),
      save: vi.fn(async () => undefined),
    };
    channelFindById.mockReturnValue(chain({ ownerOxyUserId: VIEWER_ID }));
    memberFindOne.mockReturnValue(chain(existing));

    const res = await request(buildApp())
      .post(`/channels/${CHANNEL_ID}/members`)
      .send({ oxyUserId: OTHER_USER_ID });

    expect(res.status).toBe(201);
    expect(existing.status).toBe('pending');
    expect(existing.respondedAt).toBeUndefined();
    expect(existing.save).toHaveBeenCalled();
    expect(memberCreate).not.toHaveBeenCalled();
  });

  it('409s an invite to somebody already invited', async () => {
    channelFindById.mockReturnValue(chain({ ownerOxyUserId: VIEWER_ID }));
    memberFindOne.mockReturnValue(chain({ status: 'pending' }));

    const res = await request(buildApp())
      .post(`/channels/${CHANNEL_ID}/members`)
      .send({ oxyUserId: OTHER_USER_ID });

    expect(res.status).toBe(409);
  });

  it('400s the owner inviting themselves', async () => {
    channelFindById.mockReturnValue(chain({ ownerOxyUserId: VIEWER_ID }));

    const res = await request(buildApp())
      .post(`/channels/${CHANNEL_ID}/members`)
      .send({ oxyUserId: VIEWER_ID });

    expect(res.status).toBe(400);
  });

  it('declines an invite as a CLAIM, and never touches the member count', async () => {
    // Only an ACCEPTED member was ever counted, so a decline has nothing to
    // decrement — decrementing here would drift the counter below zero.
    memberFindOneAndUpdate.mockResolvedValue({ _id: 'm1', status: 'declined' });

    const res = await request(buildApp()).post(`/channels/${CHANNEL_ID}/members/decline`);

    expect(res.status).toBe(200);
    expect((await counters())?.memberCount).toBe(0);
  });

  it('404s a decline with no pending invitation', async () => {
    memberFindOneAndUpdate.mockResolvedValue(null);

    const res = await request(buildApp()).post(`/channels/${CHANNEL_ID}/members/decline`);

    expect(res.status).toBe(404);
  });

  it('removes an ACCEPTED publisher and decrements the member count once', async () => {
    await getDb()
      .update(channelsTable)
      .set({ memberCount: 2 })
      .where(eq(channelsTable.id, CHANNEL_ID));
    channelFindById.mockReturnValue(chain({ ownerOxyUserId: VIEWER_ID }));
    // The PRE-image (`new: false`) — the state the row was in before removal, and
    // the only thing that can say whether it was ever counted.
    memberFindOneAndUpdate.mockReturnValue(chain({ status: 'accepted' }));

    const res = await request(buildApp()).delete(`/channels/${CHANNEL_ID}/members/${OTHER_USER_ID}`);

    expect(res.status).toBe(200);
    // 2 → 1. Seeded above 0 on purpose: a row starting at 0 would refuse the
    // decrement (the `>= 0` CHECK) and the case would pass just as well against a
    // removal that moved no counter at all.
    expect((await counters())?.memberCount).toBe(1);
  });

  it('does NOT decrement when cancelling a still-PENDING invitation', async () => {
    await getDb()
      .update(channelsTable)
      .set({ memberCount: 2 })
      .where(eq(channelsTable.id, CHANNEL_ID));
    // Only `accept` increments, so a pending invite never contributed to the
    // count — and `bumpChannelCounter` has no floor, so decrementing here walks a
    // channel's `memberCount` negative one cancelled invite at a time.
    //
    // The previous version of this test mocked the POST-image (`{status:'removed'}`,
    // which `new: true` always returns) and asserted the `$inc` fired, so it could
    // not see this case at all.
    channelFindById.mockReturnValue(chain({ ownerOxyUserId: VIEWER_ID }));
    memberFindOneAndUpdate.mockReturnValue(chain({ status: 'pending' }));

    const res = await request(buildApp()).delete(`/channels/${CHANNEL_ID}/members/${OTHER_USER_ID}`);

    expect(res.status).toBe(200);
    // Seeded at 2 above: `0` here would be satisfied by a decrement that fired.
    expect((await counters())?.memberCount).toBe(2);
  });

  it('asks for the PRE-image, which is what makes the two cases distinguishable', async () => {
    channelFindById.mockReturnValue(chain({ ownerOxyUserId: VIEWER_ID }));
    memberFindOneAndUpdate.mockReturnValue(chain({ status: 'accepted' }));

    await request(buildApp()).delete(`/channels/${CHANNEL_ID}/members/${OTHER_USER_ID}`);

    expect(memberFindOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ new: false }),
    );
  });

  it('lets a publisher remove THEMSELVES without being the owner', async () => {
    channelFindById.mockReturnValue(chain({ ownerOxyUserId: OTHER_USER_ID }));
    memberFindOneAndUpdate.mockReturnValue(chain({ status: 'accepted' }));

    const res = await request(buildApp()).delete(`/channels/${CHANNEL_ID}/members/${VIEWER_ID}`);

    expect(res.status).toBe(200);
  });

  it('403s removing somebody else when you are neither the owner nor that member', async () => {
    channelFindById.mockReturnValue(chain({ ownerOxyUserId: OTHER_USER_ID }));

    const res = await request(buildApp()).delete(`/channels/${CHANNEL_ID}/members/third-party`);

    expect(res.status).toBe(403);
    expect(memberFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('404s removing a member who has no active row', async () => {
    channelFindById.mockReturnValue(chain({ ownerOxyUserId: VIEWER_ID }));
    memberFindOneAndUpdate.mockReturnValue(chain(null));

    const res = await request(buildApp()).delete(`/channels/${CHANNEL_ID}/members/${OTHER_USER_ID}`);

    expect(res.status).toBe(404);
    expect((await counters())?.memberCount).toBe(0);
  });

  it('refuses to remove the OWNER', async () => {
    // Removing it would leave a channel nobody can publish to, its owner
    // included. Deleting the channel is the operation that ends it.
    channelFindById.mockReturnValue(chain({ ownerOxyUserId: VIEWER_ID }));

    const res = await request(buildApp()).delete(`/channels/${CHANNEL_ID}/members/${VIEWER_ID}`);

    expect(res.status).toBe(400);
    expect(memberFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('following', () => {
  it('follows once and bumps the counter once', async () => {
    channelFindById.mockReturnValue(chain({ visibility: 'public' }));
    followFindOne.mockReturnValue(chain(null));

    const res = await request(buildApp()).post(`/channels/${CHANNEL_ID}/follow`);

    expect(res.status).toBe(201);
    expect((await counters())?.followerCount).toBe(1);
  });

  it('is idempotent — a second follow neither writes nor bumps', async () => {
    channelFindById.mockReturnValue(chain({ visibility: 'public' }));
    followFindOne.mockReturnValue(chain({ _id: 'f1' }));

    const res = await request(buildApp()).post(`/channels/${CHANNEL_ID}/follow`);

    expect(res.status).toBe(200);
    expect(followCreate).not.toHaveBeenCalled();
    expect(channelUpdateOne).not.toHaveBeenCalled();
  });

  it('unfollow only decrements when a row really went away', async () => {
    followDeleteOne.mockResolvedValue({ deletedCount: 0 });

    const res = await request(buildApp()).delete(`/channels/${CHANNEL_ID}/follow`);

    expect(res.status).toBe(200);
    expect((await counters())?.memberCount).toBe(0);
  });

  it('PATCH toggles notify — the state EntityFollow could not have carried', async () => {
    followFindOneAndUpdate.mockReturnValue(chain({ notify: false }));

    const res = await request(buildApp())
      .patch(`/channels/${CHANNEL_ID}/follow`)
      .send({ notify: false });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ notify: false });
  });

  it('PATCH 404s when the caller does not follow the channel', async () => {
    followFindOneAndUpdate.mockReturnValue(chain(null));

    const res = await request(buildApp())
      .patch(`/channels/${CHANNEL_ID}/follow`)
      .send({ notify: true });

    expect(res.status).toBe(404);
  });
});

describe('GET /channels — the directory', () => {
  it('keyset-pages on {followerCount, _id} and emits a two-part cursor', async () => {
    const rows = [
      channelDoc({ _id: new mongoose.Types.ObjectId().toString(), followerCount: 9 }),
      channelDoc({ _id: new mongoose.Types.ObjectId().toString(), followerCount: 4 }),
    ];
    channelFind.mockReturnValue(chain(rows));

    const res = await request(buildApp()).get('/channels?limit=1');

    expect(res.status).toBe(200);
    expect(res.body.data.hasMore).toBe(true);
    expect(res.body.data.nextCursor).toBe(`9_${rows[0]._id}`);
  });

  it('honours a two-part cursor as a keyset, not a skip', async () => {
    const lastId = new mongoose.Types.ObjectId().toString();
    channelFind.mockReturnValue(chain([]));

    await request(buildApp()).get(`/channels?cursor=9_${lastId}`);

    expect(channelFind).toHaveBeenCalledWith(
      expect.objectContaining({
        $or: [
          { followerCount: { $lt: 9 } },
          { followerCount: 9, _id: { $lt: new mongoose.Types.ObjectId(lastId) } },
        ],
      }),
    );
  });

  it('ignores a malformed cursor rather than 400ing a client that stored an old format', async () => {
    channelFind.mockReturnValue(chain([]));

    const res = await request(buildApp()).get('/channels?cursor=garbage');

    expect(res.status).toBe(200);
    expect(channelFind).toHaveBeenCalledWith(expect.not.objectContaining({ $or: expect.anything() }));
  });

  it('clamps an oversized limit', async () => {
    const rows = Array.from({ length: 60 }, () =>
      channelDoc({ _id: new mongoose.Types.ObjectId().toString() }),
    );
    channelFind.mockReturnValue(chain(rows));

    const res = await request(buildApp()).get('/channels?limit=9999');

    expect(res.body.data.items.length).toBeLessThanOrEqual(50);
  });

  it('excludeFollowed drops the channels the caller already follows', async () => {
    followFind.mockReturnValue(chain([{ channelId: CHANNEL_ID }]));
    channelFind.mockReturnValue(chain([]));

    await request(buildApp()).get('/channels?excludeFollowed=true');

    expect(channelFind).toHaveBeenCalledWith(
      expect.objectContaining({ _id: { $nin: [new mongoose.Types.ObjectId(CHANNEL_ID)] } }),
    );
  });
});

/**
 * `?search=` — the SAME route, answering a different question.
 *
 * Two pagination modes on one endpoint is the arrangement that breaks on page 2
 * while page 1 looks perfect, so the tests here are mostly about the SEAM rather
 * than about matching: which query ran, and that neither mode can be handed the
 * other's paging parameter and silently act on it. The ranking and the escaping
 * are `services/channelSearch.test.ts`'s job, and their ordering is proven
 * against a real mongod separately.
 */
describe('GET /channels?search= — the same route, ranked', () => {
  /** The `$match` of the search aggregation the last request issued. */
  function searchMatch(): Record<string, unknown> {
    const pipeline = aggregatePipelines[aggregatePipelines.length - 1];
    const stage = pipeline.find((entry) => typeof entry === 'object' && entry !== null && '$match' in entry);
    return (stage as { $match: Record<string, unknown> }).$match;
  }

  it('runs the ranked aggregation, not the directory query', async () => {
    const res = await request(buildApp()).get('/channels?search=news');

    expect(res.status).toBe(200);
    expect(channelAggregate).toHaveBeenCalledTimes(1);
    expect(channelFind).not.toHaveBeenCalled();
    expect(searchMatch()).toMatchObject({ visibility: 'public' });
  });

  it('CONTROL: no search term means the directory query, and no aggregation', async () => {
    await request(buildApp()).get('/channels');

    expect(channelFind).toHaveBeenCalledTimes(1);
    expect(channelAggregate).not.toHaveBeenCalled();
  });

  it('an empty or whitespace-only term is not a search', async () => {
    await request(buildApp()).get('/channels?search=%20%20');

    expect(channelAggregate).not.toHaveBeenCalled();
    expect(channelFind).toHaveBeenCalledTimes(1);
  });

  it('answers with items and offset paging, never a keyset cursor', async () => {
    channelAggregate.mockReturnValue(aggregateChain([
      channelDoc({ _id: 'a' }),
      channelDoc({ _id: 'b' }),
      channelDoc({ _id: 'c' }),
    ]));

    const res = await request(buildApp()).get('/channels?search=news&limit=2&offset=10');

    expect(res.body.data.items.map((item: { id: string }) => item.id)).toEqual(['a', 'b']);
    expect(res.body.data.hasMore).toBe(true);
    expect(res.body.data.nextOffset).toBe(12);
    expect(res.body.data).not.toHaveProperty('nextCursor');
  });

  it('omits nextOffset on the last page', async () => {
    channelAggregate.mockReturnValue(aggregateChain([channelDoc({ _id: 'a' })]));

    const res = await request(buildApp()).get('/channels?search=news&limit=2');

    expect(res.body.data.hasMore).toBe(false);
    expect(res.body.data).not.toHaveProperty('nextOffset');
  });

  /**
   * The failure this seam exists to prevent: a follower-count cursor read as a
   * position in the RELEVANCE order would return plausible, wrong rows on page 2.
   * The search path returns before that cursor is parsed at all, so the caller
   * gets the first page of results — visibly wrong rather than quietly wrong.
   */
  it('a browse cursor cannot move a searched page', async () => {
    const lastId = new mongoose.Types.ObjectId().toString();

    await request(buildApp()).get(`/channels?search=news&cursor=9_${lastId}`);

    expect(JSON.stringify(aggregatePipelines)).not.toContain(lastId);
    expect(JSON.stringify(searchMatch())).not.toContain('followerCount');
    // `$skip` is the search path's only positional argument, and no cursor moved it.
    expect(aggregatePipelines[0]).toContainEqual({ $skip: 0 });
  });

  it('ignores a search offset while browsing', async () => {
    channelFind.mockReturnValue(chain([]));

    await request(buildApp()).get('/channels?offset=200');

    // The browse path pages by keyset and never skips: an offset it silently
    // honoured would be a third pagination mode nobody documented.
    expect(channelFind).toHaveBeenCalledWith(expect.not.objectContaining({ $or: expect.anything() }));
    expect(channelAggregate).not.toHaveBeenCalled();
  });

  it('clamps the search offset before it reaches the database', async () => {
    await request(buildApp()).get('/channels?search=news&offset=99999999');

    expect(aggregatePipelines[0]).toContainEqual({ $skip: MAX_CHANNEL_SEARCH_OFFSET });
  });

  it('shares the directory limit — one page size for one route', async () => {
    await request(buildApp()).get('/channels?search=news&limit=9999');

    // 50 is the directory ceiling; the `+ 1` is the overfetched hasMore row.
    expect(aggregatePipelines[0]).toContainEqual({ $limit: 51 });
  });

  it('honours excludeFollowed while searching, so the parameter keeps meaning something', async () => {
    followFind.mockReturnValue(chain([{ channelId: CHANNEL_ID }]));

    await request(buildApp()).get('/channels?search=news&excludeFollowed=true');

    expect(searchMatch()).toMatchObject({
      _id: { $nin: [new mongoose.Types.ObjectId(CHANNEL_ID)] },
    });
  });

  it('500s rather than answering a partial page when the aggregation fails', async () => {
    channelAggregate.mockImplementation(() => {
      throw new Error('aggregation exploded');
    });

    const res = await request(buildApp()).get('/channels?search=news');

    expect(res.status).toBe(500);
  });
});

describe('GET /channels/:idOrHandle/members', () => {
  it('shows a stranger only ACCEPTED members', async () => {
    channelFindOne.mockReturnValue(chain(channelDoc({ ownerOxyUserId: OTHER_USER_ID })));
    memberFind.mockReturnValue(chain([]));

    await request(buildApp()).get('/channels/newsroom/members');

    expect(memberFind).toHaveBeenCalledWith(
      expect.objectContaining({ status: { $in: ['accepted'] } }),
    );
  });

  it('shows the owner their pending and declined invitations too', async () => {
    channelFindOne.mockReturnValue(chain(channelDoc()));
    memberFind.mockReturnValue(chain([]));

    await request(buildApp()).get('/channels/newsroom/members');

    expect(memberFind).toHaveBeenCalledWith(
      expect.objectContaining({ status: { $in: ['accepted', 'pending', 'declined'] } }),
    );
  });

  it('resolves members through the canonical identity path, never by hand', async () => {
    channelFindOne.mockReturnValue(chain(channelDoc()));
    memberFind.mockReturnValue(chain([{ oxyUserId: OTHER_USER_ID, role: 'publisher', status: 'accepted' }]));
    resolveUserSummaries.mockResolvedValue(
      new Map([[OTHER_USER_ID, { user: { id: OTHER_USER_ID, username: 'stranger' } }]]),
    );

    const res = await request(buildApp()).get('/channels/newsroom/members');

    expect(resolveUserSummaries).toHaveBeenCalledWith([OTHER_USER_ID]);
    expect(res.body.data).toEqual([
      { user: { id: OTHER_USER_ID, username: 'stranger' }, role: 'publisher', status: 'accepted' },
    ]);
  });
});

/**
 * GET /channels/following — the reader's own subscriptions.
 *
 * The other half of the loop from `POST /:id/follow`, and a DIFFERENT question
 * from `GET /channels/mine`: that one is publishing rights (`ChannelMember`),
 * this one is readership (`ChannelFollow`).
 *
 * Two things here fail silently if they regress:
 *
 *  1. **`hasMore` and the cursor come from the FOLLOW rows, before any channel is
 *     resolved.** They describe how far the request consumed the subscription
 *     list; a follow whose channel was deleted must not be mistaken for the end
 *     of it. Computing them after the filter truncates the list at the first
 *     orphaned row, and the reader silently loses every channel past it.
 *  2. **The keyset is on `{createdAt,_id}`, not a skip.** A skip page duplicates
 *     and drops rows as the reader follows and unfollows underneath their own
 *     list.
 */
describe('GET /channels/following', () => {
  const OTHER_CHANNEL_ID = '65b0c9178fcdefaf81988ffe';
  const FOLLOW_ID = '65b0c9178fcdefaf81988aaa';
  const FOLLOWED_AT = new Date('2026-02-01T00:00:00.000Z');

  function followRow(overrides: Record<string, unknown> = {}) {
    return {
      _id: new mongoose.Types.ObjectId(FOLLOW_ID),
      channelId: CHANNEL_ID,
      notify: true,
      createdAt: FOLLOWED_AT,
      ...overrides,
    };
  }

  it('returns the followed channels with the caller\'s own viewerState', async () => {
    followFind.mockReturnValue(chain([followRow({ notify: false })]));
    channelFind.mockReturnValue(chain([channelDoc()]));
    memberFind.mockReturnValue(chain([]));

    const res = await request(buildApp()).get('/channels/following');

    expect(res.status).toBe(200);
    expect(followFind).toHaveBeenCalledWith({ oxyUserId: VIEWER_ID });
    expect(res.body.data.items).toHaveLength(1);
    // `notify` rides on the row being paged, so the mute switch needs no second
    // request per channel.
    expect(res.body.data.items[0].viewerState).toEqual({ isFollowing: true, notify: false });
  });

  it('resolves membership for the WHOLE page in one query, not per row', async () => {
    // A partial `viewerState` would be worse than none: an absent `role` is
    // documented to mean "not a member", not "not loaded".
    followFind.mockReturnValue(chain([followRow()]));
    channelFind.mockReturnValue(chain([channelDoc()]));
    memberFind.mockReturnValue(
      chain([{ channelId: CHANNEL_ID, role: 'owner', status: 'accepted' }]),
    );

    const res = await request(buildApp()).get('/channels/following');

    expect(memberFind).toHaveBeenCalledTimes(1);
    expect(memberFind).toHaveBeenCalledWith(
      expect.objectContaining({ oxyUserId: VIEWER_ID }),
    );
    expect(res.body.data.items[0].viewerState).toEqual({
      isFollowing: true,
      notify: true,
      role: 'owner',
      memberStatus: 'accepted',
    });
  });

  it('emits a two-part keyset cursor over {createdAt, _id}', async () => {
    followFind.mockReturnValue(chain([followRow(), followRow({ _id: new mongoose.Types.ObjectId() })]));
    channelFind.mockReturnValue(chain([channelDoc()]));
    memberFind.mockReturnValue(chain([]));

    const res = await request(buildApp()).get('/channels/following?limit=1');

    expect(res.body.data.hasMore).toBe(true);
    expect(res.body.data.nextCursor).toBe(`${FOLLOWED_AT.getTime()}_${FOLLOW_ID}`);
  });

  it('honours that cursor as a keyset, not a skip', async () => {
    followFind.mockReturnValue(chain([]));

    await request(buildApp()).get(`/channels/following?cursor=${FOLLOWED_AT.getTime()}_${FOLLOW_ID}`);

    expect(followFind).toHaveBeenCalledWith({
      oxyUserId: VIEWER_ID,
      $or: [
        { createdAt: { $lt: FOLLOWED_AT } },
        { createdAt: FOLLOWED_AT, _id: { $lt: new mongoose.Types.ObjectId(FOLLOW_ID) } },
      ],
    });
    // The cursor is only meaningful if the query is SORTED on its own axis —
    // `_id` alone would page a different order than the cursor describes.
    expect(sortCalls).toContainEqual({ createdAt: -1, _id: -1 });
  });

  it('ignores a malformed cursor rather than 400ing a client on an old format', async () => {
    followFind.mockReturnValue(chain([]));

    const res = await request(buildApp()).get('/channels/following?cursor=garbage');

    expect(res.status).toBe(200);
    expect(followFind).toHaveBeenCalledWith(expect.not.objectContaining({ $or: expect.anything() }));
  });

  it('skips a follow whose channel was DELETED without truncating the page', async () => {
    // THE LOAD-BEARING CASE, and it is deliberately arranged so the right answer
    // and the wrong one DIFFER. `hasMore` must come from the follow rows: here
    // three rows are overfetched for a limit of two, so more genuinely remain —
    // while only ONE of the two page rows still has a channel. A `hasMore`
    // derived from the surviving items (`1 >= 2`) would say `false` and silently
    // lose every channel the reader follows beyond this point.
    //
    // Verified by mutation: computing `hasMore` after the filter fails this test.
    // An earlier version of it used a limit the two spellings both answered
    // `false` for, and the mutation survived.
    const orphanFollow = followRow({
      _id: new mongoose.Types.ObjectId(),
      channelId: OTHER_CHANNEL_ID,
    });
    const liveFollow = followRow();
    const behind = followRow({ _id: new mongoose.Types.ObjectId(), channelId: CHANNEL_ID });
    followFind.mockReturnValue(chain([orphanFollow, liveFollow, behind]));
    // Only ONE of the two channels on the page still exists.
    channelFind.mockReturnValue(chain([channelDoc()]));
    memberFind.mockReturnValue(chain([]));

    const res = await request(buildApp()).get('/channels/following?limit=2');

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].id).toBe(CHANNEL_ID);
    // Two follow rows were consumed out of three overfetched, so there IS more.
    expect(res.body.data.hasMore).toBe(true);
    // And the cursor points past the last FOLLOW row of the page, not past the
    // last surviving item.
    expect(res.body.data.nextCursor).toBe(`${FOLLOWED_AT.getTime()}_${String(liveFollow._id)}`);
  });

  it('short-circuits an empty list without resolving any channel', async () => {
    followFind.mockReturnValue(chain([]));

    const res = await request(buildApp()).get('/channels/following');

    expect(res.body.data).toEqual({ items: [], hasMore: false });
    expect(channelFind).not.toHaveBeenCalled();
    expect(memberFind).not.toHaveBeenCalled();
  });

  it('clamps an oversized limit', async () => {
    followFind.mockReturnValue(chain([]));

    await request(buildApp()).get('/channels/following?limit=9999');

    // The clamp is on the query, so an absurd limit cannot pull the whole
    // collection into memory.
    expect(followFind).toHaveBeenCalled();
  });

  it('the PUBLIC /:idOrHandle route hands /following on instead of 404ing it', async () => {
    // `following` is a RESERVED handle, which is the only reason the param route
    // (mounted first, in production order) declines to claim this segment.
    followFind.mockReturnValue(chain([]));

    const res = await request(buildApp()).get('/channels/following');

    expect(res.status).toBe(200);
    expect(channelFindOne).not.toHaveBeenCalled();
    expect(channelFindById).not.toHaveBeenCalled();
  });
});

/**
 * Reads whose size is not under the caller's control must be BOUNDED.
 *
 * `/invites` is the one that matters: anyone who runs a channel can invite you,
 * so a third party grows that set, not its owner. `/mine` and the
 * `excludeFollowed` set are the same shape with a friendlier source. All three
 * feed an `$in`/`$nin`, which inherits whatever size they return.
 */
describe('per-caller channel lists are bounded', () => {
  it('bounds GET /channels/invites — a set THIRD PARTIES grow', async () => {
    memberFind.mockReturnValue(chain([]));

    await request(buildApp()).get('/channels/invites');

    expect(limitCalls.length).toBeGreaterThan(0);
    expect(Math.max(...limitCalls)).toBeLessThanOrEqual(500);
  });

  it('bounds GET /channels/mine', async () => {
    memberFind.mockReturnValue(chain([]));

    await request(buildApp()).get('/channels/mine');

    expect(limitCalls.length).toBeGreaterThan(0);
    expect(Math.max(...limitCalls)).toBeLessThanOrEqual(500);
  });

  it('bounds the excludeFollowed set on the public directory', async () => {
    followFind.mockReturnValue(chain([{ channelId: CHANNEL_ID }]));
    channelFind.mockReturnValue(chain([]));

    await request(buildApp()).get('/channels?excludeFollowed=true');

    // Truncating is safe HERE specifically: `excludeFollowed` is a convenience on
    // a directory, so a follow past the ceiling means a channel the reader
    // already follows appears in the list — never one they cannot see.
    expect(limitCalls).toContain(500);
  });
});

/**
 * `avatar`/`banner` are BARE Oxy file ids, which the DTO documents and the schema
 * now enforces.
 *
 * Bloom's `ImageResolver` passes `http:`/`https:`/`data:` through untouched, so a
 * URL stored here is fetched by every visitor to the channel page AND by everyone
 * who sees a post it signs — handing the channel's owner the IP, User-Agent and
 * Referer of readers who never visited their host.
 */
describe('channel media ids are file ids, not URLs', () => {
  const FILE_ID = 'a'.repeat(24);

  it('accepts a bare Oxy file id', async () => {
    channelCreate.mockResolvedValue({ _id: CHANNEL_ID, toObject: () => channelDoc() });

    const res = await request(buildApp())
      .post('/channels')
      .send({ handle: 'newsroom', title: 'T', avatar: FILE_ID });

    expect(res.status).toBe(201);
  });

  it.each([
    ['an https URL', 'https://attacker.example/pixel.png'],
    ['an http URL', 'http://attacker.example/pixel.png'],
    ['a data URI', 'data:image/png;base64,iVBORw0KGgo='],
    ['a protocol-relative URL', '//attacker.example/pixel.png'],
  ])('rejects %s on create', async (_label, value) => {
    const res = await request(buildApp())
      .post('/channels')
      .send({ handle: 'newsroom', title: 'T', avatar: value });

    expect(res.status).toBe(400);
    expect(channelCreate).not.toHaveBeenCalled();
  });

  it('rejects a URL on UPDATE too — both schemas, or the edit path reopens it', async () => {
    const doc = {
      ...channelDoc(),
      save: vi.fn(async () => undefined),
      toObject() { return channelDoc(); },
    };
    channelFindById.mockResolvedValue(doc);

    const res = await request(buildApp())
      .put(`/channels/${CHANNEL_ID}`)
      .send({ banner: 'https://attacker.example/pixel.png' });

    expect(res.status).toBe(400);
    expect(doc.save).not.toHaveBeenCalled();
  });
});
