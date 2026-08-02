import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * The two NATIVE reply paths, which are the ones that answer HTTP directly.
 *
 * Both are covered because covering one leaves the other as a back door, and the
 * two are gated for DIFFERENT reasons:
 *
 *  - `feed.controller.createReply` already loads the parent, so the gate is a
 *    predicate — but it has to sit ABOVE the reply-permission block, which is
 *    skipped entirely for an ordinary `['anyone']` post and which contains an
 *    unconditional escape letting an author answer their own post under
 *    `['nobody']`. Both of those are asserted here, not assumed.
 *  - `POST /posts` performs NO parent lookup at all — it validates
 *    `quoted_post_id` and `boost_of` and nothing else — so its gate had to be
 *    added from scratch, and the assertion is that it exists at all.
 *
 * Every refusal is paired with a control: an ordinary parent, and a parent
 * carrying a `laneId`, still accept replies. A lane is a lens, not a destination.
 *
 * The gate keys on the parent AUTHOR's Oxy account kind, so `isChannelAccount` is
 * the seam these tests drive — mocked at `services/publishAsAccount`, the one
 * module that knows what a channel account is.
 */

const postFindById = vi.fn();
const postFindOne = vi.fn();
const postCreate = vi.fn();
vi.mock('../../models/Post', () => {
  class MockPost {
    constructor(data: Record<string, unknown>) {
      Object.assign(this, data);
      postCreate(data);
    }
    _id = new mongoose.Types.ObjectId();
    save = vi.fn(async () => this);
    toObject = () => ({ ...this });
  }
  return {
    Post: Object.assign(MockPost, {
      findById: (...args: unknown[]) => postFindById(...args),
      findOne: (...args: unknown[]) => postFindOne(...args),
    }),
    POST_CLASSIFICATION_PENDING: 'pending',
  };
});

const postCreationCreate = vi.fn();
vi.mock('../../services/PostCreationService', () => ({
  postCreationService: { create: (...args: unknown[]) => postCreationCreate(...args) },
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
vi.mock('../../runtime/oxyClient', () => ({ getRuntimeOxyClient: () => ({}) }));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const isChannelAccount = vi.fn();
vi.mock('../../services/publishAsAccount', () => ({
  isChannelAccount: (...args: unknown[]) => isChannelAccount(...args),
  assertCanPublishAsAccount: vi.fn(
    async (params: { callerId: string | null }) => params.callerId,
  ),
  PublishAsAccessError: class PublishAsAccessError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

import { feedController } from '../../controllers/feed.controller';
import { createPost } from '../../controllers/posts.controller';
import type { OxyAuthRequest } from '@oxyhq/core/server';

const USER_ID = 'author-1';
const PARENT_ID = new mongoose.Types.ObjectId().toString();
const CHANNEL_ACCOUNT = 'oxy-channel-account';
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

/** A chainable stand-in for `Post.findById(...).select(...).lean()`. */
function projection<T>(value: T) {
  const link = { select: () => link, lean: () => Promise.resolve(value) };
  return link;
}

/** What `createReply` reads: `findById(...).maxTimeMS(...).lean()`. */
function parentDoc(extra: Record<string, unknown>) {
  const link = {
    maxTimeMS: () => link,
    select: () => link,
    lean: () => Promise.resolve({
      _id: new mongoose.Types.ObjectId(PARENT_ID),
      oxyUserId: USER_ID,
      threadId: PARENT_ID,
      ...extra,
    }),
  };
  return link;
}

beforeEach(() => {
  postFindById.mockReset();
  postFindOne.mockReset();
  postCreate.mockReset();
  isChannelAccount.mockReset();
  isChannelAccount.mockImplementation(async (id: string) => id === CHANNEL_ACCOUNT);
  postCreationCreate.mockReset();
  postCreationCreate.mockResolvedValue({
    _id: new mongoose.Types.ObjectId(),
    content: { text: 'x' },
    toObject: () => ({ _id: 'p1', content: { text: 'x' } }),
  });
});

describe('site 1 — feed.controller.createReply', () => {
  function replyReq(): OxyAuthRequest {
    return {
      user: { id: USER_ID },
      body: { postId: PARENT_ID, content: 'a reply' },
    } as unknown as OxyAuthRequest;
  }

  it('refuses a reply to a channel post with 403, even for the channel\'s own member', async () => {
    // The author-replying-to-themselves escape inside the reply-permission block
    // is exactly what this gate has to sit above.
    postFindById.mockReturnValue(parentDoc({ oxyUserId: CHANNEL_ACCOUNT }));
    const res = makeRes();
    await feedController.createReply(replyReq(), res as never);
    expect(res.statusCode).toBe(403);
    expect(postCreate).not.toHaveBeenCalled();
  });

  it('refuses even when the parent says replyPermission: ["anyone"]', async () => {
    // The permission block is SKIPPED for `['anyone']`, so a gate placed inside it
    // would never run on an ordinary post. This asserts it is placed above.
    postFindById.mockReturnValue(
      parentDoc({ oxyUserId: CHANNEL_ACCOUNT, replyPermission: ['anyone'] }),
    );
    const res = makeRes();
    await feedController.createReply(replyReq(), res as never);
    expect(res.statusCode).toBe(403);
  });

  it('CONTROL: an ordinary post still accepts a reply', async () => {
    postFindById.mockReturnValue(parentDoc({ replyPermission: ['anyone'] }));
    const res = makeRes();
    await feedController.createReply(replyReq(), res as never);
    expect(res.statusCode).not.toBe(403);
    expect(postCreate).toHaveBeenCalled();
  });

  it('CONTROL: a post carrying a laneId still accepts a reply', async () => {
    postFindById.mockReturnValue(
      parentDoc({ laneId: LANE_ID, replyPermission: ['anyone'] }),
    );
    const res = makeRes();
    await feedController.createReply(replyReq(), res as never);
    expect(res.statusCode).not.toBe(403);
    expect(postCreate).toHaveBeenCalled();
  });
});

describe('site 2 — POST /posts carrying a parent id', () => {
  function postReq(body: Record<string, unknown>): OxyAuthRequest {
    return {
      user: { id: USER_ID },
      body: { content: { text: 'a reply' }, ...body },
    } as unknown as OxyAuthRequest;
  }

  it('refuses a reply to a channel post with 403 via parentPostId', async () => {
    postFindById.mockReturnValue(projection({ oxyUserId: CHANNEL_ACCOUNT }));
    const res = makeRes();
    await createPost(postReq({ parentPostId: PARENT_ID }), res as never);
    expect(res.statusCode).toBe(403);
    expect(postCreationCreate).not.toHaveBeenCalled();
  });

  it('refuses through the in_reply_to_status_id alias too', async () => {
    // The controller accepts BOTH spellings and hands whichever it got to
    // `PostCreationService` as `parentPostId`; a gate reading only one of them
    // would leave the other as the back door.
    postFindById.mockReturnValue(projection({ oxyUserId: CHANNEL_ACCOUNT }));
    const res = makeRes();
    await createPost(postReq({ in_reply_to_status_id: PARENT_ID }), res as never);
    expect(res.statusCode).toBe(403);
    expect(postCreationCreate).not.toHaveBeenCalled();
  });

  it('CONTROL: an ordinary parent still accepts a reply', async () => {
    postFindById.mockReturnValue(projection({ oxyUserId: USER_ID }));
    const res = makeRes();
    await createPost(postReq({ parentPostId: PARENT_ID }), res as never);
    expect(res.statusCode).not.toBe(403);
    expect(postCreationCreate).toHaveBeenCalled();
  });

  it('CONTROL: a parent carrying a laneId still accepts a reply', async () => {
    postFindById.mockReturnValue(projection({ oxyUserId: USER_ID, laneId: LANE_ID }));
    const res = makeRes();
    await createPost(postReq({ parentPostId: PARENT_ID }), res as never);
    expect(res.statusCode).not.toBe(403);
    expect(postCreationCreate).toHaveBeenCalled();
  });

  it('CONTROL: a top-level post performs no parent lookup at all', async () => {
    const res = makeRes();
    await createPost(postReq({}), res as never);
    expect(postFindById).not.toHaveBeenCalled();
    expect(postCreationCreate).toHaveBeenCalled();
  });
});
