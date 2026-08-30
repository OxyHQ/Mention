import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two SETTINGS-shaped guards a channel post needs, both of which exist so the
 * server never has to rely on `replyPermission` for anything.
 *
 *  - `PATCH /posts/:id/settings` refuses to change `replyPermission` on a channel
 *    post. The 403 on the reply paths reads the AUTHOR's account kind and would
 *    hold regardless — but a change here would UN-HIDE the client's reply button
 *    and leave every reader hitting a refusal they were invited to attempt.
 *  - `POST /posts/thread` takes `publishAsOxyUserId` per ENTRY in both modes, and
 *    additionally at the BATCH level in thread mode, where it is the default for
 *    entries naming none. A batch-level field in beast mode is a 400 — there is
 *    no thread there to speak for. Which COMBINATIONS are allowed (a channel's
 *    thread must speak with one voice) is `threadPublishAsAccount.test.ts`.
 *
 * The settings cases read the STORED row afterwards rather than a mock document's
 * mutated field: the guard's whole job is that nothing is written, and "save was
 * not called" is a weaker claim than "the row did not change".
 */

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearPostScope, postScope, readPostRow, seedLane, seedPost } from '../helpers/postFixtures';

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

import { createThread } from '../../controllers/posts/createThread';
import { updatePostSettings } from '../../controllers/posts/postSettings';
import type { OxyAuthRequest } from '@oxyhq/core/server';

const scope = postScope('channel-post-settings');
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

describe('PATCH /posts/:id/settings — replyPermission on a channel post', () => {
  /**
   * The caller is the post's own author, because the handler scopes the row by
   * `oxy_user_id` and answers 404 otherwise. For a channel post the author IS the
   * channel, so reaching this guard at all means asking as the channel.
   */
  function req(callerId: string, postId: string, body: Record<string, unknown>): OxyAuthRequest {
    return { user: { id: callerId }, params: { id: postId }, body } as unknown as OxyAuthRequest;
  }

  it('400s a replyPermission change on a channel post', async () => {
    const post = await seedPost(scope, {
      oxyUserId: CHANNEL_ACCOUNT,
      replyPermission: ['nobody'],
    });

    const res = makeRes();
    await updatePostSettings(
      req(CHANNEL_ACCOUNT, post.id, { replyPermission: ['anyone'] }),
      res as never,
    );

    expect(res.statusCode).toBe(400);
    // The STORED value, not a mock's field: what makes the guard worth having is
    // that the client keeps reading `['nobody']` and keeps hiding the button.
    expect((await readPostRow(post.id))?.replyPermission).toEqual(['nobody']);
  });

  it('CONTROL: still accepts a replyPermission change on an ordinary post', async () => {
    const post = await seedPost(scope, { oxyUserId: USER_ID, replyPermission: ['anyone'] });

    const res = makeRes();
    await updatePostSettings(req(USER_ID, post.id, { replyPermission: ['followers'] }), res as never);

    expect(res.statusCode).toBe(200);
    expect((await readPostRow(post.id))?.replyPermission).toEqual(['followers']);
  });

  it('CONTROL: still accepts a replyPermission change on a post with a laneId', async () => {
    // A lane is a lens, not a publisher — it must not attract the channel rule.
    const laneId = await seedLane(scope, { ownerId: USER_ID });
    const post = await seedPost(scope, {
      oxyUserId: USER_ID,
      laneId,
      replyPermission: ['anyone'],
    });

    const res = makeRes();
    await updatePostSettings(req(USER_ID, post.id, { replyPermission: ['mentioned'] }), res as never);

    expect(res.statusCode).toBe(200);
    expect((await readPostRow(post.id))?.replyPermission).toEqual(['mentioned']);
  });

  it('CONTROL: a channel post can still be PINNED — only replies are refused', async () => {
    const post = await seedPost(scope, { oxyUserId: CHANNEL_ACCOUNT });

    const res = makeRes();
    await updatePostSettings(req(CHANNEL_ACCOUNT, post.id, { isPinned: true }), res as never);

    expect(res.statusCode).toBe(200);
    expect((await readPostRow(post.id))?.metadataIsPinned).toBe(true);
  });
});

describe('POST /posts/thread — one placement per mode, and only one', () => {
  function req(body: Record<string, unknown>): OxyAuthRequest {
    return { user: { id: USER_ID }, body } as unknown as OxyAuthRequest;
  }

  it('400s a batch-level publishAsOxyUserId in BEAST mode — the per-entry field is the only way to say it', async () => {
    const res = makeRes();
    await createThread(
      req({ mode: 'beast', publishAsOxyUserId: CHANNEL_ACCOUNT, posts: [{ content: { text: 'a' } }] }),
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(postCreationCreate).not.toHaveBeenCalled();
  });

  it('ACCEPTS a per-entry publishAsOxyUserId in thread mode — entries may name their own account', async () => {
    // The gate is stubbed in this suite (it answers "the caller" for everything),
    // so what this pins is that the route no longer refuses the SHAPE. Which
    // combinations of accounts are allowed — and the channel single-voice rule
    // that refuses most of them — is `threadPublishAsAccount.test.ts`, where the
    // real gate runs.
    const res = makeRes();
    await createThread(
      req({
        mode: 'thread',
        posts: [
          { content: { text: 'a' } },
          { content: { text: 'b' }, publishAsOxyUserId: CHANNEL_ACCOUNT },
        ],
      }),
      res as never,
    );

    expect(res.statusCode).not.toBe(400);
    expect(postCreationCreate).toHaveBeenCalled();
  });

  it('CONTROL: an ordinary thread is still created', async () => {
    const res = makeRes();
    await createThread(req({ mode: 'thread', posts: [{ content: { text: 'a' } }] }), res as never);

    expect(res.statusCode).not.toBe(400);
    expect(postCreationCreate).toHaveBeenCalled();
  });
});
