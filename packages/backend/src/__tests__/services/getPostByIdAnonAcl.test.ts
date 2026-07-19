import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CachedUserSummary } from '../../services/userSummaryCache';

/**
 * Anonymous-viewer ACL proof for `GET /posts/:id` (getPostById).
 *
 * The route is now public (anonymous discovery / SEO / fediverse), so the ONLY
 * thing preventing a private post from leaking to a logged-out viewer is the
 * `PostHydrationService` ACL running with `viewerId === undefined`. getPostById
 * returns 404 whenever hydration drops the post (empty result). This test drives
 * the REAL `hydratePosts` path (same `maxDepth: 2`, same options getPostById
 * uses) for each visibility case and asserts that ONLY a public+published post
 * from a public-profile author survives for an anonymous viewer.
 */

const AUTHOR_ID = 'oxy-author';
const POST_ID = '650000000000000000000010';

const { getUsersByIds, cacheStore, postFind, postFindOne, userSettingsFind } = vi.hoisted(() => ({
  getUsersByIds: vi.fn(),
  cacheStore: new Map<string, CachedUserSummary>(),
  postFind: vi.fn(),
  postFindOne: vi.fn(),
  userSettingsFind: vi.fn(),
}));

vi.mock('../../../server', () => ({
  oxy: {
    getUserById: vi.fn(),
    getUserFollowing: vi.fn(async () => []),
    getUserFollowers: vi.fn(async () => []),
  },
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
vi.mock('../../models/UserSettings', () => ({
  UserSettings: {
    find: (...args: unknown[]) => chainable(userSettingsFind(...args)),
    findOne: () => chainable(null),
  },
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

interface PostRowOverrides {
  visibility?: string;
  status?: string;
}

function postRow({ visibility = 'public', status = 'published' }: PostRowOverrides) {
  return {
    _id: POST_ID,
    oxyUserId: AUTHOR_ID,
    authorship: [{ oxyUserId: AUTHOR_ID, role: 'owner', status: 'accepted' }],
    type: 'post',
    content: { variants: [{ tag: 'en', source: 'author', text: 'secret body' }] },
    stats: { likesCount: 0, boostsCount: 0, commentsCount: 0, downvotesCount: 0, viewsCount: 0 },
    metadata: { createdAt: new Date('2024-01-01T00:00:00Z') },
    createdAt: new Date('2024-01-01T00:00:00Z'),
    visibility,
    status,
    hashtags: [],
    mentions: [],
  };
}

/** Mirror getPostById: hydrate a single row as an anonymous viewer. */
async function hydrateAsAnon(
  service: PostHydrationService,
  row: ReturnType<typeof postRow>,
) {
  return service.hydratePosts([row], {
    viewerId: undefined,
    oxyClient: {
      getUsersByIds,
      getLinkPreviews: vi.fn(async () => ({})),
      getFileDownloadUrl: (id: string) => `https://cdn.test/${id}`,
    } as never,
    maxDepth: 2,
    includeLinkMetadata: true,
  });
}

describe('getPostById ACL — anonymous viewer cannot see non-public posts', () => {
  let service: PostHydrationService;

  beforeEach(() => {
    cacheStore.clear();
    getUsersByIds.mockReset();
    postFind.mockReset();
    postFindOne.mockReset();
    userSettingsFind.mockReset();

    service = new PostHydrationService();
    getUsersByIds.mockResolvedValue([
      { id: AUTHOR_ID, username: 'author', name: { displayName: 'Author' }, badges: [], verified: false, isVerified: false },
    ]);
    // No nested references, no viewer-interaction rows.
    postFind.mockReturnValue([]);
    postFindOne.mockReturnValue(null);
    // Default: author has a PUBLIC profile.
    userSettingsFind.mockReturnValue([{ oxyUserId: AUTHOR_ID, privacy: { profileVisibility: 'public' } }]);
  });

  it('RETURNS a public+published post (public-profile author)', async () => {
    const result = await hydrateAsAnon(service, postRow({ visibility: 'public', status: 'published' }));
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(POST_ID);
  });

  it('DROPS a private post (→ getPostById 404)', async () => {
    const result = await hydrateAsAnon(service, postRow({ visibility: 'private', status: 'published' }));
    expect(result).toHaveLength(0);
  });

  it('DROPS a followers-only post (→ getPostById 404)', async () => {
    const result = await hydrateAsAnon(service, postRow({ visibility: 'followers_only', status: 'published' }));
    expect(result).toHaveLength(0);
  });

  it('DROPS an unpublished (draft) post (→ getPostById 404)', async () => {
    const result = await hydrateAsAnon(service, postRow({ visibility: 'public', status: 'draft' }));
    expect(result).toHaveLength(0);
  });

  it('DROPS a scheduled post (→ getPostById 404)', async () => {
    const result = await hydrateAsAnon(service, postRow({ visibility: 'public', status: 'scheduled' }));
    expect(result).toHaveLength(0);
  });

  it('DROPS a public post whose author has a PRIVATE profile (→ getPostById 404)', async () => {
    userSettingsFind.mockReturnValue([{ oxyUserId: AUTHOR_ID, privacy: { profileVisibility: 'private' } }]);
    const result = await hydrateAsAnon(service, postRow({ visibility: 'public', status: 'published' }));
    expect(result).toHaveLength(0);
  });

  it('DROPS a public post whose author has a FOLLOWERS-ONLY profile (→ getPostById 404)', async () => {
    userSettingsFind.mockReturnValue([{ oxyUserId: AUTHOR_ID, privacy: { profileVisibility: 'followers_only' } }]);
    const result = await hydrateAsAnon(service, postRow({ visibility: 'public', status: 'published' }));
    expect(result).toHaveLength(0);
  });
});
