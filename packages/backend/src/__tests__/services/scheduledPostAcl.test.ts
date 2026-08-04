import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CachedUserSummary } from '../../services/userSummaryCache';

/**
 * ACL proof for the scheduled-post surface.
 *
 * `GET /posts/scheduled` now HYDRATES, so the composer can preview a scheduled
 * post through the same renderer the feed uses. That is only safe because a
 * scheduled post is deliberately not public, and hydration — the single ACL
 * authority — drops any post whose `status` is not `published` for a viewer who
 * does not own it. This drives the REAL `hydratePosts` path for three viewers:
 *
 *  - the OWNER, who must get the post (there is no preview otherwise),
 *  - ANOTHER signed-in user, who must not,
 *  - an ANONYMOUS reader, who must not.
 *
 * The sibling `getPostByIdAnonAcl` test covers the same rule from the public
 * post-detail direction; this one covers it from the direction the preview
 * introduced, so loosening either half fails a test that names the viewer.
 */

const AUTHOR_ID = 'oxy-author';
const OTHER_USER_ID = 'oxy-someone-else';
const POST_ID = '650000000000000000000010';
const SCHEDULED_FOR = new Date('2026-08-02T09:30:00.000Z');

const { getUsersByIds, cacheStore, postFind, postFindOne } = vi.hoisted(() => ({
  getUsersByIds: vi.fn(),
  cacheStore: new Map<string, CachedUserSummary>(),
  postFind: vi.fn(),
  postFindOne: vi.fn(),
}));

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    getUserById: vi.fn(),
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
    aggregate: async () => [],
  },
}));
vi.mock('../../models/Poll', () => ({ default: { find: () => chainable([]) } }));
vi.mock('../../models/Like', () => ({ default: { find: () => chainable([]) } }));
vi.mock('../../models/Bookmark', () => ({ default: { find: () => chainable([]) } }));
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

function scheduledRow() {
  return {
    _id: POST_ID,
    oxyUserId: AUTHOR_ID,
    authorship: [{ oxyUserId: AUTHOR_ID, role: 'owner', status: 'accepted' }],
    type: 'post',
    content: { variants: [{ tag: 'en', source: 'author', text: 'not out yet' }] },
    stats: { likesCount: 0, boostsCount: 0, commentsCount: 0, downvotesCount: 0, viewsCount: 0 },
    metadata: { createdAt: new Date('2026-08-01T00:00:00Z') },
    createdAt: new Date('2026-08-01T00:00:00Z'),
    visibility: 'public',
    status: 'scheduled',
    scheduledFor: SCHEDULED_FOR,
    hashtags: [],
    mentions: [],
  };
}

/** Mirror getScheduledPosts: hydrate the row as one particular viewer. */
async function hydrateAs(service: PostHydrationService, viewerId: string | undefined) {
  return service.hydratePosts([scheduledRow()], {
    viewerId,
    oxyClient: {
      getUsersByIds,
      getLinkPreviews: vi.fn(async () => ({})),
      getFileDownloadUrl: (id: string) => `https://cdn.test/${id}`,
    } as never,
    maxDepth: 1,
    includeLinkMetadata: true,
  });
}

describe('scheduled-post ACL — only the owner can obtain a scheduled post', () => {
  let service: PostHydrationService;

  beforeEach(() => {
    cacheStore.clear();
    getUsersByIds.mockReset();
    postFind.mockReset();
    postFindOne.mockReset();

    service = new PostHydrationService();
    getUsersByIds.mockResolvedValue([
      { id: AUTHOR_ID, username: 'author', name: { displayName: 'Author' }, badges: [], verified: false, isVerified: false },
    ]);
    postFind.mockReturnValue([]);
    postFindOne.mockReturnValue(null);
  });

  it('RETURNS the scheduled post to its OWNER, so the composer can preview it', async () => {
    const result = await hydrateAs(service, AUTHOR_ID);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(POST_ID);
    expect(result[0]?.metadata.status).toBe('scheduled');
  });

  it('DROPS the scheduled post for ANOTHER signed-in user', async () => {
    const result = await hydrateAs(service, OTHER_USER_ID);
    expect(result).toHaveLength(0);
  });

  it('DROPS the scheduled post for an ANONYMOUS reader', async () => {
    const result = await hydrateAs(service, undefined);
    expect(result).toHaveLength(0);
  });

  it('gives the OWNER the publish time, so the preview can say when it goes out', async () => {
    const result = await hydrateAs(service, AUTHOR_ID);
    expect(result[0]?.metadata.scheduledFor).toBe(SCHEDULED_FOR.toISOString());
  });

  it('never leaks a publish time to a non-owner, because there is no post to carry one', async () => {
    for (const viewer of [OTHER_USER_ID, undefined]) {
      const result = await hydrateAs(service, viewer);
      expect(result.map((post) => post.metadata.scheduledFor)).toEqual([]);
    }
  });

  it('omits scheduledFor entirely on an ordinary published post', async () => {
    const published = { ...scheduledRow(), status: 'published', scheduledFor: undefined };
    const result = await service.hydratePosts([published], {
      viewerId: undefined,
      oxyClient: {
        getUsersByIds,
        getLinkPreviews: vi.fn(async () => ({})),
        getFileDownloadUrl: (id: string) => `https://cdn.test/${id}`,
      } as never,
      maxDepth: 1,
      includeLinkMetadata: true,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.metadata.scheduledFor).toBeUndefined();
  });

  it('answers undefined rather than throwing when scheduledFor is unparseable', async () => {
    const broken = { ...scheduledRow(), scheduledFor: 'not-a-date' };
    const result = await service.hydratePosts([broken], {
      viewerId: AUTHOR_ID,
      oxyClient: {
        getUsersByIds,
        getLinkPreviews: vi.fn(async () => ({})),
        getFileDownloadUrl: (id: string) => `https://cdn.test/${id}`,
      } as never,
      maxDepth: 1,
      includeLinkMetadata: true,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.metadata.scheduledFor).toBeUndefined();
  });
});
