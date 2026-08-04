import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';

/**
 * Route coverage for `GET /lists`:
 *  - `?search=` filters by name/description (it was once ignored, so the search
 *    tab received every accessible list), while the visibility gate (own +
 *    public) still holds — a private list a non-owner matches never leaks;
 *  - `?userId=` returns ONE account's lists, and never that account's private
 *    ones to anybody else;
 *  - opt-in offset pagination pages with a stable `(updated_at desc, id desc)`
 *    order, reports `hasMore`, and never repeats a row; without `?limit` the
 *    full accessible set is returned.
 *
 * ## Real rows, not a fake collection
 *
 * `main` ran this against an in-memory `AccountList` double (`./fakeMongo`) and
 * asserted the SORT SPEC the route handed Mongo. Neither survives the port: the
 * route builds a drizzle query against `account_lists`, so a model double
 * intercepts nothing and there is no spec object to inspect. Every case below is
 * therefore a real query against real rows — which is also what lets the
 * tie-break case be a behavioural one rather than a claim about a literal.
 *
 * Rows are namespaced by title prefix and deleted by id in `afterEach`: vitest
 * runs files in parallel against one database, and `GET /lists` reads every
 * accessible list, so an unscoped assertion would see another suite's rows.
 */

// Imported at module load but never touched by GET /lists — stub so importing the
// router never drags in the feed controller / Oxy service / Redis chain.
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

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { accountLists } from '../../db/schema/lists';
import listsRoutes from '../../routes/lists';

/** Per-suite ids, so a parallel file's lists cannot answer these assertions. */
const SUITE = 'searchlists';
const VIEWER = `${SUITE}-viewer`;
const OTHER = `${SUITE}-other`;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as express.Request & { user?: { id: string } }).user = { id: VIEWER };
  next();
});
app.use('/lists', listsRoutes);

const seededIds: string[] = [];

interface ListSeed {
  ownerOxyUserId: string;
  isPublic: boolean;
  title: string;
  description?: string;
  /** Higher = newer. Turned into a real instant so the route's ordering is real. */
  updatedAt: number;
}

/**
 * Insert the suite's rows.
 *
 * `updated_at` is written EXPLICITLY rather than left to the column default,
 * because the order under test is `updated_at desc` and rows inserted in one
 * statement can share a default instant — which would make the ordering
 * assertions pass or fail on insertion speed.
 */
async function seed(rows: ListSeed[]): Promise<void> {
  const inserted = await getDb()
    .insert(accountLists)
    .values(
      rows.map((row) => ({
        ownerOxyUserId: row.ownerOxyUserId,
        title: row.title,
        description: row.description ?? null,
        isPublic: row.isPublic,
        updatedAt: new Date(Date.UTC(2026, 0, 1) + row.updatedAt * 60_000),
      })),
    )
    .returning({ id: accountLists.id });
  seededIds.push(...inserted.map((row) => row.id));
}

/** The titles the route returned, in the order it returned them. */
function titlesOf(body: unknown): string[] {
  return ((body as { items: Array<{ title: string }> }).items ?? []).map((item) => item.title);
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  const ids = seededIds.splice(0);
  if (ids.length > 0) await getDb().delete(accountLists).where(inArray(accountLists.id, ids));
});

afterAll(async () => {
  await closePostgres();
});

describe('GET /lists — search filter + visibility gate', () => {
  beforeEach(async () => {
    await seed([
      { ownerOxyUserId: VIEWER, isPublic: true, title: 'Sports fans', description: 'athletes', updatedAt: 6 },
      { ownerOxyUserId: VIEWER, isPublic: false, title: 'My sport picks', description: '', updatedAt: 5 },
      { ownerOxyUserId: OTHER, isPublic: true, title: 'Sporting goods', description: '', updatedAt: 4 },
      // Matches "sport" but is PRIVATE and owned by someone else → must stay hidden.
      { ownerOxyUserId: OTHER, isPublic: false, title: 'Secret sports', description: '', updatedAt: 3 },
      { ownerOxyUserId: VIEWER, isPublic: true, title: 'Cooking', description: 'recipes', updatedAt: 2 },
      { ownerOxyUserId: OTHER, isPublic: true, title: 'Gardening', description: 'plants', updatedAt: 1 },
    ]);
  });

  it('returns ONLY the accessible lists whose name/description match the query', async () => {
    const res = await request(app).get('/lists').query({ search: 'sport' }).expect(200);
    const titles = titlesOf(res.body);

    // The first three match and are visible; Cooking/Gardening do not match;
    // "Secret sports" matches but is another owner's private list.
    expect(titles).toEqual(['Sports fans', 'My sport picks', 'Sporting goods']);
    expect(titles).not.toContain('Cooking');
    expect(titles).not.toContain('Secret sports');
  });

  it('is case-insensitive and matches on the description too', async () => {
    const res = await request(app).get('/lists').query({ search: 'ATHLETES' }).expect(200);
    expect(titlesOf(res.body)).toEqual(['Sports fans']);
  });

  it('still returns every accessible list when no search term is given', async () => {
    const res = await request(app).get('/lists').query({ userId: VIEWER }).expect(200);
    // Scoped to the viewer so a parallel suite's public lists cannot join the
    // answer; the gate itself is what the private-list cases above pin.
    expect(titlesOf(res.body)).toEqual(['Sports fans', 'My sport picks', 'Cooking']);
  });
});

describe("GET /lists — ?userId, ONE account's lists", () => {
  beforeEach(async () => {
    await seed([
      { ownerOxyUserId: VIEWER, isPublic: true, title: 'Viewer public', updatedAt: 6 },
      { ownerOxyUserId: VIEWER, isPublic: false, title: 'Viewer private', updatedAt: 5 },
      { ownerOxyUserId: OTHER, isPublic: true, title: 'Other public', updatedAt: 4 },
      { ownerOxyUserId: OTHER, isPublic: false, title: 'Other private', updatedAt: 3 },
    ]);
  });

  /**
   * The bug this parameter exists for. The profile's Lists tab sent `?userId=`
   * for a long time while the route read only `mine`/`publicOnly`, so it fell
   * through to the viewer-shaped visibility gate and answered a DIFFERENT
   * question: the viewer's own lists plus every public one — on somebody else's
   * profile. It read as a rendering quirk and was a leak between profiles.
   *
   * Nothing typed caught it: the tab builds its params in a VARIABLE, and
   * TypeScript's excess-property check applies only to object literals passed
   * directly.
   */
  it("returns only that owner's lists, not the viewer's", async () => {
    const res = await request(app).get('/lists').query({ userId: OTHER }).expect(200);
    const titles = titlesOf(res.body);

    expect(titles).toEqual(['Other public']);
    expect(titles).not.toContain('Viewer public');
    expect(titles).not.toContain('Viewer private');
  });

  /**
   * The load-bearing half. `?userId=` must not become a way to read somebody's
   * PRIVATE lists — a filter that widens what a viewer can see is worse than the
   * bug it replaced.
   */
  it("never exposes another owner's private lists", async () => {
    const res = await request(app).get('/lists').query({ userId: OTHER }).expect(200);
    expect(titlesOf(res.body)).not.toContain('Other private');
  });

  it('returns the viewer their own private lists when they ask for themselves', async () => {
    const res = await request(app).get('/lists').query({ userId: VIEWER }).expect(200);
    expect(titlesOf(res.body)).toEqual(['Viewer public', 'Viewer private']);
  });

  it('still narrows within the owner when a search term is given', async () => {
    const res = await request(app).get('/lists').query({ userId: OTHER, search: 'public' }).expect(200);
    expect(titlesOf(res.body)).toEqual(['Other public']);
  });
});

describe('GET /lists — offset pagination', () => {
  // Five public lists, all matching "team", newest-first by `updated_at`.
  beforeEach(async () => {
    await seed(
      Array.from({ length: 5 }, (_, i) => ({
        ownerOxyUserId: OTHER,
        isPublic: true,
        title: `Team ${i}`,
        description: 'roster',
        updatedAt: 100 - i,
      })),
    );
  });

  it('pages with a stable order, reports hasMore, and never repeats a row', async () => {
    const seen: string[] = [];
    let offset = 0;
    let guard = 0;

    for (;;) {
      const res = await request(app)
        .get('/lists')
        .query({ userId: OTHER, search: 'team', limit: 2, offset })
        .expect(200);
      const titles = titlesOf(res.body);
      seen.push(...titles);

      if (!res.body.pagination.hasMore) break;
      expect(titles).toHaveLength(2); // a non-terminal page is always full
      offset = res.body.pagination.offset + res.body.pagination.limit;
      if (++guard > 10) throw new Error('pagination did not terminate');
    }

    expect(seen).toEqual(['Team 0', 'Team 1', 'Team 2', 'Team 3', 'Team 4']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('reports the accurate total and hasMore=false on the final page', async () => {
    const res = await request(app)
      .get('/lists')
      .query({ userId: OTHER, search: 'team', limit: 2, offset: 4 })
      .expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.pagination).toMatchObject({ offset: 4, limit: 2, hasMore: false });
    expect(res.body.total).toBe(5);
  });

  it('returns everything with hasMore=false when unbounded (no limit)', async () => {
    const res = await request(app)
      .get('/lists')
      .query({ userId: OTHER, search: 'team' })
      .expect(200);
    expect(res.body.items).toHaveLength(5);
    expect(res.body.pagination.hasMore).toBe(false);
  });
});

/**
 * The TIE-BREAK, which is the one case the paging assertions above cannot reach.
 *
 * `main` pinned it by asserting the literal sort spec the route handed Mongo
 * (`{ updatedAt: -1, _id: -1 }`), and said so: `updated_at` ties reshuffle only
 * under concurrent writes or a plan change, neither of which a seeded run
 * reproduces, so removing `_id` from the sort left every paging test green.
 *
 * There is no spec object to assert here — the route builds a drizzle query —
 * so the property is pinned BEHAVIOURALLY instead, against rows that all share
 * one `updated_at`. `OFFSET`/`LIMIT` over a non-total order is free to return
 * the same row on two pages and skip another, and Postgres does exactly that
 * when the ordering column does not discriminate.
 *
 * MUTATION-VERIFIED: dropping `desc(accountLists.id)` from the route's
 * `orderBy` makes this case fail and leaves every case above green — which is
 * the whole reason it is written separately rather than folded into the paging
 * describe.
 */
describe('GET /lists — a TOTAL order, so offsets cannot shuffle rows between pages', () => {
  const TIED_COUNT = 12;

  beforeEach(async () => {
    await seed(
      Array.from({ length: TIED_COUNT }, (_, i) => ({
        ownerOxyUserId: OTHER,
        isPublic: true,
        title: `Tied ${String(i).padStart(2, '0')}`,
        description: 'tied',
        // The SAME instant for every row: `updated_at` alone cannot order them.
        updatedAt: 500,
      })),
    );
  });

  it('walks every tied row exactly once', async () => {
    const seen: string[] = [];
    for (let offset = 0; offset < TIED_COUNT; offset += 3) {
      const res = await request(app)
        .get('/lists')
        .query({ userId: OTHER, search: 'tied', limit: 3, offset })
        .expect(200);
      seen.push(...titlesOf(res.body));
    }

    expect(seen).toHaveLength(TIED_COUNT);
    expect(new Set(seen).size).toBe(TIED_COUNT);
  });
});
