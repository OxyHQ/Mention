import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CachedUserSummary } from '../../services/userSummaryCache';

/**
 * Hydration-side of the Phase-2 "resolve the viewer graph once" invariant.
 *
 * When the feed threads a pre-resolved `viewerGraph` into hydration,
 * `buildViewerContext` MUST populate its follows/followedBy sets from those ids
 * and NOT re-fetch `getUserFollowing`/`getUserFollowers` from Oxy (the feed
 * already resolved them once in `loadViewerFeedContext`). Non-feed callers pass
 * no `viewerGraph` and MUST keep the live Oxy fetch. This asserts both by spying
 * on the per-request oxy client's graph methods.
 */

const AUTHOR_OXY_ID = 'oxy-author';
/**
 * A viewer nobody else has used: the graph reads are cached per viewer, so a
 * fixed id would let the first case answer the later ones and the Oxy call
 * counts below would assert nothing.
 */
const VIEWER_ID = `oxy-viewer-${randomUUID()}`;
const POST_ID = '650000000000000000000010';

const { getUsersByIds, getUserFollowing, getUserFollowers } = vi.hoisted(() => ({
  getUsersByIds: vi.fn(),
  getUserFollowing: vi.fn(async () => ({ following: [] })),
  getUserFollowers: vi.fn(async () => ({ followers: [] })),
}));

// The default (server singleton) oxy client — used by hydration only when the
// caller supplies no per-request client. We pass an explicit spy client below, so
// this is just here to keep the import side-effect-free.
vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({ getUserFollowing, getUserFollowers, getUserById: vi.fn() }),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUsersByIds,
    getClarityDocuments: vi.fn(async () => ({})),
    getFileDownloadUrl: (id: string) => `https://cdn.test/${id}`,
  }),
}));

/**
 * The REAL module with only the two authoritative privacy reads stubbed to
 * "nobody blocked". A wholesale literal stopped covering the module as it grew:
 * the viewer's follow-graph reads live here now (cached per viewer), and a
 * partial mock answered them with `undefined`, which the caller's soft-fail
 * turned into "follows nobody". Everything real here is pure id-shape logic plus
 * a fail-open cache, so keeping it real costs nothing and cannot drift again.
 */
vi.mock('../../utils/privacyHelpers', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../utils/privacyHelpers')>(),
  getBlockedUserIds: vi.fn(async () => []),
  getRestrictedUserIds: vi.fn(async () => []),
}));

const cacheStore = new Map<string, CachedUserSummary>();
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

import { randomUUID } from 'node:crypto';

import { PostHydrationService } from '../../services/PostHydrationService';

function makePostRow() {
  return {
    _id: POST_ID,
    oxyUserId: AUTHOR_OXY_ID,
    authorship: [{ oxyUserId: AUTHOR_OXY_ID, role: 'owner', status: 'accepted' }],
    type: 'post',
    content: { text: 'hello world' },
    stats: { likesCount: 0, boostsCount: 0, commentsCount: 0, downvotesCount: 0, viewsCount: 0 },
    metadata: { createdAt: new Date('2024-01-01T00:00:00Z') },
    createdAt: new Date('2024-01-01T00:00:00Z'),
    visibility: 'public',
    hashtags: [],
    mentions: [],
  };
}

/** A per-request oxy client whose graph methods are spied for call-count asserts. */
function makeSpyClient() {
  return {
    getUserFollowing: vi.fn(async () => ({ following: [AUTHOR_OXY_ID] })),
    getUserFollowers: vi.fn(async () => ({ followers: [] })),
    getBlockedUsers: vi.fn(async () => []),
    getRestrictedUsers: vi.fn(async () => []),
  };
}

describe('PostHydrationService — viewer-graph threading', () => {
  let service: PostHydrationService;

  beforeEach(() => {
    cacheStore.clear();
    getUsersByIds.mockReset();
    getUsersByIds.mockResolvedValue([
      { id: AUTHOR_OXY_ID, username: 'author', name: { displayName: 'Author' }, badges: [], verified: false },
    ]);
    getUserFollowing.mockClear();
    getUserFollowers.mockClear();
    service = new PostHydrationService();
  });

  it('skips the Oxy graph fetch when a viewerGraph is threaded in', async () => {
    const client = makeSpyClient();

    const [hydrated] = await service.hydratePosts([makePostRow()], {
      viewerId: VIEWER_ID,
      oxyClient: client as never,
      viewerGraph: { followingIds: [AUTHOR_OXY_ID], followerIds: ['someone'] },
    });

    expect(hydrated).toBeDefined();
    // The threaded graph is used directly — no re-fetch.
    expect(client.getUserFollowing).not.toHaveBeenCalled();
    expect(client.getUserFollowers).not.toHaveBeenCalled();
  });

  it('falls back to the live Oxy fetch for non-feed callers (no viewerGraph)', async () => {
    const client = makeSpyClient();

    const [hydrated] = await service.hydratePosts([makePostRow()], {
      viewerId: VIEWER_ID,
      oxyClient: client as never,
    });

    expect(hydrated).toBeDefined();
    // No threaded graph → hydration resolves the viewer graph itself, once each.
    expect(client.getUserFollowing).toHaveBeenCalledTimes(1);
    expect(client.getUserFollowers).toHaveBeenCalledTimes(1);
  });
});
