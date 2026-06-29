import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit coverage for {@link createThread}'s sequential-chain linkage.
 *
 * A multi-post thread must be linked as a CHAIN (post2 → post1 → post0), not a
 * flat FAN where every continuation replies to the first post. Each continuation
 * post's `parentPostId` must point at the IMMEDIATELY-previous post, while every
 * post shares a single `threadId` equal to the FIRST (root) post's id. This is
 * what makes a self-authored thread render sequentially and gives federation /
 * notifications the correct `inReplyTo`.
 *
 * The controller pulls in the server bootstrap and the post-hydration / Oxy
 * client layers; stub those so the test stays pure and never touches a DB or the
 * network. The real Post model is used (it assigns `_id` at construction); only
 * the DB-touching `save()` is stubbed.
 */
vi.mock('../../../server', () => ({
  oxy: {},
  io: { of: () => ({ emit: vi.fn() }) },
  notificationsNamespace: { emit: vi.fn() },
  roomsNamespace: { emit: vi.fn() },
}));

vi.mock('../../services/PostHydrationService', () => ({
  // Passthrough hydration — the linkage we assert on lives on the raw documents
  // the controller pushes in (`post.toObject()`), so return them unchanged.
  postHydrationService: { hydratePosts: vi.fn(async (objs: object[]) => objs) },
  resolveUserSummaries: vi.fn(async () => new Map()),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(() => ({})),
}));

import { Post } from '../../models/Post';
import { createThread } from '../../controllers/posts.controller';

type ThreadPostDoc = {
  _id: unknown;
  parentPostId?: string;
  threadId?: string;
};

function buildResponse() {
  const payload: { value?: { posts: ThreadPostDoc[] }; status?: number } = {};
  const res = {
    status(code: number) {
      payload.status = code;
      return this;
    },
    json(body: { posts: ThreadPostDoc[] }) {
      payload.value = body;
      return this;
    },
  };
  return { res, payload };
}

describe('createThread — sequential chain linkage', () => {
  beforeEach(() => {
    // The controller calls `post.save()` per post; stub it so no DB is required.
    // The real constructor still assigns `_id`, parentPostId and threadId.
    vi.spyOn(Post.prototype, 'save').mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('chains each continuation post to the immediately-previous post with a shared root threadId', async () => {
    const req = {
      user: { id: 'author_1' },
      body: {
        mode: 'thread',
        posts: [
          { content: { text: 'Root post' } },
          { content: { text: 'Continuation 1' } },
          { content: { text: 'Continuation 2' } },
        ],
      },
    };

    const { res, payload } = buildResponse();
    await createThread(req as never, res as never);

    expect(payload.status).toBe(201);
    const posts = payload.value?.posts ?? [];
    expect(posts).toHaveLength(3);

    const [post0, post1, post2] = posts;
    const id0 = String(post0._id);
    const id1 = String(post1._id);

    // Root post: no parent, no thread link.
    expect(post0.parentPostId).toBeUndefined();
    expect(post0.threadId).toBeUndefined();

    // Post 1 chains onto post 0; thread root is post 0.
    expect(post1.parentPostId).toBe(id0);
    expect(post1.threadId).toBe(id0);

    // Post 2 chains onto post 1 (NOT post 0 — the fan-out bug); thread root stays post 0.
    expect(post2.parentPostId).toBe(id1);
    expect(post2.threadId).toBe(id0);
  });

  it('does not link beast-mode posts (each post is independent)', async () => {
    const req = {
      user: { id: 'author_1' },
      body: {
        mode: 'beast',
        posts: [
          { content: { text: 'Independent 1' } },
          { content: { text: 'Independent 2' } },
        ],
      },
    };

    const { res, payload } = buildResponse();
    await createThread(req as never, res as never);

    expect(payload.status).toBe(201);
    const posts = payload.value?.posts ?? [];
    expect(posts).toHaveLength(2);
    for (const post of posts) {
      expect(post.parentPostId).toBeUndefined();
      expect(post.threadId).toBeUndefined();
    }
  });
});
