/**
 * The sitemaps are built in one pass by the leader and only READ by requests.
 *
 * Each child sitemap used to be built on demand by a query that read the whole
 * eligible half of `posts` to keep one bucket in 64 (~30 s for a profile
 * shard, ~18 s for a post shard in production), and a crawler walking the index
 * rebuilt them at ~50 an hour — 70% of Mention's database load (#1160).
 *
 * Asserted against real post rows:
 *  - before any build, every sitemap URL answers 503 and nothing reaches Oxy
 *    (and so nothing reached the database's sitemap reads either: the build is
 *    the only caller of both);
 *  - `buildAllSitemaps` lists a public post and its author, and leaves out a
 *    private post and an author Oxy does not return;
 *  - a shard the catalog does not list is a 404, not a build;
 *  - a fresh catalog is not rebuilt by the job.
 *
 * Redis is replaced by an in-memory store: `__tests__/setup.ts` mocks the real
 * client as never ready, which would make every read a miss.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { PostVisibility } from '@mention/shared-types';

const { makeServiceRequest, store } = vi.hoisted(() => ({
  makeServiceRequest: vi.fn(),
  store: new Map<string, unknown>(),
}));

vi.mock('../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ makeServiceRequest }),
}));

vi.mock('../utils/cache', () => ({
  createCache: () => ({
    get: async (key: string) => store.get(key),
    getMany: async (keys: string[]) => keys.map((key) => store.get(key)),
    has: async (key: string) => store.has(key),
    // A real round trip's latency: with an instant write the build's own
    // awaits never yield long enough to expose a stream that ends early.
    set: async (key: string, value: unknown) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      store.set(key, value);
    },
    setMany: async (entries: Iterable<readonly [string, unknown]>) => {
      for (const [key, value] of entries) store.set(key, value);
    },
    delete: async (keys: string[]) => {
      for (const key of keys) store.delete(key);
    },
    getOrCompute: async <T>(key: string, compute: () => Promise<T>): Promise<T> => {
      if (store.has(key)) return store.get(key) as T;
      const value = await compute();
      store.set(key, value);
      return value;
    },
  }),
}));

import webShellRoutes from '../routes/webShell.routes';
import { closePostgres, connectPostgres } from '../db/postgres';
import { SitemapBuildJob, buildAllSitemaps, sitemapsAreDue } from '../services/seoSitemap';
import { clearPostScope, postScope, seedPost } from './helpers/postFixtures';

const scope = postScope('seo-sitemap-build');
const AUTHOR = scope.user('author');
const HIDDEN = scope.user('hidden');

function bucketOf(value: string): string {
  return (Number.parseInt(createHash('md5').update(value).digest('hex').slice(0, 8), 16) % 64)
    .toString(16)
    .padStart(2, '0');
}

function makeApp() {
  const app = express();
  app.use('/', webShellRoutes);
  return app;
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  store.clear();
  makeServiceRequest.mockReset();
  // Oxy answers for every requested author except HIDDEN, as its bulk endpoint
  // omits an account that is not publicly discoverable.
  makeServiceRequest.mockImplementation(async (_method: string, _url: string, body: { ids: string[] }) =>
    body.ids
      .filter((id) => id !== HIDDEN)
      .map((id) => ({ id, username: id === AUTHOR ? 'sitemapauthor' : `u${id.length}`, name: { displayName: 'A' } })));
});

afterEach(async () => {
  await clearPostScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('SEO sitemaps', () => {
  it('never builds a sitemap on a request', async () => {
    const app = makeApp();

    const index = await request(app).get('/sitemap.xml');
    const shard = await request(app).get('/sitemaps/posts-00-0.xml');

    expect(index.status).toBe(503);
    expect(index.headers['retry-after']).toBe('900');
    expect(shard.status).toBe(503);
    expect(makeServiceRequest).not.toHaveBeenCalled();
  });

  it('builds every sitemap in one pass and serves them from the cache', async () => {
    const listed = await seedPost(scope, { oxyUserId: AUTHOR, authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }] });
    const privatePost = await seedPost(scope, {
      oxyUserId: AUTHOR,
      authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
      visibility: PostVisibility.PRIVATE,
    });
    const hidden = await seedPost(scope, { oxyUserId: HIDDEN, authorship: [{ oxyUserId: HIDDEN, role: 'owner', status: 'accepted' }] });

    const report = await buildAllSitemaps();
    expect(report.postRows).toBeGreaterThanOrEqual(2);
    // Bulk resolution only: 100 authors per Oxy call, never one per profile.
    expect(makeServiceRequest.mock.calls.every(([method, url]) => method === 'POST' && url === '/users/by-ids')).toBe(true);

    const app = makeApp();
    const index = await request(app).get('/sitemap.xml');
    expect(index.status).toBe(200);
    // The build is finished when it returns: postgres.js does not await the
    // cursor callback for the final batch, and a build that returned early
    // listed a bucket twice and kept adding shards to the catalog afterwards.
    const shards = [...index.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    expect(new Set(shards).size).toBe(shards.length);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await request(app).get('/sitemap.xml')).text).toBe(index.text);
    expect(index.headers['last-modified']).toBeTruthy();
    expect(index.text).toContain(`https://mention.earth/sitemaps/profiles-${bucketOf(AUTHOR)}-0.xml`);
    expect(index.text).toContain(`https://mention.earth/sitemaps/posts-${bucketOf(listed.id)}-0.xml`);

    const postShard = await request(app).get(`/sitemaps/posts-${bucketOf(listed.id)}-0.xml`);
    expect(postShard.status).toBe(200);
    expect(postShard.headers['content-type']).toContain('application/xml');
    expect(postShard.headers['cache-control']).toContain('s-maxage=21600');
    expect(postShard.text).toContain(`https://mention.earth/p/${listed.id}`);
    expect(postShard.text).not.toContain(privatePost.id);

    const hiddenShard = await request(app).get(`/sitemaps/posts-${bucketOf(hidden.id)}-0.xml`);
    expect(hiddenShard.text).not.toContain(hidden.id);

    const profileShard = await request(app).get(`/sitemaps/profiles-${bucketOf(AUTHOR)}-0.xml`);
    expect(profileShard.status).toBe(200);
    expect(profileShard.text).toContain('https://mention.earth/@sitemapauthor');

    // A revalidating crawler gets a 304 without the body.
    const revalidated = await request(app)
      .get(`/sitemaps/posts-${bucketOf(listed.id)}-0.xml`)
      .set('If-None-Match', postShard.headers.etag);
    expect(revalidated.status).toBe(304);

    // A page the catalog does not list is a cheap 404, never a build.
    const callsBefore = makeServiceRequest.mock.calls.length;
    const absent = await request(app).get(`/sitemaps/posts-${bucketOf(listed.id)}-7.xml`);
    expect(absent.status).toBe(404);
    expect(makeServiceRequest.mock.calls.length).toBe(callsBefore);
  });

  it('keeps the previous sitemaps when a build fails', async () => {
    await seedPost(scope, { oxyUserId: AUTHOR, authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }] });
    await buildAllSitemaps();
    const before = (await request(makeApp()).get('/sitemap.xml')).text;

    makeServiceRequest.mockRejectedValue(Object.assign(new Error('HTTP 429: Too Many Requests'), { status: 429 }));
    await expect(buildAllSitemaps()).rejects.toThrow('HTTP 429');

    const after = await request(makeApp()).get('/sitemap.xml');
    expect(after.status).toBe(200);
    expect(after.text).toBe(before);
  });

  it('rebuilds only when the catalog is due, and backs off after a failure', async () => {
    await seedPost(scope, { oxyUserId: AUTHOR, authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }] });
    const job = new SitemapBuildJob();

    expect(await sitemapsAreDue()).toBe(true);
    await job.tick();
    expect(await sitemapsAreDue()).toBe(false);
    const callsAfterBuild = makeServiceRequest.mock.calls.length;
    expect(callsAfterBuild).toBeGreaterThan(0);

    // Fresh: a tick is one cache read.
    await job.tick();
    expect(makeServiceRequest.mock.calls.length).toBe(callsAfterBuild);

    // Due again seven hours later, but Oxy fails: the next tick inside the
    // backoff does not try again.
    const later = Date.now() + 7 * 60 * 60 * 1000;
    makeServiceRequest.mockRejectedValue(new Error('Oxy down'));
    await job.tick(later);
    const callsAfterFailure = makeServiceRequest.mock.calls.length;
    await job.tick(later + 60_000);
    expect(makeServiceRequest.mock.calls.length).toBe(callsAfterFailure);
  });
});
