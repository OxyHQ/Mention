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
 * Parents are REAL ROWS. `parentIsChannelPost` reads `posts.channel_id` with a
 * `text` id, and the guard it replaced (`ObjectId.isValid`) answered `false` for
 * every uuid v7 — which reads as "not a channel post" and lets the reply through.
 * A mocked `findById` cannot see that: it answers whatever it was told, without
 * the id ever reaching the predicate that was wrong.
 */

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearPostScope, postScope, seedChannel, seedLane, seedPost } from '../helpers/postFixtures';

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
  getServiceOxyClient: vi.fn(() => ({})),
}));

vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));
vi.mock('../../runtime/oxyClient', () => ({ getRuntimeOxyClient: () => ({}) }));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { feedController } from '../../controllers/feed.controller';
import { createPost } from '../../controllers/posts.controller';
import type { OxyAuthRequest } from '@oxyhq/core/server';
import type { ReplyPermission } from '@mention/shared-types';

const scope = postScope('channel-reply-gate-sites');
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

/**
 * One parent post owned by `USER_ID` — the author-replying-to-themselves case
 * the gate has to sit above.
 */
async function parent(
  extra: { channelId?: string; laneId?: string; replyPermission?: ReplyPermission[] } = {},
): Promise<string> {
  const post = await seedPost(scope, {
    oxyUserId: USER_ID,
    replyPermission: extra.replyPermission ?? ['anyone'],
    ...(extra.channelId ? { channelId: extra.channelId } : {}),
    ...(extra.laneId ? { laneId: extra.laneId } : {}),
  });
  return post.id;
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

describe('site 1 — feed.controller.createReply', () => {
  function replyReq(postId: string): OxyAuthRequest {
    return {
      user: { id: USER_ID },
      body: { postId, content: 'a reply' },
    } as unknown as OxyAuthRequest;
  }

  it('refuses a reply to a channel post with 403, even for the post\'s OWN author', async () => {
    // The author-replying-to-themselves escape inside the reply-permission block
    // is exactly what this gate has to sit above: the parent is owned by the
    // caller, and its stored permission is the one that triggers that escape.
    const channelId = await seedChannel(scope);
    const parentId = await parent({ channelId, replyPermission: ['nobody'] });

    const res = makeRes();
    await feedController.createReply(replyReq(parentId), res as never);

    expect(res.statusCode).toBe(403);
  });

  it('refuses even when the parent says replyPermission: ["anyone"]', async () => {
    // The permission block is SKIPPED for `['anyone']`, so a gate placed inside it
    // would never run on an ordinary post. This asserts it is placed above.
    const channelId = await seedChannel(scope);
    const parentId = await parent({ channelId, replyPermission: ['anyone'] });

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
    const channelId = await seedChannel(scope);
    const parentId = await parent({ channelId });

    const res = makeRes();
    await createPost(postReq({ parentPostId: parentId }), res as never);

    expect(res.statusCode).toBe(403);
    expect(postCreationCreate).not.toHaveBeenCalled();
  });

  it('refuses through the in_reply_to_status_id alias too', async () => {
    // The controller accepts BOTH spellings and hands whichever it got to
    // `PostCreationService` as `parentPostId`; a gate reading only one of them
    // would leave the other as the back door.
    const channelId = await seedChannel(scope);
    const parentId = await parent({ channelId });

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
  });
});
