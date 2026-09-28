/**
 * `POST /posts/documents` and `POST /posts/link-previews` — the two ways the app
 * gets link cards without ever talking to Clarity itself.
 *
 * `/posts/documents` answers for posts whose first read reported
 * `documentsPending`. It must answer only for posts the viewer may read (it
 * hydrates through the same ACL as `GET /posts/:id`), and it may wait on Clarity
 * because it is off the render path.
 *
 * `/posts/link-previews` is the composer's: it resolves the draft's links with the
 * backend's service credentials and withholds a card for a profile on this
 * instance, exactly as hydration does.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CachedUserSummary } from '../../services/userSummaryCache';

const { getUsersByIds, cacheStore, resolve } = vi.hoisted(() => ({
  getUsersByIds: vi.fn(),
  cacheStore: new Map<string, CachedUserSummary>(),
  resolve: vi.fn(),
}));

const oxyClient = {
  privacy: {
    blocked: vi.fn(async () => []),
    restricted: vi.fn(async () => []),
  },
  follows: {
    following: vi.fn(async () => ({ following: [] })),
    followers: vi.fn(async () => ({ followers: [] })),
    viewerGraph: vi.fn(async () => ({})),
  },
};

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: () => oxyClient,
  createUserScopedOxyServices: () => undefined,
  getServiceOxyClient: () => ({
    users: { getMany: getUsersByIds },
    assets: { publicUrl: (id: string) => `https://cdn.test/${id}` },
  }),
}));

vi.mock('../../utils/clarityClient', () => ({
  getClarityClient: async () => ({ indexing: { resolve } }),
}));

vi.mock('../../services/userSummaryCache', () => ({
  mget: vi.fn(async (ids: string[]) => {
    const hits = new Map<string, CachedUserSummary>();
    for (const id of ids) {
      const hit = cacheStore.get(id);
      if (hit) hits.set(id, hit);
    }
    return hits;
  }),
  mset: vi.fn(async (entries: Map<string, CachedUserSummary>) => {
    for (const [id, value] of entries) cacheStore.set(id, value);
  }),
}));

import { PostVisibility } from '@mention/shared-types';
import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import { getPostDocuments, resolveLinkPreviews } from '../../controllers/posts/linkDocuments';

const scope = postScope('link-documents');
const VIEWER = scope.user('viewer');
const ARTICLE = 'https://example.com/article';

function document(url: string, title: string) {
  return { id: `doc:${url}`, canonicalUrl: url, title, type: 'page', status: 'indexed', authors: [], evidence: {} };
}

function makeReq(body: unknown, userId: string | undefined = VIEWER) {
  return { user: userId ? { id: userId } : undefined, params: {}, query: {}, headers: {}, body } as never;
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  cacheStore.clear();
  resolve.mockReset();
  getUsersByIds.mockReset();
  getUsersByIds.mockImplementation(async (ids: string[]) =>
    ids.map((id) => ({ id, username: id, name: { displayName: id }, badges: [], verified: false })),
  );
});

afterEach(async () => {
  await clearPostScope(scope);
});

function withText(text: string) {
  return { content: { variants: [{ source: 'author' as const, text, tag: 'en' }] } };
}

describe('POST /posts/documents', () => {
  it('returns the cards Clarity now has, waiting on it off the render path', async () => {
    resolve.mockResolvedValue({ data: [{ url: ARTICLE, status: 'indexed', document: document(ARTICLE, 'Article') }] });
    const post = await seedPost(scope, withText(`read ${ARTICLE}`));
    const res = makeRes();

    await getPostDocuments(makeReq({ ids: [post.id] }), res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ posts: { [post.id]: { documents: [expect.objectContaining({ title: 'Article' })] } } });
    expect(resolve).toHaveBeenCalledWith({ urls: [ARTICLE], waitMs: 3_000 });
  });

  it('keeps reporting a post pending while Clarity is still indexing it', async () => {
    resolve.mockResolvedValue({ data: [{ url: ARTICLE, status: 'queued' }] });
    const post = await seedPost(scope, withText(`read ${ARTICLE}`));
    const res = makeRes();

    await getPostDocuments(makeReq({ ids: [post.id] }), res as never);

    expect(res.body).toEqual({ posts: { [post.id]: { documents: [], documentsPending: true } } });
  });

  it('answers nothing for a post the viewer may not read', async () => {
    resolve.mockResolvedValue({ data: [{ url: ARTICLE, status: 'indexed', document: document(ARTICLE, 'Secret') }] });
    const hidden = await seedPost(scope, { ...withText(`read ${ARTICLE}`), visibility: PostVisibility.PRIVATE });
    const res = makeRes();

    await getPostDocuments(makeReq({ ids: [hidden.id] }, undefined), res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ posts: {} });
  });

  it('ignores an unknown id', async () => {
    const res = makeRes();
    await getPostDocuments(makeReq({ ids: ['no-such-post'] }), res as never);
    expect(res.body).toEqual({ posts: {} });
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    ['no body', undefined],
    ['no ids', { ids: [] }],
    ['a non-string id', { ids: [42] }],
    ['more than 50 ids', { ids: Array.from({ length: 51 }, (_, index) => `id-${index}`) }],
  ])('rejects %s', async (_label, body) => {
    const res = makeRes();
    await getPostDocuments(makeReq(body), res as never);
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /posts/link-previews', () => {
  it('resolves the draft links through the backend, in request order', async () => {
    const second = 'https://example.org/other';
    resolve.mockImplementation(async ({ urls }: { urls: string[] }) => ({
      data: urls.map((url) => ({ url, status: 'indexed', document: document(url, url) })),
    }));
    const res = makeRes();

    await resolveLinkPreviews(makeReq({ urls: [second, ARTICLE] }), res as never);

    expect(resolve).toHaveBeenCalledWith({ urls: [second, ARTICLE], waitMs: 8_000 });
    expect((res.body as { previews: Array<{ url: string }> }).previews.map((preview) => preview.url))
      .toEqual([second, ARTICLE]);
  });

  it('lists a link Clarity is still indexing as pending', async () => {
    resolve.mockResolvedValue({ data: [{ url: ARTICLE, status: 'queued' }] });
    const res = makeRes();

    await resolveLinkPreviews(makeReq({ urls: [ARTICLE] }), res as never);

    expect(res.body).toEqual({ previews: [], pending: [ARTICLE] });
  });

  it('asks for no card of a profile on this instance', async () => {
    const res = makeRes();

    await resolveLinkPreviews(makeReq({ urls: ['https://mention.earth/@alice'] }), res as never);

    expect(resolve).not.toHaveBeenCalled();
    expect(res.body).toEqual({ previews: [], pending: [] });
  });

  it('drops anything that is not an http(s) URL', async () => {
    const res = makeRes();

    await resolveLinkPreviews(makeReq({ urls: ['javascript:alert(1)', 'not a url'] }), res as never);

    expect(resolve).not.toHaveBeenCalled();
    expect(res.body).toEqual({ previews: [], pending: [] });
  });

  it('rejects more links than a post can carry cards for', async () => {
    const res = makeRes();
    await resolveLinkPreviews(
      makeReq({ urls: Array.from({ length: 5 }, (_, index) => `https://example.com/${index}`) }),
      res as never,
    );
    expect(res.statusCode).toBe(400);
  });
});
