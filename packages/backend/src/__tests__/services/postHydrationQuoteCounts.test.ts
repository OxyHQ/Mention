import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CachedUserSummary } from '../../services/userSummaryCache';

/**
 * `engagement.quotes` — the one engagement counter Mention does NOT denormalize
 * onto `post.stats`. It is counted on read off the `quoteOf` index, so the whole
 * contract is "only when the caller asks":
 *
 *  - `includeQuoteCounts: true` (the post-detail endpoints) → one aggregate for
 *    the whole hydrated batch, `quotes` present on every post;
 *  - default (every feed request) → NO aggregate at all, `quotes` absent.
 *
 * The second half is the load-bearing assertion: if the option ever stops gating
 * the query, feeds silently take an extra collection scan per request and nothing
 * else in the response changes to show it. So the no-flag case asserts the mock
 * was never CALLED, not merely that the field is missing.
 */

const POST_ID = '650000000000000000000011';
const OTHER_POST_ID = '650000000000000000000012';
const AUTHOR_OXY_ID = 'oxy-author';

const { getUserById, getUsersByIds, cacheStore, postFind, postFindOne, postAggregate, userSettingsFindOne } = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getUsersByIds: vi.fn(),
  cacheStore: new Map<string, CachedUserSummary>(),
  postFind: vi.fn(),
  postFindOne: vi.fn(),
  postAggregate: vi.fn(),
  userSettingsFindOne: vi.fn(),
}));

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    getUserById,
    getUserFollowing: vi.fn(async () => []),
    getUserFollowers: vi.fn(async () => []),
  }),
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
  extractFollowingIds: vi.fn(() => []),
  extractFollowersIds: vi.fn(() => []),
}));

/** Chainable Mongoose query stub — every builder method returns itself, `.lean()` resolves the rows. */
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
  Post: {
    find: (...args: unknown[]) => chainable(postFind(...args)),
    findOne: (...args: unknown[]) => chainable(postFindOne(...args)),
    aggregate: (...args: unknown[]) => postAggregate(...args),
  },
}));
vi.mock('../../models/Poll', () => ({ default: { find: () => chainable([]) } }));
vi.mock('../../models/Like', () => ({ default: { find: () => chainable([]) } }));
vi.mock('../../models/Bookmark', () => ({ default: { find: () => chainable([]) } }));
vi.mock('../../models/UserSettings', () => ({
  UserSettings: { find: () => chainable(userSettingsFindOne()), findOne: () => chainable(null) },
}));
vi.mock('../../models/StarterPack', () => ({
  StarterPack: { aggregate: async () => [] },
  default: { aggregate: async () => [] },
}));
vi.mock('../../models/FederatedActor', () => ({
  FederatedActor: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
  default: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
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

import { PostHydrationService } from '../../services/PostHydrationService';

function postRow(id: string) {
  return {
    _id: id,
    oxyUserId: AUTHOR_OXY_ID,
    authorship: [{ oxyUserId: AUTHOR_OXY_ID, role: 'owner', status: 'accepted' }],
    type: 'post',
    content: { variants: [{ tag: 'en', source: 'author', text: 'a quotable note' }] },
    stats: { likesCount: 3, boostsCount: 1, commentsCount: 0, downvotesCount: 0, savesCount: 2, viewsCount: 7 },
    metadata: { createdAt: new Date('2024-02-01T00:00:00Z') },
    createdAt: new Date('2024-02-01T00:00:00Z'),
    visibility: 'public',
    hashtags: [],
    mentions: [],
  };
}

describe('PostHydrationService — quote counts', () => {
  let service: PostHydrationService;

  beforeEach(() => {
    cacheStore.clear();
    getUserById.mockReset();
    getUsersByIds.mockReset();
    postFind.mockReset();
    postFindOne.mockReset();
    postAggregate.mockReset();
    userSettingsFindOne.mockReset();

    postFind.mockReturnValue([]);
    postFindOne.mockReturnValue(null);
    postAggregate.mockResolvedValue([]);
    userSettingsFindOne.mockReturnValue([]);
    getUsersByIds.mockResolvedValue([
      { id: AUTHOR_OXY_ID, username: 'author', name: { displayName: 'Author' }, badges: [], verified: false },
    ]);
    getUserById.mockResolvedValue(null);

    service = new PostHydrationService();
  });

  it('counts quotes per post in ONE aggregate when the caller asks for them', async () => {
    postAggregate.mockResolvedValue([
      { _id: POST_ID, count: 2 },
      { _id: OTHER_POST_ID, count: 9 },
    ]);

    const hydrated = await service.hydratePosts([postRow(POST_ID), postRow(OTHER_POST_ID)], {
      maxDepth: 0,
      includeQuoteCounts: true,
    });

    expect(hydrated.map((p) => p.engagement.quotes)).toEqual([2, 9]);
    expect(postAggregate).toHaveBeenCalledTimes(1);
    expect(postAggregate).toHaveBeenCalledWith([
      { $match: { quoteOf: { $in: [POST_ID, OTHER_POST_ID] } } },
      { $group: { _id: '$quoteOf', count: { $sum: 1 } } },
    ]);
  });

  it('reports zero for a post no aggregate row mentions', async () => {
    postAggregate.mockResolvedValue([{ _id: OTHER_POST_ID, count: 4 }]);

    const [hydrated] = await service.hydratePosts([postRow(POST_ID)], {
      maxDepth: 0,
      includeQuoteCounts: true,
    });

    expect(hydrated.engagement.quotes).toBe(0);
  });

  it('runs NO aggregate and omits the field when the caller does not ask', async () => {
    const [hydrated] = await service.hydratePosts([postRow(POST_ID)], { maxDepth: 0 });

    expect(hydrated.engagement.quotes).toBeUndefined();
    expect(postAggregate).not.toHaveBeenCalled();
  });
});
