import express, { type NextFunction, type Response } from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const VIEWER_ID = 'viewer-1';
const OTHER_USER_ID = 'stranger-9';
const CHANNEL_ID = '65b0c9178fcdefaf81988ffb';

/** Ordered log of the writes a request performed, for the delete-order test. */
const writes: string[] = [];

const channelFind = vi.fn();
const channelFindOne = vi.fn();
const channelFindById = vi.fn();
const channelCreate = vi.fn();
const channelCount = vi.fn();
const channelDeleteOne = vi.fn();
const channelUpdateOne = vi.fn();
vi.mock('../../models/Channel', () => ({
  Channel: {
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
    sort: () => link,
    limit: () => link,
    lean: () => Promise.resolve(value),
    then: (onFulfilled: (value: T) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(value).then(onFulfilled, onRejected),
  };
  return link;
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

beforeEach(() => {
  writes.length = 0;
  for (const fn of [
    channelFind, channelFindOne, channelFindById, channelCreate, channelCount,
    channelDeleteOne, channelUpdateOne,
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
    expect(channelUpdateOne).toHaveBeenCalledWith(
      { _id: CHANNEL_ID },
      { $inc: { memberCount: 1 } },
    );
  });

  it('404s a second accept and does NOT move the counter again', async () => {
    memberFindOneAndUpdate.mockResolvedValue(null);

    const res = await request(buildApp()).post(`/channels/${CHANNEL_ID}/members/accept`);

    expect(res.status).toBe(404);
    expect(channelUpdateOne).not.toHaveBeenCalled();
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
    expect(channelUpdateOne).not.toHaveBeenCalled();
  });

  it('404s a decline with no pending invitation', async () => {
    memberFindOneAndUpdate.mockResolvedValue(null);

    const res = await request(buildApp()).post(`/channels/${CHANNEL_ID}/members/decline`);

    expect(res.status).toBe(404);
  });

  it('removes a publisher and decrements the member count once', async () => {
    channelFindById.mockReturnValue(chain({ ownerOxyUserId: VIEWER_ID }));
    memberFindOneAndUpdate.mockReturnValue(chain({ status: 'removed' }));

    const res = await request(buildApp()).delete(`/channels/${CHANNEL_ID}/members/${OTHER_USER_ID}`);

    expect(res.status).toBe(200);
    expect(channelUpdateOne).toHaveBeenCalledWith(
      { _id: CHANNEL_ID },
      { $inc: { memberCount: -1 } },
    );
  });

  it('lets a publisher remove THEMSELVES without being the owner', async () => {
    channelFindById.mockReturnValue(chain({ ownerOxyUserId: OTHER_USER_ID }));
    memberFindOneAndUpdate.mockReturnValue(chain({ status: 'removed' }));

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
    expect(channelUpdateOne).not.toHaveBeenCalled();
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
    expect(channelUpdateOne).toHaveBeenCalledWith(
      { _id: CHANNEL_ID },
      { $inc: { followerCount: 1 } },
    );
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
    expect(channelUpdateOne).not.toHaveBeenCalled();
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
