/**
 * `customFeeds.routes` against REAL Postgres rows.
 *
 * The previous version of this file asserted the SORT SPEC handed to a fake
 * Mongo — it could tell you the route asked for `{updatedAt:-1,_id:-1}` and
 * nothing about whether a row came back right. Everything here seeds real rows,
 * runs the real router, and asserts what is stored and returned.
 *
 * Four guarantees are load-bearing and each has a test whose failure NAMES it:
 *
 *  1. **A total survives a page past the end.** `total` is its own query. If it
 *     were collapsed into the page query as `count(*) OVER ()` it would be
 *     carried by the returned rows, and a page beyond the result set returns no
 *     rows — so the client would read "0 results" for a set with thousands.
 *  2. **The order is TOTAL.** Offset pagination over rows that tie on every sort
 *     key silently duplicates and skips at the page boundary. The `id` tiebreak
 *     is asserted by seeding an exact tie and pinning the resulting order.
 *  3. **The `excludeSubscribed` NOT EXISTS excludes exactly two things.** The
 *     viewer's liked feeds and the viewer's own — and nothing else. Asserted
 *     with EXACT non-zero counts on both sides, because "the correlated
 *     subquery matched nothing" is the failure that returns a plausible-looking
 *     page. It does NOT gate the `qualified()` call: measured against drizzle's
 *     output, that reference already renders `"custom_feeds"."id"` in a WHERE
 *     fragment, so removing `qualified()` changes no SQL and this test stays
 *     green. See the note at that call site for which rendering shape the trap
 *     actually fires in.
 *  4. **Module order is evaluation order.** `sources`/`signals`/`filters` come
 *     back in `position` order after a real reorder that reuses positions.
 *
 * Oxy identity is stubbed because it is an HTTP service, not a store; the feed
 * engine is stubbed so the timeline test can assert the DEFINITION it received.
 */

import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';

const { feedEngineRun } = vi.hoisted(() => ({
  feedEngineRun: vi.fn(async () => ({
    items: [],
    hasMore: false,
    nextCursor: undefined,
    totalCount: 0,
  })),
}));

vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: vi.fn(async (ids: string[]) =>
    new Map(
      ids.map((id) => [
        id,
        { user: { id, username: `handle_${id}`, avatar: `avatar_${id}`, name: { displayName: id } } },
      ]),
    ),
  ),
  degradedActorSummary: (oxyUserId: string) => ({
    id: oxyUserId,
    username: '',
    name: { displayName: 'Unknown user' },
  }),
}));
vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(() => undefined),
  getServiceOxyClient: vi.fn(() => ({})),
}));
vi.mock('../../mtn/feed/feedContext', () => ({
  loadViewerFeedContext: vi.fn(async () => ({ followingIds: [] })),
}));
vi.mock('../../mtn/feed/engine/FeedEngine', () => ({
  feedEngine: { run: feedEngineRun },
}));

import customFeedsRoutes from '../../routes/customFeeds.routes';
import { registerAllModules } from '../../mtn/feed/engine';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import {
  customFeedDefinitionModules,
  customFeedMembers,
  customFeedSourceLists,
  customFeedTopics,
  customFeeds,
  feedGenerators,
  feedLikes,
  feedReviews,
} from '../../db/schema/feeds';
import { accountLists } from '../../db/schema/lists';
import type { FeedDefinition } from '../../mtn/feed/engine/types';

let db: Database;

/** Ids created by a test, removed in `afterEach`. Children cascade. */
const createdFeedIds: string[] = [];
const createdGeneratorIds: string[] = [];
const createdListIds: string[] = [];

/** The viewer the fake auth middleware injects; `undefined` means anonymous. */
let viewer: string | undefined;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (viewer) (req as express.Request & { user?: { id: string } }).user = { id: viewer };
  next();
});
app.use('/feeds', customFeedsRoutes);

/** A definition the module registry accepts. */
const VALID_DEFINITION = {
  mode: 'chronological' as const,
  sources: [{ module: 'keywords', enabled: true, params: { hashtags: ['comics'] } }],
  signals: [],
  filters: [],
};

function uniqueId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

interface SeedOptions {
  /** Supplied only where the test needs id order to disagree with insert order. */
  id?: string;
  ownerOxyUserId: string;
  title: string;
  isPublic?: boolean;
  description?: string;
  keywords?: string[];
  tags?: string[];
  category?: 'news' | 'tech' | 'culture' | 'finance' | 'health' | 'sports' | 'entertainment' | 'other';
  subscriberCount?: number;
  averageRating?: number;
  ratingsCount?: number;
  updatedAt?: Date;
  createdAt?: Date;
  language?: string;
  includeReplies?: boolean;
  includeBoosts?: boolean;
  includeMedia?: boolean;
}

/** Insert a feed directly, bypassing the route (the read paths are under test). */
async function seedFeed(options: SeedOptions): Promise<string> {
  const [row] = await db
    .insert(customFeeds)
    .values({
      ...(options.id === undefined ? {} : { id: options.id }),
      ownerOxyUserId: options.ownerOxyUserId,
      title: options.title,
      isPublic: options.isPublic ?? true,
      description: options.description ?? null,
      keywords: options.keywords ?? null,
      tags: options.tags ?? null,
      category: options.category ?? null,
      subscriberCount: options.subscriberCount ?? 0,
      averageRating: options.averageRating ?? 0,
      ratingsCount: options.ratingsCount ?? 0,
      language: options.language ?? null,
      ...(options.includeReplies === undefined ? {} : { includeReplies: options.includeReplies }),
      ...(options.includeBoosts === undefined ? {} : { includeBoosts: options.includeBoosts }),
      ...(options.includeMedia === undefined ? {} : { includeMedia: options.includeMedia }),
      ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
      ...(options.updatedAt === undefined ? {} : { updatedAt: options.updatedAt }),
    })
    .returning({ id: customFeeds.id });
  createdFeedIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  db = await connectPostgres();
  // The routes validate a submitted definition against the SHARED singleton
  // registry, which the server populates at startup.
  registerAllModules();
});

afterEach(async () => {
  viewer = undefined;
  feedEngineRun.mockClear();
  if (createdFeedIds.length > 0) {
    await db.delete(customFeeds).where(inArray(customFeeds.id, createdFeedIds.splice(0)));
  }
  if (createdGeneratorIds.length > 0) {
    await db.delete(feedGenerators).where(inArray(feedGenerators.id, createdGeneratorIds.splice(0)));
  }
  if (createdListIds.length > 0) {
    await db.delete(accountLists).where(inArray(accountLists.id, createdListIds.splice(0)));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('GET /feeds — search', () => {
  it('narrows to feeds whose title matches, newest-updated first', async () => {
    const owner = uniqueId('owner');
    viewer = owner;
    await seedFeed({ ownerOxyUserId: owner, title: 'World news', updatedAt: new Date(3000) });
    await seedFeed({ ownerOxyUserId: owner, title: 'Breaking news', updatedAt: new Date(2000) });
    await seedFeed({ ownerOxyUserId: owner, title: 'Cat photos', updatedAt: new Date(1000) });

    const res = await request(app).get('/feeds').query({ userId: owner, search: 'news' }).expect(200);
    expect((res.body.items as Array<{ title: string }>).map((f) => f.title)).toEqual([
      'World news',
      'Breaking news',
    ]);
  });

  it('matches an element of the keywords ARRAY, which `ilike` on the column cannot', async () => {
    const owner = uniqueId('owner');
    viewer = owner;
    await seedFeed({ ownerOxyUserId: owner, title: 'Untitled', keywords: ['astronomy', 'space'] });
    await seedFeed({ ownerOxyUserId: owner, title: 'Untitled', keywords: ['baking'] });

    const res = await request(app).get('/feeds').query({ userId: owner, search: 'astro' }).expect(200);
    expect(res.body.items).toHaveLength(1);
    expect((res.body.items as Array<{ keywords: string[] }>)[0].keywords).toEqual([
      'astronomy',
      'space',
    ]);
  });

  it('treats a LIKE wildcard in the search term as a literal', async () => {
    // The Mongo version escaped REGEX metacharacters. `%` and `_` are the ones
    // `ILIKE` cares about; leaving them live turns the search box into a way to
    // match every feed in the table.
    const owner = uniqueId('owner');
    viewer = owner;
    await seedFeed({ ownerOxyUserId: owner, title: 'Percentages' });

    const wildcard = await request(app).get('/feeds').query({ userId: owner, search: '%' }).expect(200);
    expect(wildcard.body.items).toEqual([]);

    const literal = await request(app).get('/feeds').query({ userId: owner, search: 'Percent' }).expect(200);
    expect(literal.body.items).toHaveLength(1);
  });
});

describe('GET /feeds — offset pagination', () => {
  async function seedFive(owner: string): Promise<void> {
    for (let index = 0; index < 5; index += 1) {
      await seedFeed({
        ownerOxyUserId: owner,
        title: `Daily ${index}`,
        description: 'digest',
        updatedAt: new Date(100_000 - index * 1000),
      });
    }
  }

  it('pages with a stable order, reports hasMore, and never repeats a row', async () => {
    const owner = uniqueId('owner');
    viewer = owner;
    await seedFive(owner);

    const seen: string[] = [];
    let offset = 0;
    let guard = 0;

    for (;;) {
      const res = await request(app)
        .get('/feeds')
        .query({ userId: owner, search: 'daily', limit: 2, offset })
        .expect(200);
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
    const owner = uniqueId('owner');
    viewer = owner;
    await seedFive(owner);

    const res = await request(app)
      .get('/feeds')
      .query({ userId: owner, search: 'daily', limit: 2, offset: 0 })
      .expect(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.pagination).toMatchObject({ offset: 0, limit: 2, hasMore: true });
    expect(res.body.total).toBe(5);
  });

  it('still reports the FULL total on a page PAST THE END of the result set', async () => {
    /**
     * The mutation target. Collapse `total` into the page query as
     * `count(*) OVER ()` and this page — which returns no rows — carries no
     * total, so the response says 0 for a set of 5. The client renders "no
     * results" and nothing anywhere reports an error.
     */
    const owner = uniqueId('owner');
    viewer = owner;
    await seedFive(owner);

    const res = await request(app)
      .get('/feeds')
      .query({ userId: owner, search: 'daily', limit: 2, offset: 999 })
      .expect(200);

    expect(res.body.items).toEqual([]);
    expect(res.body.pagination.hasMore).toBe(false);
    expect(res.body.total).toBe(5);
  });

  it('returns everything with hasMore=false when unbounded (no limit)', async () => {
    const owner = uniqueId('owner');
    viewer = owner;
    await seedFive(owner);

    const res = await request(app).get('/feeds').query({ userId: owner, search: 'daily' }).expect(200);
    expect(res.body.items).toHaveLength(5);
    expect(res.body.pagination.hasMore).toBe(false);
    expect(res.body.total).toBe(5);
  });

  it('orders rows that TIE on updatedAt by id descending, so offsets cannot shuffle them', async () => {
    /**
     * The paging assertions above cannot catch a missing tiebreak: with distinct
     * `updatedAt` values the order is already total.
     *
     * Here every row shares one `updatedAt`, so `id` is the only thing deciding
     * their order — and the ids are SUPPLIED rather than generated, in an order
     * that deliberately disagrees with insertion order. A generated id would
     * not do: `uuidv7()` is k-sortable, so id order and insertion order coincide
     * and the assertion below would hold whether or not the tiebreak is there.
     * Mutation-tested: dropping `desc(customFeeds.id)` from the route's
     * `orderBy` makes this fail with the ids in insertion order.
     */
    const owner = uniqueId('owner');
    viewer = owner;
    const tied = new Date(50_000);
    // 24-char ObjectId hex, the shape every pre-cutover row carries. Inserted
    // c, a, d, b — so heap order is nothing like `id desc`.
    const insertionOrder = [
      'cccccccccccccccccccccccc',
      'aaaaaaaaaaaaaaaaaaaaaaaa',
      'dddddddddddddddddddddddd',
      'bbbbbbbbbbbbbbbbbbbbbbbb',
    ];
    for (const [index, id] of insertionOrder.entries()) {
      await seedFeed({ ownerOxyUserId: owner, title: `Tied ${index}`, updatedAt: tied, id });
    }

    const res = await request(app).get('/feeds').query({ userId: owner, search: 'tied' }).expect(200);
    expect((res.body.items as Array<{ id: string }>).map((f) => f.id)).toEqual([
      'dddddddddddddddddddddddd',
      'cccccccccccccccccccccccc',
      'bbbbbbbbbbbbbbbbbbbbbbbb',
      'aaaaaaaaaaaaaaaaaaaaaaaa',
    ]);
  });
});

describe('GET /feeds/marketplace', () => {
  it.each([
    ['trending (default)', undefined, ['high', 'mid', 'low']],
    ['newest', 'newest', ['low', 'mid', 'high']],
    ['rating', 'rating', ['mid', 'high', 'low']],
  ])('orders by %s', async (_label, sortBy, expected) => {
    const owner = uniqueId('owner');
    const token = randomUUID().replace(/-/g, '');
    viewer = undefined;
    // `high`/`mid`/`low` are named for subscriberCount; createdAt runs the other
    // way, so trending and newest cannot coincide. `high` and `low` share an
    // `averageRating` on purpose, and their `ratingsCount` runs OPPOSITE to
    // their `createdAt`: that is what makes `ratingsCount` — the second rank key
    // of the rating sort — the thing deciding between them. Order it the same
    // way as `createdAt` and dropping the key is masked by the next one down,
    // which is how a rank-key test comes to pass against the bug it exists for.
    await seedFeed({
      ownerOxyUserId: owner, title: `high ${token}`, subscriberCount: 30,
      createdAt: new Date(1000), averageRating: 4, ratingsCount: 7,
    });
    await seedFeed({
      ownerOxyUserId: owner, title: `mid ${token}`, subscriberCount: 20,
      createdAt: new Date(2000), averageRating: 5, ratingsCount: 9,
    });
    await seedFeed({
      ownerOxyUserId: owner, title: `low ${token}`, subscriberCount: 10,
      createdAt: new Date(3000), averageRating: 4, ratingsCount: 1,
    });

    const query: Record<string, string | number> = { search: token, limit: 10, page: 1 };
    if (sortBy) query.sortBy = sortBy;
    const res = await request(app).get('/feeds/marketplace').query(query).expect(200);

    expect((res.body.items as Array<{ title: string }>).map((f) => f.title.split(' ')[0])).toEqual(
      expected,
    );
    expect(res.body.total).toBe(3);
  });

  it('excludeSubscribed drops liked feeds AND the viewer\'s own, and nothing else', async () => {
    /**
     * The trap-1 assertion. If `${customFeeds.id}` inside the NOT EXISTS
     * rendered bare it would resolve against `feed_likes` and compare that
     * table's `feed_id` to its own `id` — never equal, so NOT EXISTS is always
     * true and NOTHING is excluded. The counts below are exact and non-zero on
     * both sides of that, which is what makes the failure visible.
     */
    const owner = uniqueId('owner');
    const stranger = uniqueId('stranger');
    const token = randomUUID().replace(/-/g, '');
    viewer = owner;

    const mine = await seedFeed({ ownerOxyUserId: owner, title: `mine ${token}` });
    const liked = await seedFeed({ ownerOxyUserId: stranger, title: `liked ${token}` });
    const fresh = await seedFeed({ ownerOxyUserId: stranger, title: `fresh ${token}` });
    await db.insert(feedLikes).values({ userId: owner, feedId: liked });

    const all = await request(app)
      .get('/feeds/marketplace')
      .query({ search: token, limit: 10 })
      .expect(200);
    expect(all.body.total).toBe(3);

    const filtered = await request(app)
      .get('/feeds/marketplace')
      .query({ search: token, limit: 10, excludeSubscribed: 'true' })
      .expect(200);
    expect(filtered.body.total).toBe(1);
    expect((filtered.body.items as Array<{ id: string }>).map((f) => f.id)).toEqual([fresh]);
    expect(filtered.body.items).toHaveLength(1);
    // Named explicitly so a failure says WHICH exclusion broke.
    expect((filtered.body.items as Array<{ id: string }>).map((f) => f.id)).not.toContain(liked);
    expect((filtered.body.items as Array<{ id: string }>).map((f) => f.id)).not.toContain(mine);
  });

  it('breaks a full marketplace tie by id, so its offset pages are stable too', async () => {
    /**
     * The three sorts above all end in `desc(customFeeds.id)`. Nothing in them
     * can catch its removal, because none of their fixtures ties on every
     * preceding key. This one does — same subscriberCount, same createdAt — with
     * SUPPLIED ids so id order disagrees with insertion order.
     */
    const owner = uniqueId('owner');
    const token = randomUUID().replace(/-/g, '');
    viewer = undefined;
    const tied = new Date(70_000);
    // Inserted e then f, so heap order and `id desc` disagree.
    for (const id of ['eeeeeeeeeeeeeeeeeeeeeeee', 'ffffffffffffffffffffffff']) {
      await seedFeed({
        id, ownerOxyUserId: owner, title: `${id.slice(0, 1)} ${token}`,
        subscriberCount: 5, createdAt: tied,
      });
    }

    const res = await request(app).get('/feeds/marketplace').query({ search: token }).expect(200);
    expect((res.body.items as Array<{ id: string }>).map((f) => f.id)).toEqual([
      'ffffffffffffffffffffffff',
      'eeeeeeeeeeeeeeeeeeeeeeee',
    ]);
  });

  it('keeps the total correct on a page past the end', async () => {
    const owner = uniqueId('owner');
    const token = randomUUID().replace(/-/g, '');
    viewer = undefined;
    await seedFeed({ ownerOxyUserId: owner, title: `a ${token}` });
    await seedFeed({ ownerOxyUserId: owner, title: `b ${token}` });

    const res = await request(app)
      .get('/feeds/marketplace')
      .query({ search: token, limit: 1, page: 99 })
      .expect(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(2);
    expect(res.body.totalPages).toBe(2);
  });

  it('never offers a private feed, and matches a tag as well as a keyword', async () => {
    const owner = uniqueId('owner');
    const token = randomUUID().replace(/-/g, '');
    viewer = undefined;
    await seedFeed({ ownerOxyUserId: owner, title: 'hidden', isPublic: false, tags: [token] });
    await seedFeed({ ownerOxyUserId: owner, title: 'tagged', tags: [token] });
    await seedFeed({ ownerOxyUserId: owner, title: 'keyworded', keywords: [token] });

    const res = await request(app).get('/feeds/marketplace').query({ search: token }).expect(200);
    expect((res.body.items as Array<{ title: string }>).map((f) => f.title).sort()).toEqual([
      'keyworded',
      'tagged',
    ]);
  });
});

describe('GET /feeds/marketplace/categories', () => {
  it('counts public feeds per category and never emits a null bucket', async () => {
    // This endpoint has no scoping parameter and the suite shares one database,
    // so the expectation is derived from the database rather than assumed —
    // which still fails if the route's predicate (public + category present) or
    // its grouping is wrong.
    const owner = uniqueId('owner');
    viewer = undefined;
    await seedFeed({ ownerOxyUserId: owner, title: 'a', category: 'tech' });
    await seedFeed({ ownerOxyUserId: owner, title: 'b', category: 'tech' });
    await seedFeed({ ownerOxyUserId: owner, title: 'c', category: 'tech', isPublic: false });
    await seedFeed({ ownerOxyUserId: owner, title: 'd' });

    const [expectedTech] = await db
      .select({ value: sql<number>`count(*)`.mapWith(Number) })
      .from(customFeeds)
      .where(and(eq(customFeeds.category, 'tech'), eq(customFeeds.isPublic, true)));

    const res = await request(app).get('/feeds/marketplace/categories').expect(200);
    const categories = res.body.categories as Array<{ category: string | null; count: number }>;
    expect(categories.find((c) => c.category === 'tech')?.count).toBe(expectedTech.value);
    expect(categories.some((c) => c.category === null)).toBe(false);
    // Vacuity floor: the seeded rows must actually be in there.
    expect(expectedTech.value).toBeGreaterThanOrEqual(2);
  });
});

describe('POST /feeds and the definition module lists', () => {
  it('creates a feed, stores its modules in order, and serves them back in order', async () => {
    const owner = uniqueId('owner');
    viewer = owner;

    const created = await request(app)
      .post('/feeds')
      .send({
        title: '  Comics  ',
        description: 'best comics',
        visibility: 'public',
        icon: 'sparkles',
        definition: {
          mode: 'chronological',
          sources: [
            { module: 'accounts', enabled: true, params: { authorIds: ['a1'] } },
            { module: 'keywords', enabled: true, params: { hashtags: ['comics'] } },
          ],
          signals: [],
          filters: [
            { module: 'noReplies', enabled: true },
            { module: 'noBoosts', enabled: false },
          ],
        },
        // Mass-assignment attempts — must be ignored.
        ownerOxyUserId: 'attacker',
        subscriberCount: 9999,
      })
      .expect(201);
    createdFeedIds.push(created.body.id);

    expect(created.body.ownerOxyUserId).toBe(owner);
    expect(created.body.subscriberCount).toBe(0);
    expect(created.body.title).toBe('Comics');
    expect(created.body.definition.sources.map((s: { module: string }) => s.module)).toEqual([
      'accounts',
      'keywords',
    ]);
    expect(created.body.definition.filters).toEqual([
      { module: 'noReplies', enabled: true },
      { module: 'noBoosts', enabled: false },
    ]);
    // `params` is jsonb because a module defines its own params; it must survive
    // untouched and unprojected.
    expect(created.body.definition.sources[0].params).toEqual({ authorIds: ['a1'] });

    const stored = await db
      .select()
      .from(customFeedDefinitionModules)
      .where(eq(customFeedDefinitionModules.feedId, created.body.id));
    expect(stored).toHaveLength(4);
    expect(stored.filter((m) => m.kind === 'source').map((m) => m.position).sort()).toEqual([0, 1]);
  });

  it('REORDERS a definition without colliding on (feed, kind, position)', async () => {
    /**
     * Module order IS evaluation order, and `(feed_id, kind, position)` is
     * UNIQUE — so a reorder that reuses the same positions can only work if the
     * old rows are removed before the new ones are inserted, inside one
     * transaction. A partial update would fail on the constraint; a
     * position-agnostic read would silently return the OLD order.
     */
    const owner = uniqueId('owner');
    viewer = owner;
    const created = await request(app)
      .post('/feeds')
      .send({
        title: 'Ordered',
        definition: {
          mode: 'chronological',
          sources: [
            { module: 'accounts', enabled: true, params: { authorIds: ['a1'] } },
            { module: 'keywords', enabled: true, params: { hashtags: ['x'] } },
          ],
          signals: [],
          filters: [],
        },
      })
      .expect(201);
    createdFeedIds.push(created.body.id);

    const updated = await request(app)
      .put(`/feeds/${created.body.id}`)
      .send({
        definition: {
          mode: 'chronological',
          sources: [
            { module: 'keywords', enabled: true, params: { hashtags: ['x'] } },
            { module: 'accounts', enabled: true, params: { authorIds: ['a1'] } },
          ],
          signals: [],
          filters: [],
        },
      })
      .expect(200);

    expect(updated.body.definition.sources.map((s: { module: string }) => s.module)).toEqual([
      'keywords',
      'accounts',
    ]);
    const reread = await request(app).get(`/feeds/${created.body.id}`).expect(200);
    expect(reread.body.definition.sources.map((s: { module: string }) => s.module)).toEqual([
      'keywords',
      'accounts',
    ]);
  });

  it('rejects a definition the module registry does not accept', async () => {
    viewer = uniqueId('owner');
    await request(app)
      .post('/feeds')
      .send({
        title: 'Bad',
        definition: {
          mode: 'chronological',
          sources: [{ module: 'following', enabled: true }],
          signals: [],
          filters: [],
        },
      })
      .expect(400);
  });
});

describe('GET /feeds/:id — wire format and the legacy fields', () => {
  it('emits _id alongside id, defaults arrays, and OMITS an absent optional', async () => {
    const owner = uniqueId('owner');
    viewer = owner;
    const feedId = await seedFeed({ ownerOxyUserId: owner, title: 'Bare' });

    const res = await request(app).get(`/feeds/${feedId}`).expect(200);
    expect(res.body._id).toBe(feedId);
    expect(res.body.id).toBe(feedId);
    expect(res.body).not.toHaveProperty('description');
    expect(res.body).not.toHaveProperty('icon');
    expect(res.body).not.toHaveProperty('language');
    expect(res.body).not.toHaveProperty('category');
    expect(res.body).not.toHaveProperty('coverImage');
    // A feed created before the composable definition existed has NO definition,
    // which is what makes the request-time legacy fallback fire.
    expect(res.body).not.toHaveProperty('definition');
    expect(res.body.keywords).toEqual([]);
    expect(res.body.tags).toEqual([]);
    expect(res.body.memberOxyUserIds).toEqual([]);
    expect(res.body.sourceListIds).toEqual([]);
    expect(res.body.topicIds).toEqual([]);
    expect(res.body.includeReplies).toBe(true);
    expect(res.body.memberCount).toBe(0);
    expect(res.body.topicCount).toBe(0);
  });

  it('still serves the seven LEGACY filter fields, and the junction ids', async () => {
    const owner = uniqueId('owner');
    viewer = owner;
    const feedId = await seedFeed({
      ownerOxyUserId: owner,
      title: 'Legacy',
      keywords: ['art'],
      language: 'es',
      includeReplies: false,
      includeBoosts: false,
      includeMedia: false,
    });
    const [list] = await db
      .insert(accountLists)
      .values({ ownerOxyUserId: owner, title: 'Sources' })
      .returning({ id: accountLists.id });
    createdListIds.push(list.id);
    await db.insert(customFeedSourceLists).values({ feedId, listId: list.id });
    await db.insert(customFeedTopics).values({ feedId, topicId: 'topic-42' });
    await db.insert(customFeedMembers).values([
      { feedId, oxyUserId: 'm1', position: 0 },
      { feedId, oxyUserId: 'm2', position: 1 },
    ]);

    const res = await request(app).get(`/feeds/${feedId}`).expect(200);
    expect(res.body.keywords).toEqual(['art']);
    expect(res.body.language).toBe('es');
    expect(res.body.includeReplies).toBe(false);
    expect(res.body.includeBoosts).toBe(false);
    expect(res.body.includeMedia).toBe(false);
    expect(res.body.sourceListIds).toEqual([list.id]);
    expect(res.body.topicIds).toEqual(['topic-42']);
    expect(res.body.memberOxyUserIds).toEqual(['m1', 'm2']);
    expect(res.body.memberCount).toBe(2);
    // `topicCount` counts KEYWORDS, not `topicIds` — preserved verbatim.
    expect(res.body.topicCount).toBe(1);
    expect(res.body.members.map((m: { id: string }) => m.id)).toEqual(['m1', 'm2']);
    expect(res.body.memberAvatars).toEqual(['avatar_m1', 'avatar_m2']);
    expect(res.body.owner.id).toBe(owner);
  });

  it('refuses a private feed to anyone but its owner', async () => {
    const owner = uniqueId('owner');
    const feedId = await seedFeed({ ownerOxyUserId: owner, title: 'Secret', isPublic: false });

    viewer = uniqueId('stranger');
    await request(app).get(`/feeds/${feedId}`).expect(403);
    viewer = owner;
    await request(app).get(`/feeds/${feedId}`).expect(200);
  });
});

describe('GET /feeds/:id/timeline', () => {
  it('runs the STORED definition, in module order', async () => {
    const owner = uniqueId('owner');
    viewer = owner;
    const created = await request(app)
      .post('/feeds')
      .send({
        title: 'Timeline',
        visibility: 'public',
        definition: {
          mode: 'chronological',
          sources: [
            { module: 'accounts', enabled: true, params: { authorIds: ['a1'] } },
            { module: 'keywords', enabled: true, params: { hashtags: ['x'] } },
          ],
          signals: [],
          filters: [{ module: 'noReplies', enabled: true }],
        },
      })
      .expect(201);
    createdFeedIds.push(created.body.id);

    await request(app).get(`/feeds/${created.body.id}/timeline`).expect(200);

    expect(feedEngineRun).toHaveBeenCalledTimes(1);
    const definition = feedEngineRun.mock.calls[0][0] as unknown as FeedDefinition;
    expect(definition.id).toBe(`custom|${created.body.id}`);
    expect(definition.sources.map((s) => s.module)).toEqual(['accounts', 'keywords']);
    // `ensureSafetyFilters` appends the safety gate; the author's own filters
    // keep their order ahead of it.
    expect(definition.filters.map((f) => f.module)).toEqual(['noReplies', 'safety']);
  });

  it('falls back to the LEGACY fields for a feed with no stored definition', async () => {
    const owner = uniqueId('owner');
    viewer = owner;
    const feedId = await seedFeed({
      ownerOxyUserId: owner,
      title: 'Legacy timeline',
      keywords: ['art'],
      includeReplies: false,
    });
    await db.insert(customFeedMembers).values({ feedId, oxyUserId: 'member-1', position: 0 });

    await request(app).get(`/feeds/${feedId}/timeline`).expect(200);

    const definition = feedEngineRun.mock.calls[0][0] as unknown as FeedDefinition;
    expect(definition.sources.map((s) => s.module)).toEqual(['accounts', 'keywords']);
    expect(definition.sources[0].params).toEqual({ authorIds: ['member-1'] });
    expect(definition.filters.map((f) => f.module)).toContain('noReplies');
  });
});

describe('POST/DELETE /feeds/:id/like — the live subscription mechanism', () => {
  it('moves subscriberCount by exactly one, and a duplicate like does not double-count', async () => {
    const owner = uniqueId('owner');
    const liker = uniqueId('liker');
    const feedId = await seedFeed({ ownerOxyUserId: owner, title: 'Likeable' });

    viewer = liker;
    const first = await request(app).post(`/feeds/${feedId}/like`).expect(200);
    expect(first.body).toMatchObject({ liked: true, likeCount: 1, message: 'Feed liked successfully' });

    const second = await request(app).post(`/feeds/${feedId}/like`).expect(200);
    expect(second.body).toMatchObject({ liked: true, likeCount: 1, message: 'Feed already liked' });

    const rows = await db.select().from(feedLikes).where(eq(feedLikes.feedId, feedId));
    expect(rows).toHaveLength(1);
    const [feed] = await db
      .select({ subscriberCount: customFeeds.subscriberCount })
      .from(customFeeds)
      .where(eq(customFeeds.id, feedId));
    expect(feed.subscriberCount).toBe(1);
  });

  it('unliking removes the row and decrements once; a second unlike is a no-op', async () => {
    const owner = uniqueId('owner');
    const liker = uniqueId('liker');
    const feedId = await seedFeed({ ownerOxyUserId: owner, title: 'Likeable' });

    viewer = liker;
    await request(app).post(`/feeds/${feedId}/like`).expect(200);
    const first = await request(app).delete(`/feeds/${feedId}/like`).expect(200);
    expect(first.body).toMatchObject({ liked: false, likeCount: 0, message: 'Feed unliked successfully' });
    const second = await request(app).delete(`/feeds/${feedId}/like`).expect(200);
    expect(second.body).toMatchObject({ liked: false, likeCount: 0, message: 'Feed not liked' });

    expect(await db.select().from(feedLikes).where(eq(feedLikes.feedId, feedId))).toEqual([]);
  });

  it('never drives subscriberCount below zero', async () => {
    /**
     * `custom_feeds_counts_check` refuses a negative count, so a counter that
     * had already drifted below its real subscriber set would turn an unlike
     * into a 500 rather than an unlike.
     */
    const owner = uniqueId('owner');
    const liker = uniqueId('liker');
    const feedId = await seedFeed({ ownerOxyUserId: owner, title: 'Drifted' });
    await db.insert(feedLikes).values({ userId: liker, feedId });
    // Drift, exactly as a legacy row could carry it.
    await db.update(customFeeds).set({ subscriberCount: 0 }).where(eq(customFeeds.id, feedId));

    viewer = liker;
    const res = await request(app).delete(`/feeds/${feedId}/like`).expect(200);
    expect(res.body.likeCount).toBe(0);
  });

  it('reports likeCount and isLiked on the listing', async () => {
    const owner = uniqueId('owner');
    const liker = uniqueId('liker');
    const feedId = await seedFeed({ ownerOxyUserId: owner, title: 'Counted' });
    await db.insert(feedLikes).values([
      { userId: liker, feedId },
      { userId: uniqueId('other'), feedId },
    ]);

    viewer = liker;
    const res = await request(app).get('/feeds').query({ userId: owner }).expect(200);
    expect(res.body.items[0].likeCount).toBe(2);
    expect(res.body.items[0].isLiked).toBe(true);

    viewer = uniqueId('nobody');
    const anon = await request(app).get('/feeds').query({ userId: owner }).expect(200);
    expect(anon.body.items[0].likeCount).toBe(2);
    expect(anon.body.items[0].isLiked).toBe(false);
  });
});

describe('feed members', () => {
  it('appends new members, dedupes, preserves order, and removes by id', async () => {
    const owner = uniqueId('owner');
    viewer = owner;
    const feedId = await seedFeed({ ownerOxyUserId: owner, title: 'Members' });

    const added = await request(app)
      .post(`/feeds/${feedId}/members`)
      .send({ userIds: ['a', 'b'] })
      .expect(200);
    expect(added.body.memberOxyUserIds).toEqual(['a', 'b']);

    const again = await request(app)
      .post(`/feeds/${feedId}/members`)
      .send({ userIds: ['b', 'c'] })
      .expect(200);
    expect(again.body.memberOxyUserIds).toEqual(['a', 'b', 'c']);
    // The member routes answer with the bare feed document, exactly as the
    // Mongo handlers did — no `memberCount`/`likeCount` enrichment.
    expect(again.body).not.toHaveProperty('memberCount');

    const removed = await request(app)
      .delete(`/feeds/${feedId}/members`)
      .send({ userIds: ['b'] })
      .expect(200);
    expect(removed.body.memberOxyUserIds).toEqual(['a', 'c']);
  });

  it('is owner-only', async () => {
    const owner = uniqueId('owner');
    const feedId = await seedFeed({ ownerOxyUserId: owner, title: 'Members' });
    viewer = uniqueId('stranger');
    await request(app).post(`/feeds/${feedId}/members`).send({ userIds: ['a'] }).expect(403);
    expect(await db.select().from(customFeedMembers).where(eq(customFeedMembers.feedId, feedId))).toEqual([]);
  });
});

describe('feed reviews', () => {
  it('recomputes averageRating and ratingsCount FROM THE ROWS on every write', async () => {
    const owner = uniqueId('owner');
    const first = uniqueId('reviewer');
    const second = uniqueId('reviewer');
    const feedId = await seedFeed({ ownerOxyUserId: owner, title: 'Reviewed' });

    viewer = first;
    await request(app).post(`/feeds/${feedId}/reviews`).send({ rating: 5, reviewText: 'great' }).expect(200);
    let [feed] = await db.select().from(customFeeds).where(eq(customFeeds.id, feedId));
    expect(feed.ratingsCount).toBe(1);
    expect(feed.averageRating).toBe(5);

    viewer = second;
    await request(app).post(`/feeds/${feedId}/reviews`).send({ rating: 2 }).expect(200);
    [feed] = await db.select().from(customFeeds).where(eq(customFeeds.id, feedId));
    expect(feed.ratingsCount).toBe(2);
    expect(feed.averageRating).toBe(3.5);
  });

  it('UPDATES an existing review rather than adding a second one', async () => {
    const owner = uniqueId('owner');
    const reviewer = uniqueId('reviewer');
    const feedId = await seedFeed({ ownerOxyUserId: owner, title: 'Reviewed' });

    viewer = reviewer;
    const created = await request(app)
      .post(`/feeds/${feedId}/reviews`)
      .send({ rating: 1, reviewText: 'first take' })
      .expect(200);
    const updated = await request(app)
      .post(`/feeds/${feedId}/reviews`)
      .send({ rating: 4 })
      .expect(200);

    expect(updated.body.id).toBe(created.body.id);
    expect(updated.body.rating).toBe(4);
    // Mongoose stripped an `undefined` from the update document, so an omitted
    // `reviewText` never cleared the previous text. An omitted `set` key is the
    // same behaviour; writing `null` unconditionally would not be.
    expect(updated.body.reviewText).toBe('first take');

    const rows = await db.select().from(feedReviews).where(eq(feedReviews.feedId, feedId));
    expect(rows).toHaveLength(1);
    const [feed] = await db.select().from(customFeeds).where(eq(customFeeds.id, feedId));
    expect(feed.ratingsCount).toBe(1);
    expect(feed.averageRating).toBe(4);
  });

  it('pages reviews and keeps the total correct past the end', async () => {
    const owner = uniqueId('owner');
    const feedId = await seedFeed({ ownerOxyUserId: owner, title: 'Reviewed' });
    for (let index = 0; index < 3; index += 1) {
      viewer = uniqueId('reviewer');
      await request(app).post(`/feeds/${feedId}/reviews`).send({ rating: 3 }).expect(200);
    }

    viewer = undefined;
    const page = await request(app).get(`/feeds/${feedId}/reviews`).query({ page: 1, limit: 2 }).expect(200);
    expect(page.body.reviews).toHaveLength(2);
    expect(page.body.total).toBe(3);
    expect(page.body.reviews[0]._id).toBe(page.body.reviews[0].id);
    expect(page.body.reviews[0].reviewer.id).toBe(page.body.reviews[0].reviewerId);
    expect(page.body.reviews[0]).not.toHaveProperty('reviewText');

    const beyond = await request(app).get(`/feeds/${feedId}/reviews`).query({ page: 99, limit: 2 }).expect(200);
    expect(beyond.body.reviews).toEqual([]);
    expect(beyond.body.total).toBe(3);
    expect(beyond.body.totalPages).toBe(2);
  });

  it('breaks a createdAt tie between reviews by id, so its pages are stable', async () => {
    /**
     * The third offset-paginated listing in this router. Same shape as the two
     * above: two rows tie on `createdAt`, their ids are SUPPLIED so id order and
     * insertion order disagree, and the assertion pins `id desc`.
     */
    const owner = uniqueId('owner');
    const feedId = await seedFeed({ ownerOxyUserId: owner, title: 'Tied reviews' });
    const tied = new Date(80_000);
    await db.insert(feedReviews).values([
      { id: '111111111111111111111111', feedId, reviewerId: uniqueId('r'), rating: 3, createdAt: tied },
      { id: '999999999999999999999999', feedId, reviewerId: uniqueId('r'), rating: 4, createdAt: tied },
    ]);

    viewer = undefined;
    const res = await request(app).get(`/feeds/${feedId}/reviews`).expect(200);
    expect((res.body.reviews as Array<{ id: string }>).map((r) => r.id)).toEqual([
      '999999999999999999999999',
      '111111111111111111111111',
    ]);
  });
});

describe('GET /feeds/generators', () => {
  it('lists only generators mirrored from atproto, with their descriptor', async () => {
    const owner = uniqueId('owner');
    viewer = owner;
    const uri = `at://${randomUUID()}/app.bsky.feed.generator/whats-hot`;
    const [mirrored] = await db
      .insert(feedGenerators)
      .values({
        uri,
        name: 'What is hot',
        algorithm: 'whats-hot',
        createdBy: owner,
        likeCount: 7,
        sourceNetwork: 'atproto',
        sourceServiceDid: 'did:web:example.invalid',
        sourceSyncedAt: new Date(),
      })
      .returning({ id: feedGenerators.id });
    createdGeneratorIds.push(mirrored.id);
    const [native] = await db
      .insert(feedGenerators)
      .values({
        uri: `at://${randomUUID()}/native`,
        name: 'Native',
        algorithm: 'native',
        createdBy: owner,
      })
      .returning({ id: feedGenerators.id });
    createdGeneratorIds.push(native.id);

    const res = await request(app).get('/feeds/generators').query({ userId: owner }).expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      id: mirrored.id,
      uri,
      descriptor: `feedgen|${uri}`,
      title: 'What is hot',
      likeCount: 7,
    });
    // An absent optional is omitted, not `null`.
    expect(res.body.items[0]).not.toHaveProperty('description');
    expect(res.body.items[0]).not.toHaveProperty('avatar');
    expect(res.body.items[0].owner.id).toBe(owner);
  });

  it('requires a userId or mine=true', async () => {
    viewer = undefined;
    await request(app).get('/feeds/generators').expect(400);
  });
});

describe('DELETE /feeds/:id', () => {
  it('removes the feed and every child row', async () => {
    const owner = uniqueId('owner');
    viewer = owner;
    const created = await request(app)
      .post('/feeds')
      .send({ title: 'Doomed', definition: VALID_DEFINITION })
      .expect(201);
    const feedId: string = created.body.id;
    await db.insert(customFeedMembers).values({ feedId, oxyUserId: 'm1', position: 0 });
    await db.insert(feedLikes).values({ userId: uniqueId('liker'), feedId });
    await db.insert(feedReviews).values({ feedId, reviewerId: uniqueId('reviewer'), rating: 4 });

    await request(app).delete(`/feeds/${feedId}`).expect(200);

    expect(await db.select().from(customFeeds).where(eq(customFeeds.id, feedId))).toEqual([]);
    expect(
      await db
        .select()
        .from(customFeedDefinitionModules)
        .where(eq(customFeedDefinitionModules.feedId, feedId)),
    ).toEqual([]);
    expect(await db.select().from(customFeedMembers).where(eq(customFeedMembers.feedId, feedId))).toEqual([]);
    expect(await db.select().from(feedLikes).where(eq(feedLikes.feedId, feedId))).toEqual([]);
    expect(await db.select().from(feedReviews).where(eq(feedReviews.feedId, feedId))).toEqual([]);
  });

  it('is owner-only', async () => {
    const owner = uniqueId('owner');
    const feedId = await seedFeed({ ownerOxyUserId: owner, title: 'Safe' });
    viewer = uniqueId('stranger');
    await request(app).delete(`/feeds/${feedId}`).expect(403);
    expect(await db.select().from(customFeeds).where(eq(customFeeds.id, feedId))).toHaveLength(1);
  });
});
