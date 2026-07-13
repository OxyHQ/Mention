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
const VIEWER_ID = 'oxy-viewer';
const POST_ID = '650000000000000000000010';

const { getUsersByIds, getUserFollowing, getUserFollowers } = vi.hoisted(() => ({
  getUsersByIds: vi.fn(),
  getUserFollowing: vi.fn(async () => ({ following: [] })),
  getUserFollowers: vi.fn(async () => ({ followers: [] })),
}));

// The default (server singleton) oxy client — used by hydration only when the
// caller supplies no per-request client. We pass an explicit spy client below, so
// this is just here to keep the import side-effect-free.
vi.mock('../../../server', () => ({
  oxy: { getUserFollowing, getUserFollowers, getUserById: vi.fn() },
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUsersByIds,
    getLinkPreviews: vi.fn(async () => ({})),
    getFileDownloadUrl: (id: string) => `https://cdn.test/${id}`,
  }),
}));

vi.mock('../../utils/privacyHelpers', () => ({
  getBlockedUserIds: vi.fn(async () => []),
  getRestrictedUserIds: vi.fn(async () => []),
  // Real extraction so a threaded/fetched list maps to ids faithfully.
  extractFollowingIds: (res: unknown) =>
    Array.isArray((res as { following?: unknown[] })?.following) ? (res as { following: string[] }).following : [],
  extractFollowersIds: (res: unknown) =>
    Array.isArray((res as { followers?: unknown[] })?.followers) ? (res as { followers: string[] }).followers : [],
}));

function chainable(rows: unknown[] | null) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'sort', 'limit', 'maxTimeMS']) {
    q[m] = () => q;
  }
  q.lean = async () => rows;
  q.then = undefined;
  return q;
}

vi.mock('../../models/Post', () => ({
  Post: { find: () => chainable([]), findOne: () => chainable(null) },
}));
vi.mock('../../models/Poll', () => ({ default: { find: () => chainable([]) } }));
vi.mock('../../models/Like', () => ({ default: { find: () => chainable([]) } }));
vi.mock('../../models/Bookmark', () => ({ default: { find: () => chainable([]) } }));
vi.mock('../../models/UserSettings', () => ({
  UserSettings: { find: () => chainable([]), findOne: () => chainable(null) },
}));
vi.mock('../../models/FederatedActor', () => ({
  FederatedActor: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
  default: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
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
