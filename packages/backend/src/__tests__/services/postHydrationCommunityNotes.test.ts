import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CachedUserSummary } from '../../services/userSummaryCache';

/**
 * The note a reader sees under a post, put there by hydration.
 *
 * Three things have to hold, and none of them is visible from the note service
 * on its own:
 *
 *   1. The note is attached to the post it is about, by subject id.
 *   2. A caller that just WROTE the post asks about nothing —
 *      `includeCommunityNotes: false` is the difference between a post creation
 *      that costs a CrowdSource round trip and one that does not.
 *   3. A lookup that fails leaves the page exactly as it was. A feed without
 *      notes is the feed everyone had before notes existed; a feed that 500s
 *      because CrowdSource is down is not.
 */

const AUTHOR_OXY_ID = 'oxy-author';
const VIEWER_ID = `oxy-viewer-${randomUUID()}`;
const POST_ID = '650000000000000000000042';

const { getUsersByIds, loadShownNotes } = vi.hoisted(() => ({
  getUsersByIds: vi.fn(),
  loadShownNotes: vi.fn(async () => new Map()),
}));

vi.mock('../../services/communityNotes/CommunityNotesService', () => ({ loadShownNotes }));

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    getUserFollowing: vi.fn(async () => ({ following: [] })),
    getUserFollowers: vi.fn(async () => ({ followers: [] })),
    getUserById: vi.fn(),
  }),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUsersByIds,
    getClarityDocuments: vi.fn(async () => ({})),
    getFileDownloadUrl: (id: string) => `https://cdn.test/${id}`,
  }),
}));

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

const note = {
  id: 'n1',
  text: 'This clip is from 2019.',
  sourceUrls: ['https://example.org/source'],
  status: 'shown' as const,
  createdAt: '2026-09-18T00:00:00.000Z',
};

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

function makeClient() {
  return {
    getUserFollowing: vi.fn(async () => ({ following: [] })),
    getUserFollowers: vi.fn(async () => ({ followers: [] })),
    getBlockedUsers: vi.fn(async () => []),
    getRestrictedUsers: vi.fn(async () => []),
  };
}

describe('PostHydrationService — community notes', () => {
  let service: PostHydrationService;

  beforeEach(() => {
    cacheStore.clear();
    getUsersByIds.mockReset();
    getUsersByIds.mockResolvedValue([
      { id: AUTHOR_OXY_ID, username: 'author', name: { displayName: 'Author' }, badges: [], verified: false },
    ]);
    loadShownNotes.mockReset();
    loadShownNotes.mockResolvedValue(new Map());
    service = new PostHydrationService();
  });

  it('attaches the shown note to the post it is about', async () => {
    loadShownNotes.mockResolvedValue(new Map([[POST_ID, note]]));

    const [hydrated] = await service.hydratePosts([makePostRow()], {
      viewerId: VIEWER_ID,
      oxyClient: makeClient() as never,
    });

    expect(loadShownNotes).toHaveBeenCalledWith([POST_ID]);
    expect(hydrated?.communityNote).toEqual(note);
  });

  it('leaves a post without one alone', async () => {
    const [hydrated] = await service.hydratePosts([makePostRow()], {
      viewerId: VIEWER_ID,
      oxyClient: makeClient() as never,
    });

    expect(hydrated).toBeDefined();
    expect(hydrated?.communityNote).toBeUndefined();
  });

  it('asks about nothing when the caller just wrote the post', async () => {
    await service.hydratePosts([makePostRow()], {
      viewerId: VIEWER_ID,
      oxyClient: makeClient() as never,
      includeCommunityNotes: false,
    });

    expect(loadShownNotes).not.toHaveBeenCalled();
  });

  it('renders the page unchanged when the lookup answers with nothing', async () => {
    loadShownNotes.mockResolvedValue(new Map());

    const [hydrated] = await service.hydratePosts([makePostRow()], {
      viewerId: VIEWER_ID,
      oxyClient: makeClient() as never,
    });

    expect(hydrated?.id).toBe(POST_ID);
    expect(hydrated?.communityNote).toBeUndefined();
  });
});
