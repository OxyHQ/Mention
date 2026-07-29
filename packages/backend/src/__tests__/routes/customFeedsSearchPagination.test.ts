import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type Doc, makeQuery, matchCondition } from './fakeMongo';

/**
 * Route coverage for the `GET /feeds` discovery list (`customFeeds.routes`):
 *  - opt-in offset pagination (`?limit` ⇒ paged with a stable
 *    `{ updatedAt desc, _id desc }` sort + `hasMore`; absent ⇒ the full set), and
 *  - `?search=` still narrows the results.
 *
 * The route runs for real against a small in-memory CustomFeed (find + count);
 * every heavy collaborator it imports (feed engine, hydration, Oxy client) is
 * stubbed so importing the router stays isolated.
 */

const { find, countDocuments, reviewFind, reviewCount } = vi.hoisted(() => ({
  find: vi.fn(),
  countDocuments: vi.fn(),
  reviewFind: vi.fn(),
  reviewCount: vi.fn(),
}));

vi.mock('../../models/CustomFeed', () => ({ default: { find, countDocuments } }));
vi.mock('../../models/FeedLike', () => ({
  default: {
    aggregate: vi.fn().mockResolvedValue([]),
    find: vi.fn(() => ({ lean: () => Promise.resolve([]) })),
  },
}));
vi.mock('../../models/FeedGenerator', () => ({ FeedGenerator: {} }));
vi.mock('../../models/FeedReview', () => ({ default: { find: reviewFind, countDocuments: reviewCount } }));

// Heavy collaborators imported at module load but unused by GET /feeds.
vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: vi.fn().mockResolvedValue(new Map()),
  degradedActorSummary: (oxyUserId: string) => ({ id: oxyUserId, username: '', name: { displayName: 'Unknown user' } }),
}));
vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(),
  getServiceOxyClient: vi.fn(),
}));
vi.mock('../../mtn/feed/definitions/customFeedDefinition', () => ({ buildCustomFeedDefinition: vi.fn() }));
vi.mock('../../mtn/feed/feedContext', () => ({ loadViewerFeedContext: vi.fn() }));
vi.mock('../../mtn/feed/engine/FeedEngine', () => ({ feedEngine: { run: vi.fn() } }));

import customFeedsRoutes from '../../routes/customFeeds.routes';

const OWNER = 'owner-1';

// A 24-hex _id so the route's `new mongoose.Types.ObjectId(item._id)` is valid.
function feedId(i: number): string {
  return `aaaaaaaaaaaaaaaaaaaaaaa${i}`;
}

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as express.Request & { user?: { id: string } }).user = { id: 'viewer-1' };
  next();
});
app.use('/feeds', customFeedsRoutes);

/** Sort specs the route handed to Mongo, in call order. */
const sortSpecs: Array<Record<string, number>> = [];

function seed(docs: Doc[]): void {
  find.mockImplementation((q: Record<string, unknown> = {}) =>
    makeQuery(docs.filter((d) => matchCondition(d, q)), (spec) => sortSpecs.push(spec)),
  );
  countDocuments.mockImplementation((q: Record<string, unknown> = {}) =>
    Promise.resolve(docs.filter((d) => matchCondition(d, q)).length),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sortSpecs.length = 0;
});

describe('GET /feeds — search filter', () => {
  beforeEach(() => {
    seed([
      { _id: feedId(0), ownerOxyUserId: OWNER, isPublic: true, title: 'World news', description: '', memberOxyUserIds: [], keywords: [], updatedAt: 3 },
      { _id: feedId(1), ownerOxyUserId: OWNER, isPublic: true, title: 'Breaking news', description: '', memberOxyUserIds: [], keywords: [], updatedAt: 2 },
      { _id: feedId(2), ownerOxyUserId: OWNER, isPublic: true, title: 'Cat photos', description: '', memberOxyUserIds: [], keywords: [], updatedAt: 1 },
    ]);
  });

  it('returns only public feeds whose title matches the query', async () => {
    const res = await request(app).get('/feeds').query({ publicOnly: true, search: 'news' }).expect(200);
    const titles = (res.body.items as Array<{ title: string }>).map((f) => f.title);
    expect(titles).toEqual(['World news', 'Breaking news']);
  });
});

describe('GET /feeds — offset pagination', () => {
  const feeds: Doc[] = Array.from({ length: 5 }, (_, i) => ({
    _id: feedId(i),
    ownerOxyUserId: OWNER,
    isPublic: true,
    title: `Daily ${i}`,
    description: 'digest',
    memberOxyUserIds: [],
    keywords: [],
    updatedAt: 100 - i,
  }));

  beforeEach(() => seed(feeds));

  it('pages with a stable order, reports hasMore, and never repeats a row', async () => {
    const seen: string[] = [];
    let offset = 0;
    let guard = 0;

    for (;;) {
      const res = await request(app).get('/feeds').query({ publicOnly: true, search: 'daily', limit: 2, offset }).expect(200);
      const titles = (res.body.items as Array<{ title: string }>).map((f) => f.title);
      seen.push(...titles);
      if (!res.body.pagination.hasMore) break;
      expect(titles).toHaveLength(2);
      offset = res.body.pagination.offset + res.body.pagination.limit;
      if (++guard > 10) throw new Error('pagination did not terminate');
    }

    expect(seen).toEqual(['Daily 0', 'Daily 1', 'Daily 2', 'Daily 3', 'Daily 4']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('reports the accurate total and hasMore on a paged request', async () => {
    const res = await request(app).get('/feeds').query({ publicOnly: true, search: 'daily', limit: 2, offset: 0 }).expect(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.pagination).toMatchObject({ offset: 0, limit: 2, hasMore: true });
    expect(res.body.total).toBe(5);
  });

  it('returns everything with hasMore=false when unbounded (no limit)', async () => {
    const res = await request(app).get('/feeds').query({ publicOnly: true, search: 'daily' }).expect(200);
    expect(res.body.items).toHaveLength(5);
    expect(res.body.pagination.hasMore).toBe(false);
  });

  // The paging assertions above CANNOT catch a missing tie-break: `updatedAt`
  // ties reshuffle only under concurrent writes or a plan change, neither of
  // which a seeded single-node run reproduces. Verified by mutation — removing
  // `_id` from the route's sort left every test above green. This is the check
  // that fails.
  it('sorts on a TOTAL order so offsets cannot shuffle rows between pages', async () => {
    await request(app).get('/feeds').query({ publicOnly: true, search: 'daily', limit: 2, offset: 0 }).expect(200);

    expect(sortSpecs).toHaveLength(1);
    expect(sortSpecs[0]).toEqual({ updatedAt: -1, _id: -1 });
  });
});

/**
 * The marketplace and the review list are the other two offset-paginated
 * listings in this router. Their sorts end in `createdAt`, which makes a tie
 * unlikely rather than impossible, so `_id` is what makes each order provably
 * total. Same reasoning as the `GET /feeds` case above; only the sort spec can
 * catch its removal.
 */
describe('GET /feeds/marketplace — total sort order', () => {
  beforeEach(() => seed([]));

  it.each([
    ['trending (default)', undefined, { subscriberCount: -1, createdAt: -1, _id: -1 }],
    ['newest', 'newest', { createdAt: -1, _id: -1 }],
    ['rating', 'rating', { averageRating: -1, ratingsCount: -1, createdAt: -1, _id: -1 }],
  ])('breaks ties by _id when sorting by %s', async (_label, sortBy, expected) => {
    const query: Record<string, string | number> = { limit: 2, page: 1 };
    if (sortBy) query.sortBy = sortBy;

    await request(app).get('/feeds/marketplace').query(query).expect(200);

    expect(sortSpecs).toHaveLength(1);
    expect(sortSpecs[0]).toEqual(expected);
  });
});

describe('GET /feeds/:id/reviews — total sort order', () => {
  beforeEach(() => {
    reviewFind.mockImplementation(() => makeQuery([], (spec) => sortSpecs.push(spec)));
    reviewCount.mockResolvedValue(0);
  });

  it('breaks createdAt ties by _id', async () => {
    await request(app)
      .get('/feeds/aaaaaaaaaaaaaaaaaaaaaaa1/reviews')
      .query({ page: 1, limit: 2 })
      .expect(200);

    expect(sortSpecs).toHaveLength(1);
    expect(sortSpecs[0]).toEqual({ createdAt: -1, _id: -1 });
  });
});
