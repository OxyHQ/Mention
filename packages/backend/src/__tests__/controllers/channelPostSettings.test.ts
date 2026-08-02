import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * The two SETTINGS-shaped guards a channel post needs, both of which exist so the
 * server never has to rely on `replyPermission` for anything.
 *
 *  - `PATCH /posts/:id/settings` refuses to change `replyPermission` on a channel
 *    post. The 403 on the reply paths reads the AUTHOR's account kind and would
 *    hold regardless — but a change here would UN-HIDE the client's reply button
 *    and leave every reader hitting a refusal they were invited to attempt.
 *  - `POST /posts/thread` refuses a `publishAsOxyUserId` outright: in thread mode
 *    the continuations are replies, and a channel post accepts none, so the thread
 *    would be a root under the channel with its body scattered across posts the
 *    channel refuses.
 */

const postFindOne = vi.fn();
vi.mock('../../models/Post', () => ({
  Post: {
    findOne: (...args: unknown[]) => postFindOne(...args),
    findById: vi.fn(() => ({ select: () => ({ lean: async () => null }) })),
  },
  POST_CLASSIFICATION_PENDING: 'pending',
}));

vi.mock('../../models/Lane', () => ({
  Lane: { exists: vi.fn(async () => null), findById: vi.fn(() => ({ select: () => ({ lean: async () => null }) })) },
}));

const postCreationCreate = vi.fn();
vi.mock('../../services/PostCreationService', () => ({
  postCreationService: { create: (...args: unknown[]) => postCreationCreate(...args) },
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async () => []) },
  resolveUserSummaries: vi.fn(async () => new Map()),
  degradedActorSummary: vi.fn(() => ({ id: 'unknown', username: '' })),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(() => ({})),
  createUserScopedOxyServices: vi.fn(() => undefined),
  getServiceOxyClient: vi.fn(() => ({})),
}));

vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));

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

import { createThread, updatePostSettings } from '../../controllers/posts.controller';
import type { OxyAuthRequest } from '@oxyhq/core/server';

const USER_ID = 'author-1';
const POST_ID = '507f1f77bcf86cd799439011';
const CHANNEL_ACCOUNT = 'oxy-channel-account';

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

/** A saveable post document as `updatePostSettings` reads it. */
function postDoc(extra: Record<string, unknown> = {}) {
  return {
    _id: POST_ID,
    oxyUserId: USER_ID,
    metadata: {},
    replyPermission: ['nobody'],
    markModified: vi.fn(),
    save: vi.fn(async () => undefined),
    ...extra,
  };
}

beforeEach(() => {
  postFindOne.mockReset();
  isChannelAccount.mockReset();
  isChannelAccount.mockImplementation(async (id: string) => id === CHANNEL_ACCOUNT);
  postCreationCreate.mockReset();
  postCreationCreate.mockResolvedValue({
    _id: new mongoose.Types.ObjectId(),
    content: { text: 'x' },
    toObject: () => ({ _id: 'p1', content: { text: 'x' } }),
  });
});

describe('PATCH /posts/:id/settings — replyPermission on a channel post', () => {
  function req(body: Record<string, unknown>): OxyAuthRequest {
    return { user: { id: USER_ID }, params: { id: POST_ID }, body } as unknown as OxyAuthRequest;
  }

  it('400s a replyPermission change on a channel post', async () => {
    const doc = postDoc({ oxyUserId: CHANNEL_ACCOUNT });
    postFindOne.mockResolvedValue(doc);

    const res = makeRes();
    await updatePostSettings(req({ replyPermission: ['anyone'] }), res as never);

    expect(res.statusCode).toBe(400);
    expect(doc.save).not.toHaveBeenCalled();
    expect(doc.replyPermission).toEqual(['nobody']);
  });

  it('CONTROL: still accepts a replyPermission change on an ordinary post', async () => {
    const doc = postDoc({ replyPermission: ['anyone'] });
    postFindOne.mockResolvedValue(doc);

    const res = makeRes();
    await updatePostSettings(req({ replyPermission: ['followers'] }), res as never);

    expect(res.statusCode).toBe(200);
    expect(doc.replyPermission).toEqual(['followers']);
  });

  it('CONTROL: still accepts a replyPermission change on a post with a laneId', async () => {
    const doc = postDoc({ replyPermission: ['anyone'], laneId: 'lane_1' });
    postFindOne.mockResolvedValue(doc);

    const res = makeRes();
    await updatePostSettings(req({ replyPermission: ['mentioned'] }), res as never);

    expect(res.statusCode).toBe(200);
    expect(doc.replyPermission).toEqual(['mentioned']);
  });

  it('CONTROL: a channel post can still be PINNED — only replies are refused', async () => {
    const doc = postDoc({ oxyUserId: CHANNEL_ACCOUNT });
    postFindOne.mockResolvedValue(doc);

    const res = makeRes();
    await updatePostSettings(req({ isPinned: true }), res as never);

    expect(res.statusCode).toBe(200);
    expect(doc.save).toHaveBeenCalled();
  });
});

describe('POST /posts/thread — a thread cannot be published as another account', () => {
  function req(body: Record<string, unknown>): OxyAuthRequest {
    return { user: { id: USER_ID }, body } as unknown as OxyAuthRequest;
  }

  it('400s a top-level publishAsOxyUserId before writing anything', async () => {
    const res = makeRes();
    await createThread(
      req({ mode: 'thread', publishAsOxyUserId: CHANNEL_ACCOUNT, posts: [{ content: { text: 'a' } }] }),
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(postCreationCreate).not.toHaveBeenCalled();
  });

  it('400s a per-entry publishAsOxyUserId too', async () => {
    const res = makeRes();
    await createThread(
      req({
        mode: 'beast',
        posts: [
          { content: { text: 'a' } },
          { content: { text: 'b' }, publishAsOxyUserId: CHANNEL_ACCOUNT },
        ],
      }),
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(postCreationCreate).not.toHaveBeenCalled();
  });

  it('CONTROL: an ordinary thread is still created', async () => {
    const res = makeRes();
    await createThread(
      req({ mode: 'thread', posts: [{ content: { text: 'a' } }] }),
      res as never,
    );

    expect(res.statusCode).not.toBe(400);
    expect(postCreationCreate).toHaveBeenCalled();
  });
});
