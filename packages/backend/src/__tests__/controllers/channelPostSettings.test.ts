import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two SETTINGS-shaped guards a channel post needs, both of which exist so the
 * server never has to rely on `replyPermission` for anything.
 *
 *  - `PATCH /posts/:id/settings` refuses to change `replyPermission` on a channel
 *    post. The 403 on the reply paths reads `channel_id` and would hold regardless
 *    — but a change here would UN-HIDE the client's reply button and leave every
 *    reader hitting a refusal they were invited to attempt.
 *  - `POST /posts/thread` refuses a `channelId` outright: in thread mode the
 *    continuations are replies, and a channel post accepts none, so the thread
 *    would be a root in the channel with its body scattered across posts the
 *    channel refuses.
 *
 * The settings cases read the STORED row afterwards rather than a mock document's
 * mutated field: the guard's whole job is that nothing is written, and "save was
 * not called" is a weaker claim than "the row did not change".
 */

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearPostScope, postScope, readPostRow, seedChannel, seedLane, seedPost } from '../helpers/postFixtures';

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
  getServiceOxyClient: vi.fn(() => ({})),
}));

vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createThread, updatePostSettings } from '../../controllers/posts.controller';
import type { OxyAuthRequest } from '@oxyhq/core/server';

const scope = postScope('channel-post-settings');
const USER_ID = scope.user('author');

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
  function req(postId: string, body: Record<string, unknown>): OxyAuthRequest {
    return { user: { id: USER_ID }, params: { id: postId }, body } as unknown as OxyAuthRequest;
  }

  it('400s a replyPermission change on a channel post', async () => {
    const channelId = await seedChannel(scope);
    const post = await seedPost(scope, {
      oxyUserId: USER_ID,
      channelId,
      replyPermission: ['nobody'],
    });

    const res = makeRes();
    await updatePostSettings(req(post.id, { replyPermission: ['anyone'] }), res as never);

    expect(res.statusCode).toBe(400);
    // The STORED value, not a mock's field: what makes the guard worth having is
    // that the client keeps reading `['nobody']` and keeps hiding the button.
    expect((await readPostRow(post.id))?.replyPermission).toEqual(['nobody']);
  });

  it('CONTROL: still accepts a replyPermission change on an ordinary post', async () => {
    const post = await seedPost(scope, { oxyUserId: USER_ID, replyPermission: ['anyone'] });

    const res = makeRes();
    await updatePostSettings(req(post.id, { replyPermission: ['followers'] }), res as never);

    expect(res.statusCode).toBe(200);
    expect((await readPostRow(post.id))?.replyPermission).toEqual(['followers']);
  });

  it('CONTROL: still accepts a replyPermission change on a post with a laneId', async () => {
    // A lane is a lens, not a destination — it must not attract the channel rule.
    const laneId = await seedLane(scope, { ownerId: USER_ID });
    const post = await seedPost(scope, {
      oxyUserId: USER_ID,
      laneId,
      replyPermission: ['anyone'],
    });

    const res = makeRes();
    await updatePostSettings(req(post.id, { replyPermission: ['mentioned'] }), res as never);

    expect(res.statusCode).toBe(200);
    expect((await readPostRow(post.id))?.replyPermission).toEqual(['mentioned']);
  });

  it('CONTROL: a channel post can still be PINNED — only replies are refused', async () => {
    const channelId = await seedChannel(scope);
    const post = await seedPost(scope, { oxyUserId: USER_ID, channelId });

    const res = makeRes();
    await updatePostSettings(req(post.id, { isPinned: true }), res as never);

    expect(res.statusCode).toBe(200);
    expect((await readPostRow(post.id))?.metadataIsPinned).toBe(true);
  });
});

describe('POST /posts/thread — a thread cannot be published to a channel', () => {
  function req(body: Record<string, unknown>): OxyAuthRequest {
    return { user: { id: USER_ID }, body } as unknown as OxyAuthRequest;
  }

  it('400s a top-level channelId before writing anything', async () => {
    const channelId = await seedChannel(scope);
    const res = makeRes();
    await createThread(
      req({ mode: 'thread', channelId, posts: [{ content: { text: 'a' } }] }),
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(postCreationCreate).not.toHaveBeenCalled();
  });

  it('400s a per-entry channelId too', async () => {
    const channelId = await seedChannel(scope);
    const res = makeRes();
    await createThread(
      req({
        mode: 'beast',
        posts: [{ content: { text: 'a' } }, { content: { text: 'b' }, channelId }],
      }),
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(postCreationCreate).not.toHaveBeenCalled();
  });

  it('CONTROL: an ordinary thread is still created', async () => {
    const res = makeRes();
    await createThread(req({ mode: 'thread', posts: [{ content: { text: 'a' } }] }), res as never);

    expect(res.statusCode).not.toBe(400);
    expect(postCreationCreate).toHaveBeenCalled();
  });
});
