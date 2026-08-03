import { beforeEach, describe, expect, it, vi } from 'vitest';

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

interface Row {
  _id: string;
  oxyUserId: string;
  status: string;
  parentPostId: string | null;
  content?: Record<string, unknown>;
}

const hoisted = vi.hoisted(() => ({
  rows: [] as {
    _id: string;
    oxyUserId: string;
    status: string;
    parentPostId: string | null;
    content?: Record<string, unknown>;
  }[],
  deleteManyFilters: [] as Record<string, unknown>[],
  claim: vi.fn(),
  hydratePosts: vi.fn(),
  articleDeleteMany: vi.fn(),
  pollDeleteMany: vi.fn(),
}));

/**
 * The Mongo subset these two handlers use, over an in-memory row set that
 * HONOURS the filters — so a cascade that forgot to scope itself to the caller
 * or to `status: 'scheduled'` shows up as a wrong row set rather than passing.
 */
vi.mock('../../models/Post', async (importOriginal) => {
  const matches = (row: Row, filter: Record<string, unknown>): boolean =>
    Object.entries(filter).every(([key, condition]) => {
      const value = (row as unknown as Record<string, unknown>)[key];
      if (condition && typeof condition === 'object' && '$in' in condition) {
        return (condition as { $in: unknown[] }).$in.some((v) => String(v) === String(value));
      }
      return String(value) === String(condition);
    });
  const chainable = (rows: unknown[]) => {
    const self: Record<string, unknown> = {};
    self.select = () => self;
    self.sort = () => self;
    self.lean = async () => rows;
    return self;
  };
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    Post: {
      find: (filter: Record<string, unknown>) =>
        chainable(hoisted.rows.filter((row) => matches(row, filter))),
      findOne: (filter: Record<string, unknown>) =>
        chainable(hoisted.rows.filter((row) => matches(row, filter))[0] ?? null),
      findById: (id: unknown) => ({
        select: () => ({
          lean: async () => hoisted.rows.find((row) => row._id === String(id)) ?? null,
        }),
      }),
      findOneAndDelete: async (filter: Record<string, unknown>) => {
        const row = hoisted.rows.find((r) => matches(r, filter));
        if (!row) return null;
        hoisted.rows = hoisted.rows.filter((r) => r !== row);
        return { ...row, _id: { toString: () => row._id }, content: row.content };
      },
      deleteMany: async (filter: Record<string, unknown>) => {
        hoisted.deleteManyFilters.push(filter);
        const doomed = hoisted.rows.filter((row) => matches(row, filter));
        hoisted.rows = hoisted.rows.filter((row) => !doomed.includes(row));
        return { deletedCount: doomed.length };
      },
    },
  };
});

vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));

vi.mock('../../services/PostCreationService', () => ({
  postCreationService: { claimAndPublishScheduledPost: hoisted.claim },
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: hoisted.hydratePosts },
  resolveUserSummaries: vi.fn(async () => new Map()),
  degradedActorSummary: (id: string) => ({ id, username: '', name: { displayName: 'Unknown' } }),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(() => ({})),
  createUserScopedOxyServices: vi.fn(() => undefined),
}));

vi.mock('../../services/PostRecentReplierService', () => ({
  repairRecentRepliersAfterPostDelete: vi.fn(async () => undefined),
}));

vi.mock('../../services/mtn/MentionRecordEmitter', () => ({
  emitPostCreated: vi.fn(),
  emitTombstone: vi.fn(async () => undefined),
  postRecordUri: () => 'at://test',
}));

vi.mock('../../connectors/outboundFederation', () => ({ federateAsResolvedActor: vi.fn() }));

vi.mock('../../models/Article', () => ({
  default: { deleteOne: () => ({ exec: async () => undefined }), deleteMany: hoisted.articleDeleteMany },
}));

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

import { deletePost, publishScheduledPostNow } from '../../controllers/posts.controller';

const AUTHOR = 'author_1';

function row(id: string, parentPostId: string | null, status = 'scheduled'): Row {
  return { _id: id, oxyUserId: AUTHOR, status, parentPostId };
}

/** A scheduled thread: root -> c1 -> c2. */
function seedThread() {
  hoisted.rows = [row('root', null), row('c1', 'root'), row('c2', 'c1')];
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

function remainingIds(): string[] {
  return hoisted.rows.map((r) => r._id);
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.rows = [];
  hoisted.deleteManyFilters = [];
  hoisted.articleDeleteMany.mockReturnValue({ exec: async () => undefined });
  hoisted.pollDeleteMany.mockReturnValue({ exec: async () => undefined });
  hoisted.hydratePosts.mockImplementation(async (posts: unknown[]) => posts);
  hoisted.claim.mockImplementation(async ({ postId }: { postId: string }) => {
    const target = hoisted.rows.find((r) => r._id === postId);
    if (!target || target.status !== 'scheduled') return null;
    target.status = 'published';
    return { _id: postId, toObject: () => ({ _id: postId }) };
  });
});

describe('cancelling a scheduled thread', () => {
  it('takes the continuations with the root', async () => {
    seedThread();
    const { res, payload } = buildResponse();

    await deletePost(buildRequest('root') as never, res as never);

    expect(payload.value?.message).toBe('Post deleted successfully');
    expect(remainingIds()).toEqual([]);
  });

  it('cancels only what depends on the post, not what precedes it', async () => {
    seedThread();
    const { res } = buildResponse();

    await deletePost(buildRequest('c1') as never, res as never);

    // `root` published first and is nobody's continuation; `c2` replied to `c1`
    // and cannot exist without it.
    expect(remainingIds()).toEqual(['root']);
  });

  it('leaves a lone scheduled post to delete exactly itself', async () => {
    hoisted.rows = [row('solo', null)];
    const { res } = buildResponse();

    await deletePost(buildRequest('solo') as never, res as never);

    expect(remainingIds()).toEqual([]);
    expect(hoisted.deleteManyFilters).toEqual([]);
  });

  /**
   * Deleting a PUBLISHED post must not touch its replies: those are real posts
   * that readers have seen, and some of them are other people's.
   */
  it('does not cascade from a published post', async () => {
    hoisted.rows = [
      row('published-root', null, 'published'),
      row('reply', 'published-root', 'published'),
    ];
    const { res } = buildResponse();

    await deletePost(buildRequest('published-root') as never, res as never);

    expect(remainingIds()).toEqual(['reply']);
  });

  it('never reaches another author\'s scheduled reply', async () => {
    hoisted.rows = [
      row('root', null),
      { _id: 'theirs', oxyUserId: 'someone_else', status: 'scheduled', parentPostId: 'root' },
    ];
    const { res } = buildResponse();

    await deletePost(buildRequest('root') as never, res as never);

    expect(remainingIds()).toEqual(['theirs']);
  });
});

describe('publishing a scheduled thread early', () => {
  it('publishes the whole chain, root first, from any post in it', async () => {
    seedThread();
    const { res, payload } = buildResponse();

    await publishScheduledPostNow(buildRequest('c1') as never, res as never);

    expect(hoisted.claim.mock.calls.map(([p]: [{ postId: string }]) => p.postId)).toEqual([
      'root',
      'c1',
      'c2',
    ]);
    // The response is still about the post that was asked for.
    expect(payload.value?._id).toBe('c1');
  });

  it('stops at a post that will not publish, so nothing jumps its parent', async () => {
    seedThread();
    hoisted.claim.mockImplementation(async ({ postId }: { postId: string }) => {
      if (postId === 'root') return null;
      const target = hoisted.rows.find((r) => r._id === postId);
      if (target) target.status = 'published';
      return { _id: postId, toObject: () => ({ _id: postId }) };
    });
    const { res, payload } = buildResponse();

    await publishScheduledPostNow(buildRequest('c1') as never, res as never);

    expect(hoisted.claim.mock.calls.map(([p]: [{ postId: string }]) => p.postId)).toEqual(['root']);
    expect(payload.status).toBe(404);
  });

  it('refuses when a still-scheduled ancestor belongs to somebody else', async () => {
    hoisted.rows = [
      { _id: 'theirs', oxyUserId: 'someone_else', status: 'scheduled', parentPostId: null },
      row('mine', 'theirs'),
    ];
    const { res, payload } = buildResponse();

    await publishScheduledPostNow(buildRequest('mine') as never, res as never);

    expect(payload.status).toBe(409);
    expect(hoisted.claim).not.toHaveBeenCalled();
  });

  it('still publishes a lone scheduled post by itself', async () => {
    hoisted.rows = [row('solo', null)];
    const { res, payload } = buildResponse();

    await publishScheduledPostNow(buildRequest('solo') as never, res as never);

    expect(hoisted.claim).toHaveBeenCalledTimes(1);
    expect(payload.value?._id).toBe('solo');
  });

  it('tells the owner a post that already went out is not publishable again', async () => {
    hoisted.rows = [row('done', null, 'published')];
    const { res, payload } = buildResponse();

    await publishScheduledPostNow(buildRequest('done') as never, res as never);

    expect(payload.status).toBe(409);
    expect(payload.value?.message).toBe('This post has already been published');
  });
});
