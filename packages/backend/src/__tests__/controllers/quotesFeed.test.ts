import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * `GET /feed/quotes/:postId` — the destination behind the post-detail screen's
 * "N quotes" count.
 *
 * The load-bearing assertion here is the SORT AXIS. A federated quote carries the
 * remote authoring time in `createdAt`, so sorting by `createdAt` behind an `_id`
 * cursor silently skips backfilled rows at every page boundary — the same keyset
 * mismatch that once dropped boosts from profile feeds. If someone "fixes" the
 * ordering to `createdAt` later, the sort assertion below is what stops it.
 */

const postFind = vi.fn();
const anchorFind = vi.fn();
const hydratePosts = vi.fn();

/** Chainable Mongoose query stub that records what the controller asked for. */
let lastQuery: Record<string, unknown> | undefined;
let lastSort: Record<string, number> | undefined;
let lastLimit: number | undefined;

vi.mock('../../models/Post', () => ({
  Post: {
    findById: () => ({ lean: async () => anchorFind() }),
    find: (query: Record<string, unknown>) => {
      lastQuery = query;
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.sort = (sort: Record<string, number>) => { lastSort = sort; return q; };
      q.limit = (limit: number) => { lastLimit = limit; return q; };
      q.maxTimeMS = () => q;
      q.lean = async () => postFind();
      return q;
    },
  },
  POST_CLASSIFICATION_PENDING: 'pending',
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: (...a: unknown[]) => hydratePosts(...a) },
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: () => undefined,
  getServiceOxyClient: () => undefined,
}));

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    getBlockedUsers: vi.fn(async () => []),
    getRestrictedUsers: vi.fn(async () => []),
  }),
}));

vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));

import { feedController } from '../../controllers/feed.controller';

const QUOTED_ID = '650000000000000000000001';
const QUOTE_A = '650000000000000000000010';
const QUOTE_B = '650000000000000000000011';

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
  return res;
}

function makeReq(query: Record<string, string> = {}) {
  return { params: { postId: QUOTED_ID }, query, user: undefined } as never;
}

beforeEach(() => {
  lastQuery = undefined;
  lastSort = undefined;
  lastLimit = undefined;
  vi.clearAllMocks();
  anchorFind.mockReturnValue({ _id: QUOTED_ID, oxyUserId: 'anchor-author' });
  postFind.mockReturnValue([]);
  hydratePosts.mockImplementation(async (posts: { _id: string }[]) =>
    posts.map((p) => ({ id: String(p._id), user: { id: 'author' } })),
  );
});

describe('FeedController.getQuotesFeed', () => {
  it('matches only public, published posts that quote the subject', async () => {
    await feedController.getQuotesFeed(makeReq(), makeRes() as never);

    expect(lastQuery).toEqual({
      quoteOf: QUOTED_ID,
      visibility: 'public',
      status: 'published',
    });
  });

  it('does not enumerate quotes when the anchor is unavailable to the viewer', async () => {
    hydratePosts.mockResolvedValueOnce([null]);
    const res = makeRes();

    await feedController.getQuotesFeed(makeReq(), res as never);

    expect(res.statusCode).toBe(404);
    expect(postFind).not.toHaveBeenCalled();
  });

  it('returns not found without querying quotes when the anchor does not exist', async () => {
    anchorFind.mockReturnValue(null);
    const res = makeRes();

    await feedController.getQuotesFeed(makeReq(), res as never);

    expect(res.statusCode).toBe(404);
    expect(hydratePosts).not.toHaveBeenCalled();
    expect(postFind).not.toHaveBeenCalled();
  });

  it('pages on _id, never on createdAt', async () => {
    await feedController.getQuotesFeed(makeReq(), makeRes() as never);

    expect(lastSort).toEqual({ _id: -1 });
    expect(lastSort).not.toHaveProperty('createdAt');
  });

  it('turns a cursor into an _id keyset bound', async () => {
    await feedController.getQuotesFeed(makeReq({ cursor: QUOTE_A }), makeRes() as never);

    const idFilter = (lastQuery as { _id?: { $lt?: { toString(): string } } })._id;
    expect(String(idFilter?.$lt)).toBe(QUOTE_A);
  });

  it('overfetches by one and reports hasMore + the last returned id as the cursor', async () => {
    // limit 1 → the controller asks for 2 and gets 2, so there is a next page and
    // the cursor is the last row it actually RETURNS, not the overfetched one.
    postFind.mockReturnValue([{ _id: QUOTE_A }, { _id: QUOTE_B }]);
    const res = makeRes();

    await feedController.getQuotesFeed(makeReq({ limit: '1' }), res as never);

    expect(lastLimit).toBe(2);
    const body = res.body as { items: { id: string }[]; hasMore: boolean; nextCursor?: string };
    expect(body.items.map((i) => i.id)).toEqual([QUOTE_A]);
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toBe(QUOTE_A);
  });

  it('hydrates one level deep so each row can render the post it quotes', async () => {
    postFind.mockReturnValue([{ _id: QUOTE_A }]);

    await feedController.getQuotesFeed(makeReq(), makeRes() as never);

    expect(hydratePosts).toHaveBeenLastCalledWith(
      [{ _id: QUOTE_A }],
      expect.objectContaining({ maxDepth: 1, publicReferencesOnly: true }),
    );
  });

  it('reports no next page when the result does not fill the window', async () => {
    postFind.mockReturnValue([{ _id: QUOTE_A }]);
    const res = makeRes();

    await feedController.getQuotesFeed(makeReq({ limit: '5' }), res as never);

    const body = res.body as { hasMore: boolean; nextCursor?: string };
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeUndefined();
  });
});
