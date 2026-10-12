/**
 * `GET /posts/:id` must resolve the viewer's block/restrict list and follow
 * graph exactly ONCE per request.
 *
 * `getPostById` resolves all four (`resolveViewerPrivacyAndGraph`) and threads
 * the result into `hydratePosts` as `viewerPrivacy`/`viewerGraph`. If a future
 * change stops threading either one, `PostHydrationService.buildViewerContext`
 * falls back to fetching it AGAIN, on the SAME `oxyClient` instance — so the
 * regression this guards against shows up as a call count of 2, not 1.
 *
 * The four are spied on the OXY CLIENT itself, not on `utils/privacyHelpers`:
 * `resolveViewerPrivacyAndGraph` and `buildViewerContext`'s fallback both call
 * `getBlockedUserIds`/`getRestrictedUserIds` internally, as same-module
 * references — mocking the module would spy on the export table, which
 * neither of those internal calls goes through. The client passed in IS under
 * this test's control, so it is where the real double-fetch would show.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CachedUserSummary } from '../../services/userSummaryCache';

const { getUsersByIds, cacheStore } = vi.hoisted(() => ({
  getUsersByIds: vi.fn(),
  cacheStore: new Map<string, CachedUserSummary>(),
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
    getClarityDocuments: vi.fn(async () => ({})),
    assets: { publicUrl: (id: string) => `https://cdn.test/${id}` },
  }),
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

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import { getPostById } from '../../controllers/posts/readPosts';

const scope = postScope('post-detail-oxy-call-budget');
const VIEWER = scope.user('viewer');

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  cacheStore.clear();
  getUsersByIds.mockReset();
  getUsersByIds.mockImplementation(async (ids: string[]) =>
    ids.map((id) => ({ id, username: id, name: { displayName: id }, badges: [], verified: false })),
  );
  oxyClient.privacy.blocked.mockClear();
  oxyClient.privacy.restricted.mockClear();
  oxyClient.follows.following.mockClear();
  oxyClient.follows.followers.mockClear();
});

afterEach(async () => {
  await clearPostScope(scope);
});

function makeReq(postId: string) {
  return { user: { id: VIEWER }, params: { id: postId }, query: {} } as never;
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

describe('GET /posts/:id — viewer privacy/graph call budget', () => {
  it('fetches blocked/restricted/following/followers exactly once each', async () => {
    const post = await seedPost(scope);
    const res = makeRes();

    await getPostById(makeReq(post.id) as never, res as never);

    expect(res.statusCode).toBe(200);
    expect((res.body as { id?: string } | undefined)?.id).toBe(post.id);
    expect(oxyClient.privacy.blocked).toHaveBeenCalledTimes(1);
    expect(oxyClient.privacy.restricted).toHaveBeenCalledTimes(1);
    expect(oxyClient.follows.following).toHaveBeenCalledTimes(1);
    expect(oxyClient.follows.followers).toHaveBeenCalledTimes(1);
  });
});
