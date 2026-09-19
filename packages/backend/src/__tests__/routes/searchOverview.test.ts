/**
 * `GET /search/overview` — the one-request fan-out.
 *
 * ## What these cases are actually defending
 *
 * The endpoint replaces seven client requests across three hosts, and the
 * failure it exists to prevent is not slowness — it is a lane's failure being
 * indistinguishable from a lane's emptiness. `Promise.allSettled` on the client
 * threw that distinction away, so a broken lane rendered as a confident "no
 * results". Moving the fan-out server-side without pinning the statuses would
 * have carried the defect across, so most of this file is about statuses rather
 * than about results.
 */

import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SearchOverviewResponse } from '@mention/shared-types';

/**
 * An in-memory Redis, implementing exactly the operations `utils/cache.ts`
 * uses.
 *
 * `createCache` is fail-open, so against the unreachable Redis of a test run
 * every read is a miss and every write a no-op — the cache assertions below
 * would pass whether or not the caching existed. Mocking the client is this
 * repository's convention (`feedViewCounter.test.ts`) and here it is also what
 * makes those cases mean anything.
 */
const store = new Map<string, string>();

vi.mock('../../utils/redis', () => ({
  getRedisClient: () => ({
    isReady: true,
    isOpen: true,
    connect: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue('PONG'),
    get: async (key: string) => store.get(key) ?? null,
    mGet: async (keys: string[]) => keys.map((key) => store.get(key) ?? null),
    setEx: async (key: string, _ttl: number, value: string) => { store.set(key, value); },
    del: async (keys: string[]) => { for (const key of keys) store.delete(key); },
    exists: async (key: string) => (store.has(key) ? 1 : 0),
    multi: () => {
      const queued: Array<[string, string]> = [];
      const chain = {
        setEx: (key: string, _ttl: number, value: string) => { queued.push([key, value]); return chain; },
        exec: async () => { for (const [key, value] of queued) store.set(key, value); },
      };
      return chain;
    },
  }),
  reportRedisConnectionFailure: vi.fn(),
}));

/** Owners resolve through Oxy; stubbed so a lane's byline is deterministic. */
vi.mock('../../services/PostHydrationService', async () => {
  const actual = await vi.importActual<typeof import('../../services/PostHydrationService')>(
    '../../services/PostHydrationService',
  );
  return {
    ...actual,
    resolveUserSummaries: vi.fn(async (ids: string[]) =>
      new Map(ids.map((id) => [id, { user: { id, username: `u_${id.slice(-4)}`, name: { displayName: `User ${id.slice(-4)}` } } }])),
    ),
  };
});

import { eq } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { accountLists, starterPacks } from '../../db/schema/lists';
import { customFeeds } from '../../db/schema/feeds';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import { forgetSharedLanes } from '../../services/search/searchOverviewCache';
import { SEARCH_OVERVIEW_LANE_LIMIT } from '@mention/shared-types';

import searchOverviewRoutes from '../../routes/searchOverview';

const scope = postScope('search-overview');

/** A term no other suite's fixtures can match. */
const TERM = 'zovertermq';

const VIEWER = 'search-overview-viewer';

let app: Express;
let anonymousApp: Express;
const createdIds: { lists: string[]; feeds: string[]; packs: string[] } = { lists: [], feeds: [], packs: [] };

async function seedLane(): Promise<void> {
  const [list] = await getDb()
    .insert(accountLists)
    .values({ ownerOxyUserId: 'owner-list', title: `A ${TERM} list`, isPublic: true })
    .returning({ id: accountLists.id });
  createdIds.lists.push(list.id);

  const [feed] = await getDb()
    .insert(customFeeds)
    .values({ ownerOxyUserId: 'owner-feed', title: `A ${TERM} feed`, isPublic: true })
    .returning({ id: customFeeds.id });
  createdIds.feeds.push(feed.id);

  const [pack] = await getDb()
    .insert(starterPacks)
    .values({ ownerOxyUserId: 'owner-pack', name: `A ${TERM} pack` })
    .returning({ id: starterPacks.id });
  createdIds.packs.push(pack.id);

  await seedPost(scope, {
    content: { variants: [{ source: 'author', text: `tagged #${TERM}`, tag: 'en' }] },
    hashtags: [TERM],
  });
}

async function overview(client: Express, query: string): Promise<SearchOverviewResponse> {
  const res = await request(client).get('/search/overview').query({ q: query }).expect(200);
  return res.body as SearchOverviewResponse;
}

beforeAll(async () => {
  await connectPostgres();
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { id: string } }).user = { id: VIEWER };
    next();
  });
  app.use('/search', searchOverviewRoutes);

  anonymousApp = express();
  anonymousApp.use(express.json());
  anonymousApp.use('/search', searchOverviewRoutes);
});

afterEach(async () => {
  await clearPostScope(scope);
  const db = getDb();
  for (const id of createdIds.lists) await db.delete(accountLists).where(eq(accountLists.id, id));
  for (const id of createdIds.feeds) await db.delete(customFeeds).where(eq(customFeeds.id, id));
  for (const id of createdIds.packs) await db.delete(starterPacks).where(eq(starterPacks.id, id));
  createdIds.lists = [];
  createdIds.feeds = [];
  createdIds.packs = [];
  await forgetSharedLanes(TERM, SEARCH_OVERVIEW_LANE_LIMIT);
  store.clear();
});

afterAll(async () => {
  await closePostgres();
});

describe('GET /search/overview', () => {
  it('answers every lane in ONE request, each with a status', async () => {
    await seedLane();

    const body = await overview(app, TERM);

    // The contract's core promise: a TOTAL map. A client can read every key
    // without checking whether it exists.
    expect(Object.keys(body.lanes).sort()).toEqual([
      'feeds', 'hashtags', 'lists', 'posts', 'profiles', 'saved', 'starterPacks',
    ]);
    expect(body.query).toBe(TERM);

    for (const lane of ['hashtags', 'lists', 'feeds', 'starterPacks'] as const) {
      expect(body.lanes[lane].status, `lane ${lane}`).toBe('ok');
      expect(body.lanes[lane].items.length, `lane ${lane}`).toBeGreaterThan(0);
      expect(typeof body.lanes[lane].tookMs).toBe('number');
    }
  });

  it('marks the lanes it does not serve, distinguishing skipped from unavailable', async () => {
    await seedLane();

    const body = await overview(app, TERM);

    // `profiles` is Oxy's and there is nothing to fetch here.
    expect(body.lanes.profiles.status).toBe('skipped');
    // `posts` and `saved` still need a separate request, which is a different
    // instruction to the client than "there is nothing here".
    expect(body.lanes.posts.status).toBe('unavailable');
    expect(body.lanes.saved.status).toBe('unavailable');
  });

  it('answers an anonymous viewer with the public lanes rather than a 401', async () => {
    await seedLane();

    // `GET /search` is mounted on the authenticated API, which is why the client
    // carries a `canUsePrivateApi` gate and skips three lanes until the session
    // lands. The overview must not inherit that.
    const body = await overview(anonymousApp, TERM);

    expect(body.lanes.hashtags.status).toBe('ok');
    expect(body.lanes.feeds.items.length).toBeGreaterThan(0);
    expect(body.lanes.lists.status).toBe('ok');
  });

  it('serves the viewer-independent lanes from cache on a second request', async () => {
    await seedLane();

    const first = await overview(app, TERM);
    expect(first.servedFromCache).toBe(false);
    expect(first.lanes.feeds.items.length).toBeGreaterThan(0);

    const second = await overview(app, TERM);
    expect(second.servedFromCache).toBe(true);
    // Proved BEHAVIOURALLY, not from the flag alone: the rows are gone, so an
    // uncached recomputation could not return them.
    expect(second.lanes.feeds.items).toEqual(first.lanes.feeds.items);
  });

  it('does not cache the lists lane, which mixes in the viewer\'s own rows', async () => {
    // A private list owned by the viewer must never reach another viewer
    // through a shared entry — which is why `lists` is computed per request.
    const [privateList] = await getDb()
      .insert(accountLists)
      .values({ ownerOxyUserId: VIEWER, title: `A private ${TERM} list`, isPublic: false })
      .returning({ id: accountLists.id });
    createdIds.lists.push(privateList.id);

    const mine = await overview(app, TERM);
    expect(mine.lanes.lists.items.map((row) => (row as { id: string }).id)).toContain(privateList.id);

    // Same term, so the SHARED lanes come from cache — and the private list
    // must still not appear for someone else.
    const theirs = await overview(anonymousApp, TERM);
    expect(theirs.lanes.lists.items.map((row) => (row as { id: string }).id)).not.toContain(privateList.id);
  });

  it('is not degraded just because a lane was deliberately skipped', async () => {
    await seedLane();

    const body = await overview(app, TERM);

    // `profiles` is always skipped today, so counting `skipped` as degraded
    // would make the flag true on every single search and mean nothing.
    // `posts`/`saved` are `unavailable`, which IS degraded — the viewer is
    // missing something they should have.
    expect(body.degraded).toBe(true);
    expect(body.lanes.profiles.status).toBe('skipped');
  });

  it('answers an empty query with the same shape, not an error', async () => {
    const res = await request(app).get('/search/overview').query({ q: '   ' }).expect(200);
    const body = res.body as SearchOverviewResponse;

    expect(body.query).toBe('');
    // One code path for the client whether or not it had a term.
    for (const lane of Object.values(body.lanes)) {
      expect(lane.items).toEqual([]);
      expect(lane.status).toBe('skipped');
    }
  });
});
