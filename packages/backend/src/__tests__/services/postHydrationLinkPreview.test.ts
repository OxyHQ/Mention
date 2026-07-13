import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CachedUserSummary } from '../../services/userSummaryCache';
import type { LinkPreview } from '@oxyhq/contracts';

/**
 * Verifies that `PostHydrationService` sources link previews from the Oxy
 * ecosystem link-preview service (`oxyServices.getLinkPreviews`) and maps the
 * `'resolved'` {@link LinkPreview}s onto the post DTO's `linkPreviews` array, in
 * text order — passing the Oxy-hosted (`cloud.oxy.so`) `image` through UNCHANGED
 * (never re-proxied). A `'pending'`/`'empty'`/missing preview is skipped (the URL
 * re-resolves on a later render, mirroring the previous warm-on-miss UX) without
 * disturbing the order of the resolved ones, and a preview-service failure never
 * fails feed hydration.
 */

const POST_ID = '650000000000000000000010';
const AUTHOR_OXY_ID = 'oxy-author';
const POST_URL = 'https://example.com/some-article';
const SECOND_URL = 'https://example.org/another-article';

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

function postRow(text: string = `look at this ${POST_URL}`) {
  return {
    _id: POST_ID,
    oxyUserId: AUTHOR_OXY_ID,
    type: 'post',
    content: { text },
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

  async function hydrate(text?: string) {
    const [hydrated] = await service.hydratePosts([postRow(text)], {
      viewerId: undefined,
      maxDepth: 0,
      includeLinkMetadata: true,
      includeFullMetadata: false,
    });
    return hydrated;
  }

  function resolvedPreview(url: string, title: string): LinkPreview {
    return {
      url,
      status: 'resolved',
      title,
      description: `${title} description`,
      image: 'https://cloud.oxy.so/file123?variant=thumb',
      siteName: 'Example',
      favicon: 'https://cloud.oxy.so/favicon456',
      resolvedAt: new Date().toISOString(),
    };
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

    expect(hydrated.linkPreviews).toEqual([
      {
        url: resolved.url,
        title: 'Some Article',
        description: 'A description',
        // Oxy-hosted image is rendered directly, never re-proxied.
        image: 'https://cloud.oxy.so/file123?variant=thumb',
        siteName: 'Example',
      },
    ]);
  });

  it('maps every resolved preview of a multi-link post, in text order', async () => {
    getLinkPreviews.mockResolvedValue({
      [POST_URL]: resolvedPreview(POST_URL, 'First'),
      [SECOND_URL]: resolvedPreview(SECOND_URL, 'Second'),
    });

    const hydrated = await hydrate(`two links: ${SECOND_URL} and ${POST_URL}`);

    expect(getLinkPreviews).toHaveBeenCalledWith([SECOND_URL, POST_URL]);
    expect(hydrated.linkPreviews?.map((preview) => preview.url)).toEqual([SECOND_URL, POST_URL]);
    expect(hydrated.linkPreviews?.map((preview) => preview.title)).toEqual(['Second', 'First']);
  });

  it('skips a pending preview without disturbing the order of the resolved ones', async () => {
    const thirdUrl = 'https://example.net/third-article';
    getLinkPreviews.mockResolvedValue({
      [POST_URL]: resolvedPreview(POST_URL, 'First'),
      [SECOND_URL]: { url: SECOND_URL, status: 'pending' } satisfies LinkPreview,
      [thirdUrl]: resolvedPreview(thirdUrl, 'Third'),
    });

    const hydrated = await hydrate(`${POST_URL} ${SECOND_URL} ${thirdUrl}`);

    expect(hydrated.linkPreviews?.map((preview) => preview.url)).toEqual([POST_URL, thirdUrl]);
  });

  it('omits a pending preview (no linkPreviews until Oxy resolves it)', async () => {
    getLinkPreviews.mockResolvedValue({
      [POST_URL]: { url: POST_URL, status: 'pending' } satisfies LinkPreview,
    });

    const hydrated = await hydrate();
    expect(hydrated.linkPreviews).toEqual([]);
  });

  it('omits an empty preview', async () => {
    getLinkPreviews.mockResolvedValue({
      [POST_URL]: { url: POST_URL, status: 'empty' } satisfies LinkPreview,
    });

    const hydrated = await hydrate();
    expect(hydrated.linkPreviews).toEqual([]);
  });

  it('still hydrates the post when the preview service throws', async () => {
    getLinkPreviews.mockRejectedValue(new Error('oxy down'));

    const hydrated = await hydrate();
    expect(hydrated).toBeTruthy();
    expect(hydrated.id).toBe(POST_ID);
    expect(hydrated.linkPreviews).toEqual([]);
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
