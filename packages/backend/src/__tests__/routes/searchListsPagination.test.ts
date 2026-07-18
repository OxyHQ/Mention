import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type Doc, makeQuery, matchCondition } from './fakeMongo';

/**
 * Route coverage for `GET /lists`:
 *  - the FIX: `?search=` now actually filters by name/description (it was ignored,
 *    so the search tab received every accessible list), while the visibility gate
 *    (own + public) still holds — a private list a non-owner matches never leaks.
 *  - opt-in offset pagination: `?limit` pages the results with a stable
 *    `{ updatedAt desc, _id desc }` sort, reports `hasMore`, and never repeats a
 *    row across pages; without `?limit` the full accessible set is returned.
 *
 * The route runs for real against a small in-memory AccountList (find + count);
 * only the heavy collaborators it imports are stubbed.
 */

const { find, countDocuments } = vi.hoisted(() => ({ find: vi.fn(), countDocuments: vi.fn() }));

vi.mock('../../models/AccountList', () => ({ default: { find, countDocuments } }));

// Imported at module load but never touched by GET /lists — stub so importing the
// router never drags in the feed controller / Oxy service / Redis chain.
vi.mock('../../models/Post', () => ({ Post: {} }));
vi.mock('../../controllers/feed.controller', () => ({ feedController: {} }));
vi.mock('../../services/EndorsementSignalService', () => ({
  endorsementSignalService: {
    syncScope: vi.fn().mockResolvedValue(undefined),
    syncScopeMembershipChange: vi.fn().mockResolvedValue(undefined),
    syncScopeRemoval: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../../middleware/security', () => ({
  feedIPRateLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  feedRateLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

import listsRoutes from '../../routes/lists';

const VIEWER = 'viewer-1';
const OTHER = 'other-1';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as express.Request & { user?: { id: string } }).user = { id: VIEWER };
  next();
});
app.use('/lists', listsRoutes);

/** Seed the in-memory collection and wire find/countDocuments to it. */
function seed(docs: Doc[]): void {
  find.mockImplementation((q: Record<string, unknown> = {}) =>
    makeQuery(docs.filter((d) => matchCondition(d, q))),
  );
  countDocuments.mockImplementation((q: Record<string, unknown> = {}) =>
    Promise.resolve(docs.filter((d) => matchCondition(d, q)).length),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /lists — search filter (the bug) + visibility gate', () => {
  beforeEach(() => {
    seed([
      { _id: 'l1', ownerOxyUserId: VIEWER, isPublic: true, title: 'Sports fans', description: 'athletes', updatedAt: 6 },
      { _id: 'l2', ownerOxyUserId: VIEWER, isPublic: false, title: 'My sport picks', description: '', updatedAt: 5 },
      { _id: 'l3', ownerOxyUserId: OTHER, isPublic: true, title: 'Sporting goods', description: '', updatedAt: 4 },
      // Matches "sport" but is PRIVATE and owned by someone else → must stay hidden.
      { _id: 'l4', ownerOxyUserId: OTHER, isPublic: false, title: 'Secret sports', description: '', updatedAt: 3 },
      { _id: 'l5', ownerOxyUserId: VIEWER, isPublic: true, title: 'Cooking', description: 'recipes', updatedAt: 2 },
      { _id: 'l6', ownerOxyUserId: OTHER, isPublic: true, title: 'Gardening', description: 'plants', updatedAt: 1 },
    ]);
  });

  it('returns ONLY the accessible lists whose name/description match the query', async () => {
    const res = await request(app).get('/lists').query({ search: 'sport' }).expect(200);
    const titles = (res.body.items as Array<{ title: string }>).map((l) => l.title);

    // l1/l2/l3 match and are visible; l5/l6 do not match; l4 matches but is gated.
    expect(titles).toEqual(['Sports fans', 'My sport picks', 'Sporting goods']);
    expect(titles).not.toContain('Cooking');
    expect(titles).not.toContain('Secret sports');
  });

  it('is case-insensitive and matches on the description too', async () => {
    const res = await request(app).get('/lists').query({ search: 'ATHLETES' }).expect(200);
    const titles = (res.body.items as Array<{ title: string }>).map((l) => l.title);
    expect(titles).toEqual(['Sports fans']);
  });

  it('still returns every accessible list when no search term is given', async () => {
    const res = await request(app).get('/lists').expect(200);
    const titles = (res.body.items as Array<{ title: string }>).map((l) => l.title);
    // All except the other-owned private list (l4).
    expect(titles).toEqual(['Sports fans', 'My sport picks', 'Sporting goods', 'Cooking', 'Gardening']);
  });
});

describe('GET /lists — offset pagination', () => {
  // Five public lists, all matching "team", newest-first by updatedAt.
  const lists: Doc[] = Array.from({ length: 5 }, (_, i) => ({
    _id: `t${i}`,
    ownerOxyUserId: OTHER,
    isPublic: true,
    title: `Team ${i}`,
    description: 'roster',
    updatedAt: 100 - i,
  }));

  beforeEach(() => seed(lists));

  it('pages with a stable order, reports hasMore, and never repeats a row', async () => {
    const seen: string[] = [];
    let offset = 0;
    let guard = 0;

    for (;;) {
      const res = await request(app).get('/lists').query({ search: 'team', limit: 2, offset }).expect(200);
      const titles = (res.body.items as Array<{ title: string }>).map((l) => l.title);
      seen.push(...titles);

      if (!res.body.pagination.hasMore) break;
      expect(titles).toHaveLength(2); // a non-terminal page is always full
      offset = res.body.pagination.offset + res.body.pagination.limit;
      if (++guard > 10) throw new Error('pagination did not terminate');
    }

    // Every list seen exactly once, in the stable newest-first order.
    expect(seen).toEqual(['Team 0', 'Team 1', 'Team 2', 'Team 3', 'Team 4']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('reports the accurate total and hasMore=false on the final page', async () => {
    const res = await request(app).get('/lists').query({ search: 'team', limit: 2, offset: 4 }).expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.pagination).toMatchObject({ offset: 4, limit: 2, hasMore: false });
    expect(res.body.total).toBe(5);
  });

  it('returns everything with hasMore=false when unbounded (no limit)', async () => {
    const res = await request(app).get('/lists').query({ search: 'team' }).expect(200);
    expect(res.body.items).toHaveLength(5);
    expect(res.body.pagination.hasMore).toBe(false);
  });
});
