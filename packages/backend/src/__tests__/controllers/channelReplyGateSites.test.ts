import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
 *  - `POST /posts` performs NO parent lookup of its own — it validates
 *    `quoted_post_id` and `boost_of` and nothing else — so its gate had to be
 *    added from scratch, and the assertion is that it exists at all.
 *
 * Every refusal is paired with a control: an ordinary parent, and a parent
 * carrying a `laneId`, still accept replies. A lane is a lens, not a destination.
 *
 * The gate keys on the parent AUTHOR's Oxy account kind, so `isChannelAccount` is
 * the seam these tests drive — mocked at `services/publishAsAccount`, the one
 * module that knows what a channel account is. Everything ELSE is a real row: the
 * gate resolves the author by reading `posts` with a `text` id, and the guard it
 * replaced (`ObjectId.isValid`) answered `false` for every uuid v7 — which reads
 * as "not a channel post" and lets the reply through. A mocked `findById` cannot
 * see that, because the id never reaches the predicate that was wrong.
 */

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearPostScope, postScope, seedLane, seedPost } from '../helpers/postFixtures';

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
  cacheAccountMemberReads: (reader: unknown) => reader,
  assertCanPublishAsAccount: vi.fn(
    async (params: { callerId: string | null }) => ({
      authorId: params.callerId,
      authorKind: null,
    }),
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
import { createPost } from '../../controllers/posts/createPost';
import type { OxyAuthRequest } from '@oxyhq/core/server';
import type { ReplyPermission } from '@mention/shared-types';

const scope = postScope('channel-reply-gate-sites');
const USER_ID = scope.user('author');
/** The Oxy account the mocked `isChannelAccount` answers `true` for. */
const CHANNEL_ACCOUNT = scope.user('channel');

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

/**
 * One parent post, owned by `USER_ID` unless a channel is named.
 *
 * The channel IS the author now, so "a channel post" is a row whose
 * `oxy_user_id` is the channel account — there is no marker on the row to set.
 */
async function parent(
  extra: { oxyUserId?: string; laneId?: string; replyPermission?: ReplyPermission[] } = {},
): Promise<string> {
  const post = await seedPost(scope, {
    oxyUserId: extra.oxyUserId ?? USER_ID,
    replyPermission: extra.replyPermission ?? ['anyone'],
    ...(extra.laneId ? { laneId: extra.laneId } : {}),
  });
  return post.id;
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  isChannelAccount.mockReset();
  isChannelAccount.mockImplementation(async (id: string) => id === CHANNEL_ACCOUNT);
  postCreationCreate.mockReset();
  postCreationCreate.mockResolvedValue({
    id: 'p1',
    content: { text: 'x' },
    toObject: () => ({ id: 'p1', content: { text: 'x' } }),
  });
});

afterEach(async () => {
  await clearPostScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('site 1 — feed.controller.createReply', () => {
  function replyReq(postId: string, callerId: string = USER_ID): OxyAuthRequest {
    return {
      user: { id: callerId },
      body: { postId, content: 'a reply' },
    } as unknown as OxyAuthRequest;
  }

  it('refuses even when the caller would clear the author escape', async () => {
    // The permission block contains an unconditional escape — `parentAuthorId ===
    // currentUserId` allows the reply even under `['nobody']` — so the gate has to
    // sit above the block, not inside it.
    //
    // The only fixture that ISOLATES that escape is a caller whose id IS the
    // author's, which for a channel post means asking as the channel. No real
    // session can be one (`isActAsEligibleKind` refuses `channel`), so this shape
    // is synthetic on purpose: without it the case is answered by the `['nobody']`
    // permission itself and cannot tell the gate from the block. Mutation-tested —
    // stubbing `isChannelAccount` to `false` turns it red.
    const parentId = await parent({
      oxyUserId: CHANNEL_ACCOUNT,
      replyPermission: ['nobody'],
    });

    const res = makeRes();
    await feedController.createReply(replyReq(parentId, CHANNEL_ACCOUNT), res as never);

    expect(res.statusCode).toBe(403);
  });

  it('refuses even when the parent says replyPermission: ["anyone"]', async () => {
    // The discriminating case. The permission block is SKIPPED for `['anyone']`,
    // so a gate placed inside it would never run — this one passes only if the
    // gate sits above the whole block, escape included.
    const parentId = await parent({
      oxyUserId: CHANNEL_ACCOUNT,
      replyPermission: ['anyone'],
    });

    const res = makeRes();
    await feedController.createReply(replyReq(parentId), res as never);

    expect(res.statusCode).toBe(403);
  });

  it('CONTROL: an ordinary post still accepts a reply', async () => {
    const parentId = await parent({ replyPermission: ['anyone'] });
    const res = makeRes();
    await feedController.createReply(replyReq(parentId), res as never);
    expect(res.statusCode).not.toBe(403);
  });

  it('CONTROL: a post carrying a laneId still accepts a reply', async () => {
    const laneId = await seedLane(scope, { ownerId: USER_ID });
    const parentId = await parent({ laneId, replyPermission: ['anyone'] });
    const res = makeRes();
    await feedController.createReply(replyReq(parentId), res as never);
    expect(res.statusCode).not.toBe(403);
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
    const parentId = await parent({ oxyUserId: CHANNEL_ACCOUNT });

    const res = makeRes();
    await createPost(postReq({ parentPostId: parentId }), res as never);

    expect(res.statusCode).toBe(403);
    expect(postCreationCreate).not.toHaveBeenCalled();
  });

  it('refuses through the in_reply_to_status_id alias too', async () => {
    // The controller accepts BOTH spellings and hands whichever it got to
    // `PostCreationService` as `parentPostId`; a gate reading only one of them
    // would leave the other as the back door.
    const parentId = await parent({ oxyUserId: CHANNEL_ACCOUNT });

    const res = makeRes();
    await createPost(postReq({ in_reply_to_status_id: parentId }), res as never);

    expect(res.statusCode).toBe(403);
    expect(postCreationCreate).not.toHaveBeenCalled();
  });

  it('CONTROL: an ordinary parent still accepts a reply', async () => {
    const parentId = await parent();
    const res = makeRes();
    await createPost(postReq({ parentPostId: parentId }), res as never);
    expect(res.statusCode).not.toBe(403);
    expect(postCreationCreate).toHaveBeenCalled();
  });

  it('CONTROL: a parent carrying a laneId still accepts a reply', async () => {
    const laneId = await seedLane(scope, { ownerId: USER_ID });
    const parentId = await parent({ laneId });
    const res = makeRes();
    await createPost(postReq({ parentPostId: parentId }), res as never);
    expect(res.statusCode).not.toBe(403);
    expect(postCreationCreate).toHaveBeenCalled();
  });

  it('CONTROL: a top-level post is created with no parent gate to clear', async () => {
    const res = makeRes();
    await createPost(postReq({}), res as never);
    expect(res.statusCode).not.toBe(403);
    expect(postCreationCreate).toHaveBeenCalled();
    expect(isChannelAccount).not.toHaveBeenCalled();
  });
});
