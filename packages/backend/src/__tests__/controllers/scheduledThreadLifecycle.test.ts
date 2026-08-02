import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the author can do to a scheduled THREAD between scheduling it and its
 * publish time — cancel it, and send it early.
 *
 * The chain is the unit for both. Acting on a single row instead produces states
 * nobody asked for: cancelling the root would leave its continuations behind,
 * unpublishable (the claim refuses a post whose parent has not published) and
 * unreadable by anyone, i.e. a silent black hole in the queue rather than a
 * cancellation; publishing one post early would either put a reply on screen
 * ahead of its parent or leave the thread stopping mid-sentence until its
 * original time came round.
 *
 * (Rescheduling is the third such action; it lives with the rest of the edit
 * rules in `updatePostScheduledWindow.test.ts`.)
 */

const hoisted = vi.hoisted(() => ({
  claim: vi.fn(),
  hydratePosts: vi.fn(),
  pollDeleteMany: vi.fn(),
}));

/**
 * The posts are REAL ROWS.
 *
 * The in-memory set this replaces honoured the filters by hand, which is the
 * shape that cannot distinguish a cascade correctly scoped to the caller and to
 * `status: 'scheduled'` from one whose predicate the test's own matcher happened
 * to reproduce. Both handlers here walk the chain through real queries — and the
 * chain walk is where the scoping lives.
 */
vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));

vi.mock('../../services/PostCreationService', () => ({
  postCreationService: { claimAndPublishScheduledPost: hoisted.claim },
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: hoisted.hydratePosts },
  resolveUserSummaries: vi.fn(async () => new Map()),
  degradedActorSummary: (id: string) => ({ id, username: '', name: { displayName: 'Unknown' } }),
}));

vi.mock('../../utils/oxyHelpers', () => ({ createScopedOxyClient: vi.fn(() => ({})) }));

vi.mock('../../services/PostRecentReplierService', () => ({
  repairRecentRepliersAfterPostDelete: vi.fn(async () => undefined),
}));

vi.mock('../../services/mtn/MentionRecordEmitter', () => ({
  emitPostCreated: vi.fn(),
  emitTombstone: vi.fn(async () => undefined),
  postRecordUri: () => 'at://test',
}));

vi.mock('../../connectors/outboundFederation', () => ({ federateAsResolvedActor: vi.fn() }));

// No `models/Article` mock: the article row is REAL, and cancelling the thread
// has to remove it through `articles.post_id`'s `ON DELETE CASCADE` rather than
// through a sweep. The stub that used to sit here was never asserted against —
// it existed only to keep the Mongoose model out of the way — so once the
// article write path moved to Postgres it proved nothing in either direction.

vi.mock('../../models/Poll', () => ({
  default: { deleteOne: () => ({ exec: async () => undefined }), deleteMany: hoisted.pollDeleteMany },
}));

vi.mock('../../models/Like', () => ({ default: { deleteMany: () => ({ exec: async () => undefined }) } }));
vi.mock('../../models/Bookmark', () => ({ default: { deleteMany: () => ({ exec: async () => undefined }) } }));
vi.mock('../../models/PostSubscription', () => ({ default: { deleteMany: () => ({ exec: async () => undefined }) } }));

vi.mock('mongoose', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    default: {
      ...(actual.default as Record<string, unknown>),
      model: () => ({ deleteMany: () => ({ exec: async () => undefined }) }),
      Types: (actual.default as { Types: unknown }).Types,
    },
  };
});

import { closePostgres, connectPostgres } from '../../db/postgres';
import { findArticleById, insertArticle, newArticleId } from '../../db/posts/articleRepository';
import { claimScheduledPost } from '../../db/posts/postRepository';
import { clearServiceScope, readScopePosts, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { deletePost, publishScheduledPostNow } from '../../controllers/posts.controller';

const scope = serviceScope('scheduled-thread-lifecycle');
const AUTHOR = scope.user('author');
const OTHER = scope.user('someone-else');

/** Label → the id the repository minted, and back, so assertions read as labels. */
let idByLabel: Map<string, string>;
let labelById: Map<string, string>;

/** A future instant, so a seeded scheduled post is never swept as due. */
function later(): Date {
  return new Date(Date.now() + 60 * 60 * 1000);
}

async function row(
  label: string,
  parent: string | null,
  options: { status?: 'scheduled' | 'published'; owner?: string } = {},
): Promise<void> {
  const status = options.status ?? 'scheduled';
  const record = await seedPost(scope, {
    oxyUserId: options.owner ?? AUTHOR,
    status,
    ...(status === 'scheduled' ? { scheduledFor: later() } : {}),
    ...(parent ? { parentPostId: idByLabel.get(parent) } : {}),
  });
  idByLabel.set(label, record.id);
  labelById.set(record.id, label);
}

/** A scheduled thread: root -> c1 -> c2. */
async function seedThread(): Promise<void> {
  await row('root', null);
  await row('c1', 'root');
  await row('c2', 'c1');
}

function buildRequest(id: string, userId: string | undefined = AUTHOR) {
  return {
    user: userId ? { id: userId } : undefined,
    params: { id },
    query: {},
    body: {},
    headers: {},
    acceptsLanguages: () => [] as string[],
  };
}

function buildResponse() {
  const payload: { status?: number; value?: Record<string, unknown> } = {};
  const res = {
    status(code: number) {
      payload.status = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      payload.value = body;
      return this;
    },
  };
  return { res, payload };
}

/** The labels of this suite's posts that still exist, in seeding order. */
async function remainingIds(): Promise<string[]> {
  const rows = await readScopePosts(scope);
  const alive = new Set(rows.map((r) => r.id));
  return [...idByLabel].filter(([, id]) => alive.has(id)).map(([label]) => label);
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  idByLabel = new Map();
  labelById = new Map();
  hoisted.pollDeleteMany.mockReturnValue({ exec: async () => undefined });
  hoisted.hydratePosts.mockImplementation(async (posts: unknown[]) => posts);
  // The claim is the real one's CONTRACT, not its body: flip a still-scheduled
  // post and answer `null` otherwise. Its own transaction is covered by
  // `claimAndPublishScheduledPost.test.ts`; here what matters is which ids the
  // chain walk drives it with, and in what order.
  hoisted.claim.mockImplementation(async ({ postId }: { postId: string }) => {
    const record = await claimScheduledPost(postId, undefined);
    return record ? { id: postId } : null;
  });
});

afterEach(async () => {
  await clearServiceScope(scope);
});

describe('cancelling a scheduled thread', () => {
  it('takes the continuations with the root', async () => {
    await seedThread();
    const { res, payload } = buildResponse();

    await deletePost(buildRequest(idByLabel.get('root') as string) as never, res as never);

    expect(payload.value?.message).toBe('Post deleted successfully');
    expect(await remainingIds()).toEqual([]);
  });

  it('cancels only what depends on the post, not what precedes it', async () => {
    await seedThread();
    const { res } = buildResponse();

    await deletePost(buildRequest(idByLabel.get('c1') as string) as never, res as never);

    // `root` published first and is nobody's continuation; `c2` replied to `c1`
    // and cannot exist without it.
    expect(await remainingIds()).toEqual(['root']);
  });

  /**
   * The long-form body goes with the post it belongs to.
   *
   * Nothing sweeps `articles` — `articles.post_id` carries `ON DELETE CASCADE`
   * to `posts.id` and `deletePostRecord` is what fires it. That makes this the
   * only thing standing between a cancelled draft and an article row nobody can
   * reach, so it is asserted rather than assumed: delete the `postId` anchor in
   * `insertArticle`, or the cascade in the schema, and this goes red.
   */
  it('takes the article body with a cancelled thread', async () => {
    await seedThread();
    const rootId = idByLabel.get('root') as string;
    const articleId = newArticleId();
    await insertArticle({
      id: articleId,
      postId: rootId,
      createdBy: AUTHOR,
      title: 'Draft title',
      body: 'Draft body',
    });
    expect(await findArticleById(articleId)).toBeDefined();

    const { res } = buildResponse();
    await deletePost(buildRequest(rootId) as never, res as never);

    expect(await remainingIds()).toEqual([]);
    expect(await findArticleById(articleId)).toBeUndefined();
  });

  it('leaves a lone scheduled post to delete exactly itself', async () => {
    await row('solo', null);
    const { res } = buildResponse();

    await deletePost(buildRequest(idByLabel.get('solo') as string) as never, res as never);

    expect(await remainingIds()).toEqual([]);
  });

  /**
   * Deleting a PUBLISHED post must not touch its replies: those are real posts
   * that readers have seen, and some of them are other people's.
   */
  it('does not cascade from a published post', async () => {
    await row('published-root', null, { status: 'published' });
    await row('reply', 'published-root', { status: 'published' });
    const { res } = buildResponse();

    await deletePost(buildRequest(idByLabel.get('published-root') as string) as never, res as never);

    expect(await remainingIds()).toEqual(['reply']);
  });

  it('never reaches another author\'s scheduled reply', async () => {
    await row('root', null);
    await row('theirs', 'root', { owner: OTHER });
    const { res } = buildResponse();

    await deletePost(buildRequest(idByLabel.get('root') as string) as never, res as never);

    expect(await remainingIds()).toEqual(['theirs']);
  });
});

describe('publishing a scheduled thread early', () => {
  /** The labels the chain walk drove the claim with, in order. */
  function claimedLabels(): string[] {
    return hoisted.claim.mock.calls.map(
      ([p]: [{ postId: string }]) => labelById.get(p.postId) ?? p.postId,
    );
  }

  it('publishes the whole chain, root first, from any post in it', async () => {
    await seedThread();
    const { res, payload } = buildResponse();

    await publishScheduledPostNow(buildRequest(idByLabel.get('c1') as string) as never, res as never);

    expect(claimedLabels()).toEqual(['root', 'c1', 'c2']);
    // The response is still about the post that was asked for.
    expect(payload.value?.id).toBe(idByLabel.get('c1'));
  });

  it('stops at a post that will not publish, so nothing jumps its parent', async () => {
    await seedThread();
    hoisted.claim.mockImplementation(async ({ postId }: { postId: string }) => {
      if (postId === idByLabel.get('root')) return null;
      const record = await claimScheduledPost(postId, undefined);
      return record ? { id: postId } : null;
    });
    const { res, payload } = buildResponse();

    await publishScheduledPostNow(buildRequest(idByLabel.get('c1') as string) as never, res as never);

    expect(claimedLabels()).toEqual(['root']);
    expect(payload.status).toBe(404);
  });

  it('refuses when a still-scheduled ancestor belongs to somebody else', async () => {
    await row('theirs', null, { owner: OTHER });
    await row('mine', 'theirs');
    const { res, payload } = buildResponse();

    await publishScheduledPostNow(buildRequest(idByLabel.get('mine') as string) as never, res as never);

    expect(payload.status).toBe(409);
    expect(hoisted.claim).not.toHaveBeenCalled();
  });

  it('still publishes a lone scheduled post by itself', async () => {
    await row('solo', null);
    const { res, payload } = buildResponse();

    await publishScheduledPostNow(buildRequest(idByLabel.get('solo') as string) as never, res as never);

    expect(hoisted.claim).toHaveBeenCalledTimes(1);
    expect(payload.value?.id).toBe(idByLabel.get('solo'));
  });

  it('tells the owner a post that already went out is not publishable again', async () => {
    await row('done', null, { status: 'published' });
    const { res, payload } = buildResponse();

    await publishScheduledPostNow(buildRequest(idByLabel.get('done') as string) as never, res as never);

    expect(payload.status).toBe(409);
    expect(payload.value?.message).toBe('This post has already been published');
  });
});
