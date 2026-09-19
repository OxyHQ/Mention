/**
 * `GET /hashtags/` is cached, and the cache is the whole point of the route's
 * cost profile.
 *
 * The handler runs THREE `unnest` + `GROUP BY` aggregates over every public
 * tagged post in the window — ~454ms measured on 400k posts, all of it a
 * sequential scan — and the search screen subscribes to it on mount and polls
 * it every five minutes, so it competes with the viewer's first search.
 *
 * Nothing tested this endpoint at all before (only its `/search` sub-route had
 * coverage), so adding the cache without these cases would have been a silent
 * behaviour change to a 454ms path: the whole suite passes either way.
 *
 * ## Why the cache is proved BEHAVIOURALLY, not with a spy
 *
 * A spy on the compute would assert that the handler called a function. What
 * matters is that a second identical request does not touch the database, and
 * the way to know that without trusting a mock is to make the database ANSWER
 * DIFFERENTLY between the two requests: seed, request, delete the rows, request
 * again. A cached second response still carries the deleted tag; an uncached one
 * cannot. That distinction is invisible to a spy and is exactly the property the
 * route now depends on.
 */

import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * An in-memory Redis, implementing exactly the six operations `utils/cache.ts`
 * uses. Mocking the client is this repository's convention for testing
 * cache-dependent behaviour (see `feedViewCounter.test.ts`), and here it is
 * also what makes the test MEAN anything: `createCache` is fail-open, so
 * against an unreachable Redis every read is a miss, every write a no-op, and a
 * caching test would pass whether or not the caching existed.
 *
 * It is per-FILE, which removes a hazard a real Redis would carry: the cache
 * key is global by design (no scope token, because the value is shared across
 * viewers), so a real Redis would let entries leak between test files running
 * against different throwaway databases.
 *
 * TTL is tracked but not expired — nothing here tests expiry, and a fake clock
 * would add a second thing to get wrong.
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
  // `cache.ts` imports exactly these two from `utils/redis`; anything else the
  // module exports is unused on this path, so the mock stays this small.
  reportRedisConnectionFailure: vi.fn(),
}));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import { forgetTrendingHashtags } from '../../services/trendingHashtagsCache';

import hashtagsRoutes, { TRENDING_HASHTAG_LIMIT } from '../../routes/hashtags';

const app = express();
app.use(express.json());
app.use('/hashtags', hashtagsRoutes);

const scope = postScope('trending-hashtags-cache');

/** A tag unique to this file: one database serves the whole parallel run. */
const TAG = 'trendcachefixture';

/**
 * Each case uses its OWN `days`, and that is not cosmetic.
 *
 * The cache key is `(limit, days)` and carries no scope token — deliberately,
 * because the value is global and shared across viewers. Two cases sharing a
 * pair would see each other's entry, and the failure would read as flakiness
 * rather than as the cache working.
 *
 * `days` and not `limit`: the route clamps `limit` to `TRENDING_HASHTAG_LIMIT`
 * (10), so 31/32/33 all collapse to the SAME key. The first draft of this file
 * used distinct limits for isolation and they silently were not distinct.
 */
const WINDOWS = { cached: 91, keyed: 92, shape: 93 } as const;

/**
 * Enough posts carrying the tag that it reliably ranks inside the top ten.
 *
 * One database serves the whole parallel run and this endpoint ranks across
 * every public post in it, so a tag on a single post is not guaranteed a place
 * in a ten-row list. Other suites' fixtures carry a handful of posts each; this
 * outranks them rather than hoping.
 */
const POSTS_WITH_TAG = 15;

async function seedTaggedPosts(): Promise<void> {
  for (let index = 0; index < POSTS_WITH_TAG; index += 1) {
    await seedPost(scope, {
      content: { variants: [{ source: 'author', text: `a trending probe ${index} #${TAG}`, tag: 'en' }] },
      hashtags: [TAG],
    });
  }
}

interface TrendingBody {
  hashtags: Array<{ id: string; count: number; created_at: unknown; direction?: string }>;
}

async function trending(days: number): Promise<TrendingBody> {
  const res = await request(app).get('/hashtags').query({ days: String(days) }).expect(200);
  return res.body as TrendingBody;
}

describe('GET /hashtags/ — the trending cache', () => {
  beforeAll(async () => {
    await connectPostgres();
  });

  afterEach(async () => {
    await clearPostScope(scope);
    await Promise.all(
      Object.values(WINDOWS).map((days) => forgetTrendingHashtags(TRENDING_HASHTAG_LIMIT, days)),
    );
    // Belt to the `forgetTrendingHashtags` braces: that only clears the pairs
    // this file names, and a case that adds a window would otherwise inherit
    // a stale entry.
    store.clear();
  });

  afterAll(async () => {
    await closePostgres();
  });

  it('serves a second identical request without re-reading the posts', async () => {
    await seedTaggedPosts();

    const first = await trending(WINDOWS.cached);
    expect(first.hashtags.map((row) => row.id)).toContain(TAG);

    // The rows are gone. An UNCACHED recomputation cannot return the tag; only
    // a cache hit can. This is the assertion the whole change rests on, and it
    // fails the moment the caching is removed.
    await clearPostScope(scope);

    const second = await trending(WINDOWS.cached);
    expect(second.hashtags.map((row) => row.id)).toContain(TAG);
    expect(second).toEqual(first);
  });

  it('does not serve one window to a caller who asked for another', async () => {
    await seedTaggedPosts();

    // Warm one window, delete the rows, then ask for a DIFFERENT window. `days`
    // is part of the key, so the second request must compute rather than reuse
    // — collapsing them would hand one window's ranking to another window's
    // caller, which is a WRONG answer rather than a stale one.
    const warmed = await trending(WINDOWS.keyed);
    expect(warmed.hashtags.map((row) => row.id)).toContain(TAG);
    await clearPostScope(scope);

    const other = await trending(WINDOWS.shape);
    expect(other.hashtags.map((row) => row.id)).not.toContain(TAG);
  });

  it('serializes created_at identically on the cold and the warm path', async () => {
    await seedTaggedPosts();

    // The value round-trips through JSON in Redis, so a cached entry returns a
    // string while a freshly computed one would return a `Date` unless the
    // handler converts on the way IN. `res.json` renders both the same, so the
    // wire format would look correct either way and only the in-process type
    // would differ — the kind of divergence that surfaces months later in a
    // consumer that does arithmetic on it.
    const cold = await trending(WINDOWS.cached);
    const warm = await trending(WINDOWS.cached);

    const coldRow = cold.hashtags.find((row) => row.id === TAG);
    const warmRow = warm.hashtags.find((row) => row.id === TAG);
    expect(typeof coldRow?.created_at).toBe('string');
    expect(typeof warmRow?.created_at).toBe('string');
    expect(warmRow?.created_at).toBe(coldRow?.created_at);
  });
});
