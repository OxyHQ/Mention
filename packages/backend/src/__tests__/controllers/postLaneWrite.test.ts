import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * The two write paths that can set `post.laneId`, and the one rule they share.
 *
 * `PATCH /posts/:id/lane` deliberately carries NO EDIT WINDOW, and that is the
 * single most likely thing for somebody to "fix" later by copying the 30-minute
 * guard out of `updatePost`. The window exists because rewriting the TEXT of a
 * post people have read is a trust problem; moving a post between the author's
 * own carriageways changes no text, does not federate, emits no MTN record and
 * does not set `isEdited`. Pinning already has no window for the same reason.
 */

const postFindOne = vi.fn();
const postUpdateOne = vi.fn();
vi.mock('../../models/Post', () => ({
  Post: {
    findOne: (...args: unknown[]) => postFindOne(...args),
    updateOne: (...args: unknown[]) => postUpdateOne(...args),
  },
}));

const laneExists = vi.fn();
const laneFindById = vi.fn();
vi.mock('../../models/Lane', () => ({
  Lane: {
    exists: (...args: unknown[]) => laneExists(...args),
    findById: (...args: unknown[]) => laneFindById(...args),
  },
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async (objs: object[]) => objs) },
  resolveUserSummaries: vi.fn(async () => new Map()),
  degradedActorSummary: vi.fn(() => ({ id: 'unknown', username: '' })),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(() => ({})),
  createUserScopedOxyServices: vi.fn(() => undefined),
  getServiceOxyClient: vi.fn(() => ({})),
}));

vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));

import { updatePostLane } from '../../controllers/posts.controller';
import type { OxyAuthRequest } from '@oxyhq/core/server';

const USER_ID = 'author-1';
const POST_ID = '507f1f77bcf86cd799439011';
const LANE_ID = new mongoose.Types.ObjectId().toString();

interface MockRes {
  statusCode: number;
  body: unknown;
  status: (code: number) => MockRes;
  json: (body: unknown) => MockRes;
}

function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

function makeReq(body: Record<string, unknown>): OxyAuthRequest {
  return { user: { id: USER_ID }, params: { id: POST_ID }, body } as unknown as OxyAuthRequest;
}

/** A lean post row as the handler projects it. */
/** Records the projection string, so "did it ask for the field" is assertable. */
const selectSpy = vi.fn();

function postRow(extra: Record<string, unknown> = {}) {
  const chain = {
    select: (fields: string) => {
      selectSpy(fields);
      return chain;
    },
    lean: () => Promise.resolve({ _id: POST_ID, oxyUserId: USER_ID, ...extra }),
  };
  return chain;
}

/** What the by-id lookup answers for a post that does not exist. */
function missingPostRow() {
  const chain = {
    select: (fields: string) => {
      selectSpy(fields);
      return chain;
    },
    lean: () => Promise.resolve(null),
  };
  return chain;
}

beforeEach(() => {
  selectSpy.mockReset();
  vi.clearAllMocks();
  postFindOne.mockReturnValue(postRow());
  postUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  laneExists.mockResolvedValue({ _id: LANE_ID });
  laneFindById.mockReturnValue({
    select: () => ({ lean: async () => ({ _id: LANE_ID, name: 'Dev', displayMode: 'tab' }) }),
  });
});

describe('PATCH /posts/:id/lane', () => {
  it('moves the post and answers with the new lane summary', async () => {
    const res = makeRes();

    await updatePostLane(makeReq({ laneId: LANE_ID }), res as never);

    expect(res.statusCode).toBe(200);
    expect(postUpdateOne).toHaveBeenCalledWith(
      { _id: POST_ID, oxyUserId: USER_ID },
      { $set: { laneId: LANE_ID } },
    );
    // The `{data}` envelope, matching every OTHER lane endpoint — this handler
    // sits on the posts router but its only client reads the Lanes feature.
    expect(res.body).toEqual({
      data: { postId: POST_ID, lane: { id: LANE_ID, name: 'Dev', displayMode: 'tab' } },
      message: 'Post lane updated',
    });
  });

  it('$unsets rather than storing null, which the partial index would still cover', async () => {
    const res = makeRes();

    await updatePostLane(makeReq({ laneId: null }), res as never);

    expect(res.statusCode).toBe(200);
    // `post_lane_chrono_v1` is partial on `{ laneId: { $exists: true } }`, and a
    // stored `null` satisfies that — leaving a laneless post indexed forever.
    expect(postUpdateOne).toHaveBeenCalledWith(
      { _id: POST_ID, oxyUserId: USER_ID },
      { $unset: { laneId: '' } },
    );
    expect(res.body).toMatchObject({ data: { lane: null } });
  });

  it('has NO edit window — an old post moves exactly like a new one', async () => {
    // Deliberately far outside the 30-minute window `updatePost` enforces.
    postFindOne.mockReturnValue(postRow({ createdAt: new Date('2020-01-01T00:00:00.000Z') }));
    const res = makeRes();

    await updatePostLane(makeReq({ laneId: LANE_ID }), res as never);

    expect(res.statusCode).toBe(200);
    expect(postUpdateOne).toHaveBeenCalled();
  });

  it('looks the post up by id and authorizes separately, still 404ing a stranger', async () => {
    // The lookup is no longer the gate — it cannot be, because a channel post's
    // `oxyUserId` is the channel and scoping by the caller made every one of
    // them unreachable. `postManagementRefusal` is the gate now, and a refusal
    // answers the SAME 404, so nothing about the reply changed.
    postFindOne.mockReturnValue(postRow());
    const res = makeRes();
    await updatePostLane(makeReq({ laneId: LANE_ID }), res as never);
    expect(postFindOne).toHaveBeenCalledWith({ _id: POST_ID });

    postFindOne.mockReturnValue(missingPostRow());
    const missing = makeRes();
    await updatePostLane(makeReq({ laneId: LANE_ID }), missing as never);
    expect(missing.statusCode).toBe(404);
  });

  it('404s a post belonging to somebody else, with no lane lookup', async () => {
    // Present, readable, and none of the caller's business: no member reader is
    // configured in this suite, so the operator path cannot admit them either.
    postFindOne.mockReturnValue(postRow({ oxyUserId: 'someone-else' }));
    const res = makeRes();

    await updatePostLane(makeReq({ laneId: LANE_ID }), res as never);

    expect(res.statusCode).toBe(404);
    expect(laneExists).not.toHaveBeenCalled();
    expect(postUpdateOne).not.toHaveBeenCalled();
  });

  it('refuses a lane on a reply and on a boost', async () => {
    postFindOne.mockReturnValue(postRow({ parentPostId: 'parent-1' }));
    const reply = makeRes();
    await updatePostLane(makeReq({ laneId: LANE_ID }), reply as never);
    expect(reply.statusCode).toBe(400);

    postFindOne.mockReturnValue(postRow({ boostOf: 'original-1' }));
    const boost = makeRes();
    await updatePostLane(makeReq({ laneId: LANE_ID }), boost as never);
    expect(boost.statusCode).toBe(400);

    expect(postUpdateOne).not.toHaveBeenCalled();
  });

  it('answers 404 for a lane the caller does not own', async () => {
    laneExists.mockResolvedValue(null);
    const res = makeRes();

    await updatePostLane(makeReq({ laneId: LANE_ID }), res as never);

    expect(res.statusCode).toBe(404);
    expect(postUpdateOne).not.toHaveBeenCalled();
  });

  it('rejects a body that is neither a lane id nor an explicit null', async () => {
    const res = makeRes();
    await updatePostLane(makeReq({}), res as never);
    expect(res.statusCode).toBe(400);
    expect(postFindOne).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller', async () => {
    const res = makeRes();
    await updatePostLane({ params: { id: POST_ID }, body: {} } as unknown as OxyAuthRequest, res as never);
    expect(res.statusCode).toBe(401);
  });
});

/**
 * A CHANNEL post IS movable through this route — by the person who wrote it —
 * and the lane it may be moved into is the CHANNEL's, never the mover's.
 *
 * That second half is the dangerous one. A channel post carries the channel as
 * its author and a human in `writtenByOxyUserId`; measuring the lane against the
 * MOVER would offer their personal lanes, and a lane tab is scoped to one author
 * even though the post's DTO stays anonymous — so the writer's identity would be
 * recoverable from which tab the post appears on. The route therefore reads the
 * publisher off the POST, and these tests pin exactly that, in both directions.
 */
describe('PATCH /posts/:id/lane — a channel post moves against the CHANNEL\'s lanes', () => {
  const CHANNEL_ACCOUNT = 'oxy-channel-account';

  /** A channel post: authored by the channel, written by this caller. */
  function channelPostRow(extra: Record<string, unknown> = {}) {
    return postRow({ oxyUserId: CHANNEL_ACCOUNT, writtenByOxyUserId: USER_ID, ...extra });
  }

  it('lets the WRITER move it, though the channel is the author', async () => {
    postFindOne.mockReturnValue(channelPostRow());
    const res = makeRes();

    await updatePostLane(makeReq({ laneId: LANE_ID }), res as never);

    expect(res.statusCode).toBe(200);
  });

  it('measures the lane against the CHANNEL, never the caller', async () => {
    postFindOne.mockReturnValue(channelPostRow());

    await updatePostLane(makeReq({ laneId: LANE_ID }), makeRes() as never);

    expect(laneExists).toHaveBeenCalledWith({ _id: LANE_ID, ownerId: CHANNEL_ACCOUNT });
    // Stated as its own assertion because it is the whole point: the caller's
    // own lanes are NOT eligible, and the two ids differ so this can tell them
    // apart.
    expect(laneExists).not.toHaveBeenCalledWith({ _id: LANE_ID, ownerId: USER_ID });
    expect(CHANNEL_ACCOUNT).not.toBe(USER_ID);
  });

  it('writes scoped to the CHANNEL, so the update cannot silently match nothing', async () => {
    // `updateOne` reports a filter that matches nothing as success. Scoped by the
    // caller, a channel post answered 200 with the new lane summary while never
    // moving.
    postFindOne.mockReturnValue(channelPostRow());

    await updatePostLane(makeReq({ laneId: LANE_ID }), makeRes() as never);

    expect(postUpdateOne).toHaveBeenCalledWith(
      { _id: POST_ID, oxyUserId: CHANNEL_ACCOUNT },
      { $set: { laneId: LANE_ID } },
    );
  });

  it('CONTROL: an ordinary post is still measured against its own owner', async () => {
    postFindOne.mockReturnValue(postRow());

    await updatePostLane(makeReq({ laneId: LANE_ID }), makeRes() as never);

    expect(laneExists).toHaveBeenCalledWith({ _id: LANE_ID, ownerId: USER_ID });
  });

  it('refuses a stranger who neither authored nor wrote it', async () => {
    postFindOne.mockReturnValue(postRow({ oxyUserId: CHANNEL_ACCOUNT, writtenByOxyUserId: 'other-human' }));
    const res = makeRes();

    await updatePostLane(makeReq({ laneId: LANE_ID }), res as never);

    expect(res.statusCode).toBe(404);
    expect(postUpdateOne).not.toHaveBeenCalled();
  });

  it('projects every field the validator and the authorization read', async () => {
    // A projection that does not ask for a field hands `undefined` to the
    // validator with no error anywhere — which is exactly how the previous
    // channel bug shipped.
    postFindOne.mockReturnValue(postRow());

    await updatePostLane(makeReq({ laneId: LANE_ID }), makeRes() as never);

    const selected = String(selectSpy.mock.calls[0]?.[0] ?? '').split(/\s+/);
    expect(selected).toEqual(
      expect.arrayContaining(['parentPostId', 'boostOf', 'laneId', 'oxyUserId', 'writtenByOxyUserId']),
    );
  });
});
