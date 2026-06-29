import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CachedUserSummary } from '../../services/userSummaryCache';
import type { LinkPreview } from '@oxyhq/contracts';

/**
 * Verifies that `PostHydrationService` sources link previews from the Oxy
 * ecosystem link-preview service (`oxyServices.getLinkPreviews`) and maps a
 * `'resolved'` {@link LinkPreview} onto the post DTO's `linkPreview` field —
 * passing the Oxy-hosted (`cloud.oxy.so`) `image` through UNCHANGED (never
 * re-proxied). A `'pending'`/`'empty'`/missing preview is omitted (the URL
 * re-resolves on a later render, mirroring the previous warm-on-miss UX), and a
 * preview-service failure never fails feed hydration.
 */

const POST_ID = '650000000000000000000010';
const AUTHOR_OXY_ID = 'oxy-author';
const POST_URL = 'https://example.com/some-article';

const { getUserById, getUsersByIds, getLinkPreviews, cacheStore } = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getUsersByIds: vi.fn(),
  getLinkPreviews: vi.fn(),
  cacheStore: new Map<string, CachedUserSummary>(),
}));

vi.mock('../../../server', () => ({
  oxy: {
    getUserById,
    getUserFollowing: vi.fn(async () => []),
    getUserFollowers: vi.fn(async () => []),
  },
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ getUsersByIds, getLinkPreviews }),
}));

vi.mock('../../utils/privacyHelpers', () => ({
  getBlockedUserIds: vi.fn(async () => []),
  getRestrictedUserIds: vi.fn(async () => []),
  extractFollowingIds: vi.fn(() => []),
  extractFollowersIds: vi.fn(() => []),
}));

// A chainable Mongoose query stub: `.select().sort().limit().maxTimeMS().lean()`.
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
    find: () => chainable([]),
    findOne: () => chainable(null),
  },
}));
vi.mock('../../models/Poll', () => ({ default: { find: () => chainable([]) } }));
vi.mock('../../models/Like', () => ({ default: { find: () => chainable([]) } }));
vi.mock('../../models/Bookmark', () => ({ default: { find: () => chainable([]) } }));
vi.mock('../../models/FederatedActor', () => ({ default: { find: () => chainable([]) } }));
vi.mock('../../models/UserSettings', () => ({
  UserSettings: { find: () => chainable([]), findOne: () => chainable(null) },
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

function makeOxyUser(id: string, username: string, displayName: string) {
  return { id, username, name: { displayName }, badges: [], verified: false, isVerified: false };
}

function postRow() {
  return {
    _id: POST_ID,
    oxyUserId: AUTHOR_OXY_ID,
    type: 'post',
    content: { text: `look at this ${POST_URL}` },
    stats: { likesCount: 0, boostsCount: 0, commentsCount: 0, downvotesCount: 0, viewsCount: 0 },
    metadata: { createdAt: new Date('2024-01-01T00:00:00Z') },
    createdAt: new Date('2024-01-01T00:00:00Z'),
    visibility: 'public',
    hashtags: [],
    mentions: [],
  };
}

describe('PostHydrationService — link previews sourced from Oxy', () => {
  let service: PostHydrationService;

  beforeEach(() => {
    cacheStore.clear();
    getUserById.mockReset();
    getUsersByIds.mockReset();
    getLinkPreviews.mockReset();
    getUsersByIds.mockResolvedValue([makeOxyUser(AUTHOR_OXY_ID, 'author', 'Author')]);
    service = new PostHydrationService();
  });

  async function hydrate() {
    const [hydrated] = await service.hydratePosts([postRow()], {
      viewerId: undefined,
      maxDepth: 0,
      includeLinkMetadata: true,
      includeFullMetadata: false,
    });
    return hydrated;
  }

  it('maps a resolved Oxy LinkPreview onto the post, passing the cloud.oxy.so image through unchanged', async () => {
    const resolved: LinkPreview = {
      url: 'https://example.com/some-article?canonical=1',
      status: 'resolved',
      title: 'Some Article',
      description: 'A description',
      image: 'https://cloud.oxy.so/file123?variant=thumb',
      siteName: 'Example',
      favicon: 'https://cloud.oxy.so/favicon456',
      resolvedAt: new Date().toISOString(),
    };
    getLinkPreviews.mockResolvedValue({ [POST_URL]: resolved });

    const hydrated = await hydrate();

    // The service requested exactly the extracted URL.
    expect(getLinkPreviews).toHaveBeenCalledTimes(1);
    expect(getLinkPreviews).toHaveBeenCalledWith([POST_URL]);

    expect(hydrated.linkPreview).toEqual({
      url: resolved.url,
      title: 'Some Article',
      description: 'A description',
      // Oxy-hosted image is rendered directly, never re-proxied.
      image: 'https://cloud.oxy.so/file123?variant=thumb',
      siteName: 'Example',
    });
  });

  it('omits a pending preview (no linkPreview until Oxy resolves it)', async () => {
    getLinkPreviews.mockResolvedValue({
      [POST_URL]: { url: POST_URL, status: 'pending' } satisfies LinkPreview,
    });

    const hydrated = await hydrate();
    expect(hydrated.linkPreview).toBeNull();
  });

  it('omits an empty preview', async () => {
    getLinkPreviews.mockResolvedValue({
      [POST_URL]: { url: POST_URL, status: 'empty' } satisfies LinkPreview,
    });

    const hydrated = await hydrate();
    expect(hydrated.linkPreview).toBeNull();
  });

  it('still hydrates the post when the preview service throws', async () => {
    getLinkPreviews.mockRejectedValue(new Error('oxy down'));

    const hydrated = await hydrate();
    expect(hydrated).toBeTruthy();
    expect(hydrated.id).toBe(POST_ID);
    expect(hydrated.linkPreview).toBeNull();
  });

  it('does not call the preview service when includeLinkMetadata is false', async () => {
    getLinkPreviews.mockResolvedValue({});

    await service.hydratePosts([postRow()], {
      viewerId: undefined,
      maxDepth: 0,
      includeLinkMetadata: false,
      includeFullMetadata: false,
    });

    expect(getLinkPreviews).not.toHaveBeenCalled();
  });
});
