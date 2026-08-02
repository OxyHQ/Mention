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
function postRow(extra: Record<string, unknown> = {}) {
  const chain = { select: () => chain, lean: () => Promise.resolve({ _id: POST_ID, ...extra }) };
  return chain;
}

beforeEach(() => {
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
    expect(res.body).toMatchObject({
      postId: POST_ID,
      lane: { id: LANE_ID, name: 'Dev', displayMode: 'tab' },
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
    expect(res.body).toMatchObject({ lane: null });
  });

  it('has NO edit window — an old post moves exactly like a new one', async () => {
    // Deliberately far outside the 30-minute window `updatePost` enforces.
    postFindOne.mockReturnValue(postRow({ createdAt: new Date('2020-01-01T00:00:00.000Z') }));
    const res = makeRes();

    await updatePostLane(makeReq({ laneId: LANE_ID }), res as never);

    expect(res.statusCode).toBe(200);
    expect(postUpdateOne).toHaveBeenCalled();
  });

  it('scopes the lookup to the caller, so somebody else\'s post is a 404', async () => {
    postFindOne.mockReturnValue(postRow());
    const res = makeRes();
    await updatePostLane(makeReq({ laneId: LANE_ID }), res as never);
    expect(postFindOne).toHaveBeenCalledWith({ _id: POST_ID, oxyUserId: USER_ID });

    postFindOne.mockReturnValue({ select: () => ({ lean: async () => null }) });
    const missing = makeRes();
    await updatePostLane(makeReq({ laneId: LANE_ID }), missing as never);
    expect(missing.statusCode).toBe(404);
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
