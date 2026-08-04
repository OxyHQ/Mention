import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { PostType, PostVisibility } from '@mention/shared-types';

/**
 * `GET /feed/quotes/:postId` — the destination behind the post-detail screen's
 * "N quotes" count, against REAL ROWS.
 *
 * ## The sort axis, restated
 *
 * The previous version pinned `sort: { _id: -1 }` and asserted the absence of
 * `createdAt`, because a `createdAt` sort behind an `_id` cursor silently skips
 * backfilled rows at every page boundary (the keyset mismatch that once dropped
 * boosts from profile feeds). The MISMATCH was the defect, not the `createdAt`
 * axis — and `_id` order stopped meaning anything the moment ids became uuid v7
 * next to pre-cutover ObjectId hex, which interleave under text collation.
 *
 * So the page now orders AND pages on the same two keys, `(created_at DESC, id
 * DESC)`, and the assertion that guards it is a real one: a federated quote
 * carrying an OLD remote authoring time must still be reachable by walking the
 * cursor, and must never be served twice. A shape assertion on a sort object
 * cannot see either property; walking the pages can.
 */
const hydratePosts = vi.fn();

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

import { closePostgres, connectPostgres } from '../../db/postgres';
import { deletePostRecord, insertPostRecord } from '../../db/posts/postRepository';
import type { PostRecord, PostRecordInput } from '../../db/posts/postRecord';
import { feedController } from '../../controllers/feed.controller';

const AUTHOR = 'oxy-quote-author';
const created: string[] = [];
let quotedId = '';

async function seed(overrides: Partial<PostRecordInput> = {}): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'commentary', tag: 'en' }] },
    ...overrides,
  });
  created.push(record.id);
  return record.id;
}

interface QuotesBody {
  items: { id: string }[];
  hasMore: boolean;
  nextCursor?: string;
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
}

function makeReq(query: Record<string, string> = {}, postId?: string) {
  return { params: { postId: postId ?? quotedId }, query, user: undefined } as never;
}

/** One page of the quotes feed, as the route actually serves it. */
async function fetchPage(query: Record<string, string> = {}): Promise<QuotesBody> {
  const res = makeRes();
  await feedController.getQuotesFeed(makeReq(query), res as never);
  return res.body as QuotesBody;
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  hydratePosts.mockImplementation(async (records: PostRecord[]) =>
    records.map((record) => ({ id: record.id, user: { id: 'author' } })),
  );
  quotedId = await seed();
});

afterEach(async () => {
  for (const id of created.splice(0).reverse()) {
    await deletePostRecord(id, undefined);
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('FeedController.getQuotesFeed', () => {
  it('returns only public, published posts that quote the subject', async () => {
    const quote = await seed({ quoteOf: quotedId });
    const privateQuote = await seed({ quoteOf: quotedId, visibility: PostVisibility.PRIVATE });
    const draftQuote = await seed({ quoteOf: quotedId, status: 'draft' });
    const unrelated = await seed();

    const body = await fetchPage();

    expect(body.items.map((item) => item.id)).toEqual([quote]);
    expect(body.items.map((item) => item.id)).not.toContain(privateQuote);
    expect(body.items.map((item) => item.id)).not.toContain(draftQuote);
    expect(body.items.map((item) => item.id)).not.toContain(unrelated);
  });

  it('serves newest-first by authoring time, so a backfilled quote sorts where it was written', async () => {
    const newest = await seed({ quoteOf: quotedId, createdAt: new Date('2026-03-01T00:00:00Z') });
    // A federated quote imported today but AUTHORED long ago. Under an
    // insertion-order sort it would appear at the top; under the authoring-time
    // sort it appears where it belongs.
    const backfilled = await seed({
      quoteOf: quotedId,
      createdAt: new Date('2025-01-01T00:00:00Z'),
      federation: { activityId: 'https://remote.example/statuses/1' },
    });
    const middle = await seed({ quoteOf: quotedId, createdAt: new Date('2026-02-01T00:00:00Z') });

    const body = await fetchPage();

    expect(body.items.map((item) => item.id)).toEqual([newest, middle, backfilled]);
  });

  it('does not enumerate quotes when the anchor is unavailable to the viewer', async () => {
    // `getQuotesFeed` is a public route, but "who quoted this" is only public
    // when the quoted post itself is viewable. The anchor goes through the same
    // post/profile ACL as post detail BEFORE any quote is enumerated, so an
    // anonymous caller learns nothing about a private post's quote graph.
    //
    // Hydration is mocked in this suite, so the ACL verdict has to be INJECTED:
    // seeding a private anchor would prove nothing, because the mock returns a
    // DTO for whatever it is handed. Dropping the anchor on its own (first)
    // hydration call is exactly the verdict the real ACL returns for a post the
    // viewer may not read.
    await seed({ quoteOf: quotedId });
    hydratePosts.mockResolvedValueOnce([]);
    const res = makeRes();

    await feedController.getQuotesFeed(makeReq(), res as never);

    expect(res.statusCode).toBe(404);
    // ONE hydration — the anchor's. The quote page was never built, so the
    // quote graph of an unreadable post is not disclosed even in part.
    expect(hydratePosts).toHaveBeenCalledTimes(1);
  });

  it('returns not found without enumerating quotes when the anchor does not exist', async () => {
    const res = makeRes();

    await feedController.getQuotesFeed(makeReq({}, 'no-such-post-id'), res as never);

    expect(res.statusCode).toBe(404);
    expect(hydratePosts).not.toHaveBeenCalled();
  });

  it('walks EVERY quote across page boundaries, with no row skipped or repeated', async () => {
    // The timestamps are chosen so a page boundary lands BETWEEN two quotes
    // authored in the same instant: newest-first with `limit: 2`, page one ends
    // on the FIRST of the two `T2` rows. A keyset that bounds on `created_at`
    // alone then excludes both, and the second `T2` quote is lost forever —
    // silently, and only for readers who scroll. Ties that sit wholly inside one
    // page cannot demonstrate this, which is why the fixture places them here.
    const ids = [
      await seed({ quoteOf: quotedId, createdAt: new Date('2026-01-05T00:00:00Z') }),
      await seed({ quoteOf: quotedId, createdAt: new Date('2026-01-04T00:00:00Z') }),
      await seed({ quoteOf: quotedId, createdAt: new Date('2026-01-04T00:00:00Z') }),
      await seed({ quoteOf: quotedId, createdAt: new Date('2026-01-02T00:00:00Z') }),
      await seed({ quoteOf: quotedId, createdAt: new Date('2026-01-01T00:00:00Z') }),
    ];

    const walked: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < ids.length + 1; page += 1) {
      const body = await fetchPage({ limit: '2', ...(cursor ? { cursor } : {}) });
      walked.push(...body.items.map((item) => item.id));
      if (!body.hasMore) break;
      expect(body.nextCursor).toBeDefined();
      cursor = body.nextCursor;
    }

    // Both halves matter and fail in opposite directions: a set SMALLER than the
    // corpus means a row was skipped, and a walk LONGER than the set means one
    // was served twice.
    expect(new Set(walked)).toEqual(new Set(ids));
    expect(walked).toHaveLength(ids.length);
  });

  it('overfetches by one and reports hasMore plus the last RETURNED row as the cursor', async () => {
    await seed({ quoteOf: quotedId, createdAt: new Date('2026-01-01T00:00:00Z') });
    const newer = await seed({ quoteOf: quotedId, createdAt: new Date('2026-01-02T00:00:00Z') });

    const body = await fetchPage({ limit: '1' });

    expect(body.items.map((item) => item.id)).toEqual([newer]);
    expect(body.hasMore).toBe(true);
    // The cursor names the row the client just received, not the overfetched one.
    expect(body.nextCursor).toContain(newer);
  });

  it('hydrates one level deep so each row can render the post it quotes', async () => {
    await seed({ quoteOf: quotedId });

    await fetchPage();

    expect(hydratePosts).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ maxDepth: 1, publicReferencesOnly: true }),
    );
  });

  it('reports no next page when the result does not fill the window', async () => {
    await seed({ quoteOf: quotedId });

    const body = await fetchPage({ limit: '5' });

    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeUndefined();
  });
});
