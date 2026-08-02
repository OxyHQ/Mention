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
/** Records the projection string, so "did it ask for the field" is assertable. */
const selectSpy = vi.fn();

function postRow(extra: Record<string, unknown> = {}) {
  const chain = {
    select: (fields: string) => {
      selectSpy(fields);
      return chain;
    },
    lean: () => Promise.resolve({ _id: POST_ID, ...extra }),
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

/**
 * A CHANNEL post may not take a PERSONAL lane — and this path is the one that let
 * it, because it never selected `channelId` and so never passed it to
 * `assertLaneAssignable`.
 *
 * The validator derives the publisher as `channelId ? 'channel' : 'user'`, so
 * without it a channel post is measured against the CALLER's own lanes. Two
 * invariants break at once, and the second is the serious one:
 *
 *  1. "a post with `channelId` never appears on its author's profile"
 *     (`shared-types/src/channel.ts`, rule 3);
 *  2. it DEANONYMIZES. `laneSource`'s user branch queries
 *     `{laneId, oxyUserId: <author>}` and deliberately does NOT apply
 *     `EXCLUDE_CHANNEL_POSTS`, on the stated grounds that the pairing is
 *     impossible by construction. Under `signPosts: false` the DTO is anonymous
 *     but the SURFACE is scoped to one author, so a reader of that lane tab
 *     learns who wrote every "Unknown user" post on it.
 */
describe('PATCH /posts/:id/lane — channel posts', () => {
  const CHANNEL_ID = new mongoose.Types.ObjectId().toString();

  it('measures the lane against the CHANNEL, not the caller', async () => {
    postFindOne.mockReturnValue(postRow({ channelId: CHANNEL_ID }));

    await updatePostLane(makeReq({ laneId: LANE_ID }), makeRes() as never);

    // The scoped lookup is the whole fix: a personal lane is invisible to a
    // channel-scoped query, so it answers 404 exactly as somebody else's would.
    expect(laneExists).toHaveBeenCalledWith({
      _id: LANE_ID,
      ownerType: 'channel',
      ownerId: CHANNEL_ID,
    });
  });

  it('404s a channel post pointed at one of the caller\'s PERSONAL lanes', async () => {
    postFindOne.mockReturnValue(postRow({ channelId: CHANNEL_ID }));
    // The lane exists and belongs to the caller, but not to the channel — which
    // is precisely what the channel-scoped lookup finds nothing for.
    laneExists.mockResolvedValue(null);

    const res = makeRes();
    await updatePostLane(makeReq({ laneId: LANE_ID }), res as never);

    expect(res.statusCode).toBe(404);
    expect(postUpdateOne).not.toHaveBeenCalled();
  });

  it('accepts a lane the CHANNEL owns', async () => {
    postFindOne.mockReturnValue(postRow({ channelId: CHANNEL_ID }));
    laneExists.mockResolvedValue({ _id: LANE_ID });

    const res = makeRes();
    await updatePostLane(makeReq({ laneId: LANE_ID }), res as never);

    expect(res.statusCode).toBe(200);
    expect(postUpdateOne).toHaveBeenCalled();
  });

  it('CONTROL: an ordinary post is still measured against the caller', async () => {
    postFindOne.mockReturnValue(postRow());

    await updatePostLane(makeReq({ laneId: LANE_ID }), makeRes() as never);

    expect(laneExists).toHaveBeenCalledWith({
      _id: LANE_ID,
      ownerType: 'user',
      ownerId: USER_ID,
    });
  });

  it('selects channelId at all — the omission that caused this', async () => {
    // A projection that does not ask for the field hands `undefined` to the
    // validator with no error anywhere, which is exactly how this shipped.
    postFindOne.mockReturnValue(postRow({ channelId: CHANNEL_ID }));

    await updatePostLane(makeReq({ laneId: LANE_ID }), makeRes() as never);

    const selected = String(selectSpy.mock.calls[0]?.[0] ?? '');
    expect(selected.split(/\s+/)).toContain('channelId');
  });
});
