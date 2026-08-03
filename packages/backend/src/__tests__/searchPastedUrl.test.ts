/**
 * Two production failures on `GET /search`, both reached the client as a 500.
 *
 * A pasted URL was handed straight to Mongo's `$text`, which TOKENISES it — so
 * `https://x.com/thinkymachines` became roughly `https OR x.com OR
 * thinkymachines`, and `https` alone matches a large share of every post ever
 * written. Sorted by `createdAt` rather than text score, Mongo had to collect
 * every match before ordering, so the query blew through `maxTimeMS` (observed
 * at 3017/3036/3119/3078 ms against a 3_000 ms cap) and threw. The quieter half
 * is that whenever it did NOT time out it answered with noise: posts containing
 * the word "https", presented as matches for what was pasted.
 *
 * The timeout then surfaced as a 500, which reads as "the server is broken" and
 * puts a capacity limit behind the same status as a genuine crash.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const find = vi.fn();

vi.mock('../models/Post', () => ({
  default: { find: (...args: unknown[]) => find(...args) },
}));
vi.mock('../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async () => []) },
}));
vi.mock('../utils/oxyHelpers', () => ({ createScopedOxyClient: vi.fn(() => ({})) }));
vi.mock('../runtime/oxyClient', () => ({
  getRuntimeOxyClient: vi.fn(() => ({ getProfileByUsername: vi.fn(async () => null) })),
}));
vi.mock('../services/safety/viewerSafety', () => ({
  loadShowSensitiveContent: vi.fn(async () => true),
  loadMuteWords: vi.fn(async () => []),
}));
vi.mock('../services/viewerFollowGraph', () => ({ loadFollowedAuthorIds: vi.fn(async () => new Set()) }));

/** A `Post.find(...)` chain that resolves to no rows, capturing the filter. */
function chainResolving(rows: unknown[] = []) {
  const chain = {
    select: () => chain,
    sort: () => chain,
    limit: () => chain,
    maxTimeMS: () => chain,
    lean: async () => rows,
  };
  return chain;
}

/** A chain whose terminal read throws Mongo's MaxTimeMSExpired (code 50). */
function chainTimingOut() {
  const chain = {
    select: () => chain,
    sort: () => chain,
    limit: () => chain,
    maxTimeMS: () => chain,
    lean: async () => {
      const err = new Error('operation exceeded time limit') as Error & { code: number };
      err.name = 'MongoServerError';
      err.code = 50;
      throw err;
    },
  };
  return chain;
}

async function makeApp() {
  const { default: searchRouter } = await import('../routes/search');
  const app = express();
  app.use('/search', searchRouter);
  return app;
}

describe('GET /search with a pasted URL', () => {
  beforeEach(() => {
    find.mockReset();
  });

  it('never builds a $text query out of a URL, and answers immediately', async () => {
    find.mockImplementation(() => chainResolving());
    const app = await makeApp();

    const res = await request(app)
      .get('/search')
      .query({ query: 'https://x.com/thinkymachines', type: 'posts' });

    expect(res.status).toBe(200);
    expect(res.body.posts).toEqual([]);
    // The load-bearing assertion. An empty result set alone would ALSO be
    // produced by a route that ran the expensive query and matched nothing, so
    // asserting the body cannot tell the fix from the bug — only the absence of
    // the database call can.
    expect(find).not.toHaveBeenCalled();
  });

  /**
   * The control. Without it, "no $text was built" is satisfied by a route that
   * builds no query for ANY input — a dead endpoint would pass the case above.
   */
  it('still builds a $text query for an ordinary search term', async () => {
    find.mockImplementation(() => chainResolving());
    const app = await makeApp();

    const res = await request(app).get('/search').query({ query: 'thinkymachines', type: 'posts' });

    expect(res.status).toBe(200);
    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0][0]).toMatchObject({ $text: { $search: 'thinkymachines' } });
  });

  it('treats a URL as a URL regardless of scheme case or trailing path', async () => {
    find.mockImplementation(() => chainResolving());
    const app = await makeApp();

    for (const query of ['HTTPS://X.com/foo', 'http://mastodon.social/@alice']) {
      find.mockClear();
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).get('/search').query({ query, type: 'posts' });
      expect(res.status).toBe(200);
      expect(find).not.toHaveBeenCalled();
    }
  });

  it('answers a query that runs out of time with 503, not 500', async () => {
    find.mockImplementation(() => chainTimingOut());
    const app = await makeApp();

    const res = await request(app).get('/search').query({ query: 'something expensive', type: 'posts' });

    expect(res.status).toBe(503);
    expect(res.body.message).toBe('Search timed out');
  });

  it('still answers 500 for a fault that is NOT a timeout', async () => {
    // Distinguishes "classified the timeout" from "stopped returning 500 at all".
    find.mockImplementation(() => {
      throw new Error('something genuinely broken');
    });
    const app = await makeApp();

    const res = await request(app).get('/search').query({ query: 'ordinary', type: 'posts' });

    expect(res.status).toBe(500);
  });
});
