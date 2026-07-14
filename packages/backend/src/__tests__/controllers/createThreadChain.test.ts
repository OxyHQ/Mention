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
 * `createThread` routes every post through `PostCreationService.create` (so
 * classification + the MTN dual-write live in one place). The linkage params
 * (`parentPostId`, `threadId`) are computed in the controller and PASSED to the
 * creator, then the root post is anchored on its own id with a follow-up
 * `post.threadId = post._id` + save. We stub the creator with a real Post
 * constructor so the assigned `_id` and passed-through linkage are observable,
 * and stub the DB-touching `save()` so no DB/network is needed.
 */
vi.mock('../../../server', () => ({
  oxy: {},
  io: { of: () => ({ emit: vi.fn() }) },
  notificationsNamespace: { emit: vi.fn() },
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

// Route the creator through a real Post constructor so the linkage params the
// controller passes (`parentPostId`/`threadId`) land on a document with a real
// `_id`. `save()` is a no-op (no DB). The MTN emission is suppressed by the
// controller's `skipNotifications/skipSocketEmit/skipFederationDelivery` and is
// best-effort anyway, so it never touches this test path.
vi.mock('../../services/PostCreationService', () => ({
  postCreationService: {
    create: vi.fn(async (params: Record<string, unknown>) => {
      const post = new Post({
        oxyUserId: params.oxyUserId,
        content: params.content,
        hashtags: params.hashtags,
        mentions: params.mentions,
        visibility: params.visibility,
        ...(params.parentPostId ? { parentPostId: params.parentPostId } : {}),
        ...(params.threadId ? { threadId: params.threadId } : {}),
      });
      return post;
    }),
  },
}));

import { createThread } from '../../controllers/posts.controller';

type ThreadPostDoc = {
  _id: unknown;
  parentPostId?: string;
  threadId?: string;
};

/**
 * The request the controller actually receives from Express. `query` +
 * `acceptsLanguages` are what the language ladder reads to pick which localized
 * rendition of the created posts to hydrate (`requestLanguageCandidates`); this
 * reader declares none, so hydration serves each post's primary language.
 */
function buildRequest(body: Record<string, unknown>) {
  return {
    user: { id: 'author_1' },
    query: {},
    acceptsLanguages: () => [] as string[],
    headers: {},
    body,
  };
}

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
    const req = buildRequest({
      mode: 'thread',
      posts: [
        { content: { text: 'Root post' } },
        { content: { text: 'Continuation 1' } },
        { content: { text: 'Continuation 2' } },
      ],
    });

    const { res, payload } = buildResponse();
    await createThread(req as never, res as never);

    expect(payload.status).toBe(201);
    const posts = payload.value?.posts ?? [];
    expect(posts).toHaveLength(3);

    const [post0, post1, post2] = posts;
    const id0 = String(post0._id);
    const id1 = String(post1._id);

    // Root post: no parent, but it ANCHORS the thread on its own id so the whole
    // self-thread (root included) shares one threadId — this is what lets
    // ThreadSlicingService recognise the root and connect the slice.
    expect(post0.parentPostId).toBeUndefined();
    expect(post0.threadId).toBe(id0);

    // Post 1 chains onto post 0; thread root is post 0.
    expect(post1.parentPostId).toBe(id0);
    expect(post1.threadId).toBe(id0);

    // Post 2 chains onto post 1 (NOT post 0 — the fan-out bug); thread root stays post 0.
    expect(post2.parentPostId).toBe(id1);
    expect(post2.threadId).toBe(id0);
  });

  it('leaves a single-post thread-mode call unlinked (no threadId on the lone root)', async () => {
    const req = buildRequest({
      mode: 'thread',
      posts: [{ content: { text: 'Solo post' } }],
    });

    const { res, payload } = buildResponse();
    await createThread(req as never, res as never);

    expect(payload.status).toBe(201);
    const posts = payload.value?.posts ?? [];
    expect(posts).toHaveLength(1);

    // A 1-post "thread" has no continuations to connect, so the root is NOT anchored.
    expect(posts[0].parentPostId).toBeUndefined();
    expect(posts[0].threadId).toBeUndefined();
  });

  it('does not link beast-mode posts (each post is independent)', async () => {
    const req = buildRequest({
      mode: 'beast',
      posts: [
        { content: { text: 'Independent 1' } },
        { content: { text: 'Independent 2' } },
      ],
    });

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
