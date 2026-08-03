import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { OxyAuthRequest } from '@oxyhq/core/server';

/**
 * `POST /posts` STILL cannot reply to a channel post — as anybody, including as
 * the channel itself.
 *
 * This is the door the thread-continuation exception must never open, and it is
 * held shut by TWO independent things. Both are asserted here, because "the other
 * one covers it" is how both end up gone:
 *
 *  1. `assertParentAcceptsReplies` runs in this controller BEFORE
 *     `PostCreationService` is reached, and it reads the PARENT's account kind
 *     without caring who the reply's author would be — so it refuses a channel
 *     parent whatever `publishAsOxyUserId` says.
 *  2. The controller builds its `create` params from an explicit whitelist that
 *     does not name `continuesOwnThread`, so a request cannot ask for the
 *     exception at all. That is what makes the exception's own check
 *     (`utils/threadContinuation`) unreachable from a public reply route rather
 *     than merely hard to satisfy.
 *
 * Together they are why "a channel's operators may reply as the channel" is not
 * reachable: an operator would need the parent gate to let them past AND the
 * service parameter to be settable from a body, and neither is true.
 */

const findById = vi.hoisted(() => vi.fn());
const create = vi.hoisted(() => vi.fn());
const isChannelAccount = vi.hoisted(() => vi.fn());

vi.mock('../../models/Post', () => ({
  Post: {
    findById,
    findOne: vi.fn(),
    find: vi.fn(() => ({ select: () => ({ lean: async () => [] }) })),
  },
  POST_CLASSIFICATION_PENDING: 'pending',
}));

vi.mock('../../models/Lane', () => ({
  Lane: {
    exists: vi.fn(async () => null),
    findById: vi.fn(() => ({ select: () => ({ lean: async () => null }) })),
  },
}));

vi.mock('../../services/PostCreationService', () => ({
  postCreationService: { create },
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async () => []) },
  resolveUserSummaries: vi.fn(async () => new Map()),
  degradedActorSummary: vi.fn(() => ({ id: 'unknown', username: '' })),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(() => ({})),
  createUserScopedOxyServices: vi.fn(() => ({ listAccountMembers: vi.fn(async () => []) })),
  getServiceOxyClient: vi.fn(() => ({})),
}));

vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The REAL channel reply gate, over a mocked account-kind lookup — the point of
// this suite is that the gate runs on this route, so stubbing it would assert
// nothing.
vi.mock('../../services/publishAsAccount', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isChannelAccount,
}));

import { createPost } from '../../controllers/posts.controller';

const OPERATOR = 'human-1';
const CHANNEL = 'channel-account-1';
const CHANNEL_POST = new mongoose.Types.ObjectId().toString();

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

function req(body: Record<string, unknown>): OxyAuthRequest {
  return {
    user: { id: OPERATOR },
    query: {},
    headers: {},
    acceptsLanguages: () => [],
    body,
  } as unknown as OxyAuthRequest;
}

beforeEach(() => {
  create.mockReset();
  isChannelAccount.mockReset();
  isChannelAccount.mockImplementation(async (id: string) => id === CHANNEL);
  findById.mockReset();
  // The parent lookup `assertParentAcceptsReplies` makes.
  findById.mockImplementation(() => ({
    select: () => ({ lean: async () => ({ _id: CHANNEL_POST, oxyUserId: CHANNEL }) }),
    maxTimeMS: () => ({ lean: async () => ({ _id: CHANNEL_POST, oxyUserId: CHANNEL }) }),
  }));
});

describe('POST /posts — a channel post takes no replies', () => {
  it('403s a plain reply to a channel post', async () => {
    const res = makeRes();
    await createPost(req({ content: { text: 'hi' }, parentPostId: CHANNEL_POST }), res as never);

    expect(res.statusCode).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  /**
   * THE ONE THIS SUITE EXISTS FOR. An operator naming the channel is the exact
   * shape "a continuation of the account's own thread" would take if the
   * exception were expressed as a rule about authors instead of a verified
   * structural property. Removing `assertParentAcceptsReplies` from this
   * controller makes this the only test that fails.
   */
  it('403s a reply published AS the channel — an operator is not an exception', async () => {
    const res = makeRes();
    await createPost(
      req({
        content: { text: 'part two, from outside the composer' },
        parentPostId: CHANNEL_POST,
        publishAsOxyUserId: CHANNEL,
      }),
      res as never,
    );

    expect(res.statusCode).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it('403s it through in_reply_to_status_id too — the other spelling of the same thing', async () => {
    const res = makeRes();
    await createPost(
      req({
        content: { text: 'x' },
        in_reply_to_status_id: CHANNEL_POST,
        publishAsOxyUserId: CHANNEL,
      }),
      res as never,
    );

    expect(res.statusCode).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  /**
   * The second lock. Even past the parent gate, a request cannot ASK for the
   * continuation exception — the controller's params are a whitelist and
   * `continuesOwnThread` is not on it. Asserted on a NON-channel parent so the
   * first lock is out of the way and this one is what is being measured.
   */
  it('never forwards continuesOwnThread from a request body', async () => {
    isChannelAccount.mockResolvedValue(false);
    create.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
      oxyUserId: OPERATOR,
      content: { text: 'x' },
      toObject: () => ({ content: { text: 'x' } }),
    });

    const res = makeRes();
    await createPost(
      req({
        content: { text: 'x' },
        parentPostId: CHANNEL_POST,
        continuesOwnThread: true,
        threadId: CHANNEL_POST,
      }),
      res as never,
    );

    expect(create).toHaveBeenCalled();
    const [params] = create.mock.calls[0] as [Record<string, unknown>];
    expect(params.continuesOwnThread).toBeUndefined();
  });
});
