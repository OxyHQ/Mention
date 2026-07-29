import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type Doc, makeQuery, matchCondition } from './fakeMongo';

/**
 * Route coverage for the `GET /starter-packs` listing:
 *  - `?page`/`?limit` offset pagination on a TOTAL sort, so the search tab can
 *    page past the first window instead of being silently capped at it,
 *  - a truthful `total` (the match count, not the page length), and
 *  - `?search=` still narrowing over name + description.
 *
 * The route runs for real against a small in-memory StarterPack (find + count);
 * the collaborators it imports for the write paths (author resolution, cache
 * invalidation, endorsement sync) are stubbed so importing the router stays
 * isolated.
 */

const { find, countDocuments } = vi.hoisted(() => ({ find: vi.fn(), countDocuments: vi.fn() }));

vi.mock('../../models/StarterPack', () => ({ default: { find, countDocuments } }));
vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: vi.fn().mockResolvedValue(new Map()),
  isFallbackUserSummary: vi.fn().mockReturnValue(false),
}));
vi.mock('../../services/userSummaryCache', () => ({ invalidate: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/EndorsementSignalService', () => ({
  endorsementSignalService: {
    syncScope: vi.fn().mockResolvedValue(undefined),
    syncScopeMembershipChange: vi.fn().mockResolvedValue(undefined),
    retractScope: vi.fn().mockResolvedValue(undefined),
  },
}));

import starterPackRoutes from '../../routes/starterPacks';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as express.Request & { user?: { id: string } }).user = { id: 'viewer-1' };
  next();
});
app.use('/starter-packs', starterPackRoutes);

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

/** 60 packs — more than the default page — every one matching `search=pack`. */
const PACKS: Doc[] = Array.from({ length: 60 }, (_, i) => ({
  _id: `pack-${String(i).padStart(2, '0')}`,
  ownerOxyUserId: 'owner-1',
  name: `Pack ${String(i).padStart(2, '0')}`,
  description: 'a curated set',
  memberOxyUserIds: [],
  useCount: 0,
  createdAt: 1000 - i,
  updatedAt: 1000 - i,
}));

beforeEach(() => {
  vi.clearAllMocks();
  sortSpecs.length = 0;
  seed(PACKS);
});

describe('GET /starter-packs — pagination', () => {
  it('reports the real match count, not the page length', async () => {
    const res = await request(app).get('/starter-packs').query({ search: 'pack', limit: 10 }).expect(200);

    expect(res.body.items).toHaveLength(10);
    expect(res.body.total).toBe(60);
    expect(res.body).toMatchObject({ page: 1, totalPages: 6 });
  });

  it('pages past the default window without repeating or skipping a row', async () => {
    const seen: string[] = [];

    for (let page = 1; page <= 3; page++) {
      const res = await request(app)
        .get('/starter-packs')
        .query({ search: 'pack', limit: 25, page })
        .expect(200);
      expect(res.body.page).toBe(page);
      seen.push(...(res.body.items as Array<{ name: string }>).map((p) => p.name));
    }

    expect(seen).toHaveLength(60);
    expect(new Set(seen).size).toBe(60);
    // The third page reaches rows the un-paginated route could never return.
    expect(seen.at(-1)).toBe('Pack 59');
  });

  it('defaults to the window the route returned before it paginated', async () => {
    const res = await request(app).get('/starter-packs').query({ search: 'pack' }).expect(200);

    expect(res.body.items).toHaveLength(50);
    expect(res.body.total).toBe(60);
  });

  it('clamps an oversized limit to the ceiling', async () => {
    const res = await request(app).get('/starter-packs').query({ search: 'pack', limit: 500 }).expect(200);

    expect(res.body.items).toHaveLength(60);
    expect(res.body.totalPages).toBe(1);
  });

  // Offset pagination is only safe on a TOTAL order. A sort that can tie leaves
  // the tied rows free to swap places between two page requests, which drops or
  // duplicates rows at the boundary. That drift needs concurrent writes or a plan
  // change to show up, so no amount of single-node paging asserts it — the only
  // check that can actually fail is on the sort spec itself.
  it('sorts discovery on a total order, tie-broken by _id', async () => {
    await request(app).get('/starter-packs').query({ search: 'pack' }).expect(200);

    expect(sortSpecs).toHaveLength(1);
    expect(Object.keys(sortSpecs[0]).at(-1)).toBe('_id');
  });

  it('sorts owner-scoped listings on a total order too', async () => {
    await request(app).get('/starter-packs').query({ mine: 'true' }).expect(200);

    expect(sortSpecs).toHaveLength(1);
    expect(Object.keys(sortSpecs[0]).at(-1)).toBe('_id');
  });

  it('narrows by search over name and description', async () => {
    seed([
      { _id: 'a', ownerOxyUserId: 'owner-1', name: 'Photographers', description: '', memberOxyUserIds: [], useCount: 3, createdAt: 3, updatedAt: 3 },
      { _id: 'b', ownerOxyUserId: 'owner-1', name: 'Chefs', description: 'great photo accounts', memberOxyUserIds: [], useCount: 2, createdAt: 2, updatedAt: 2 },
      { _id: 'c', ownerOxyUserId: 'owner-1', name: 'Cyclists', description: 'road racing', memberOxyUserIds: [], useCount: 1, createdAt: 1, updatedAt: 1 },
    ]);

    const res = await request(app).get('/starter-packs').query({ search: 'photo' }).expect(200);

    expect((res.body.items as Array<{ name: string }>).map((p) => p.name)).toEqual(['Photographers', 'Chefs']);
    expect(res.body.total).toBe(2);
  });
});
