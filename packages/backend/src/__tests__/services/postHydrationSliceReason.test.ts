import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FeedPostSlice, HydratedPost } from '@mention/shared-types';
import type { CachedUserSummary } from '../../services/userSummaryCache';

/**
 * `hydrateSlices` re-checks post ACL per viewer and drops the items a viewer may
 * not read. A `replyContext` slice is exactly [parent, reply] and its
 * `reason.parentAuthor` describes the PARENT — so when the ACL drops that parent,
 * a preserved reason would keep naming the author of a post the viewer was just
 * denied, on a slice that no longer carries it.
 *
 * The reason must go with its anchor. `selfThread` and `boost` reasons are
 * unaffected: they describe the slice as a whole, not one dropped item.
 */

const PARENT_ID = '650000000000000000000021';
const REPLY_ID = '650000000000000000000022';
const PARENT_AUTHOR_ID = 'oxy-parent-author';
const REPLY_AUTHOR_ID = 'oxy-reply-author';
const VIEWER_ID = 'oxy-viewer';

const { getUsersByIds } = vi.hoisted(() => ({ getUsersByIds: vi.fn() }));

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
    getLinkPreviews: vi.fn(async () => ({})),
    getFileDownloadUrl: (id: string) => `https://cdn.test/${id}`,
  }),
}));

vi.mock('../../utils/privacyHelpers', () => ({
  getBlockedUserIds: vi.fn(async () => []),
  getRestrictedUserIds: vi.fn(async () => []),
  extractFollowingIds: (res: unknown) =>
    Array.isArray((res as { following?: unknown[] })?.following)
      ? (res as { following: string[] }).following
      : [],
  extractFollowersIds: (res: unknown) =>
    Array.isArray((res as { followers?: unknown[] })?.followers)
      ? (res as { followers: string[] }).followers
      : [],
}));

function chainable(rows: unknown[] | null) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'sort', 'limit', 'maxTimeMS']) {
    q[m] = () => q;
  }
  q.lean = async () => rows;
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
vi.mock('../../models/StarterPack', () => ({
  StarterPack: { aggregate: async () => [] },
  default: { aggregate: async () => [] },
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

interface PostRowOverrides {
  status?: string;
  visibility?: string;
}

function makePostRow(id: string, authorId: string, overrides: PostRowOverrides = {}) {
  return {
    _id: id,
    oxyUserId: authorId,
    authorship: [{ oxyUserId: authorId, role: 'owner', status: 'accepted' }],
    type: 'post',
    content: { text: `body of ${id}` },
    stats: { likesCount: 0, boostsCount: 0, commentsCount: 0, downvotesCount: 0, viewsCount: 0 },
    metadata: { createdAt: new Date('2024-01-01T00:00:00Z') },
    createdAt: new Date('2024-01-01T00:00:00Z'),
    visibility: overrides.visibility ?? 'public',
    status: overrides.status ?? 'published',
    hashtags: [],
    mentions: [],
  };
}

/**
 * A reply-context slice as `ThreadSlicingService` builds it: the parent first,
 * the reply second, and a reason naming the parent's author.
 */
function makeReplyContextSlice(parentOverrides: PostRowOverrides = {}): FeedPostSlice {
  const parent = makePostRow(PARENT_ID, PARENT_AUTHOR_ID, parentOverrides);
  const reply = makePostRow(REPLY_ID, REPLY_AUTHOR_ID);

  return {
    _sliceKey: `${PARENT_ID}+${REPLY_ID}`,
    isIncompleteThread: true,
    reason: {
      type: 'replyContext',
      parentAuthor: {
        id: PARENT_AUTHOR_ID,
        username: 'parenthandle',
        name: { displayName: 'Parent Author' },
        avatar: null,
      },
    },
    items: [
      { post: parent as unknown as HydratedPost, isThreadParent: true, isThreadChild: false, isThreadLastChild: false },
      { post: reply as unknown as HydratedPost, isThreadParent: false, isThreadChild: true, isThreadLastChild: true },
    ],
  };
}

describe('PostHydrationService — reply-context reason follows its anchor', () => {
  let service: PostHydrationService;

  beforeEach(() => {
    cacheStore.clear();
    getUsersByIds.mockReset();
    getUsersByIds.mockResolvedValue([
      { id: PARENT_AUTHOR_ID, username: 'parenthandle', name: { displayName: 'Parent Author' }, badges: [], verified: false },
      { id: REPLY_AUTHOR_ID, username: 'replyhandle', name: { displayName: 'Reply Author' }, badges: [], verified: false },
    ]);
    service = new PostHydrationService();
  });

  it('keeps the reason when the parent survives the ACL', async () => {
    const [slice] = await service.hydrateSlices([makeReplyContextSlice()], { viewerId: VIEWER_ID });

    expect(slice.items.map((item) => item.post.id)).toEqual([PARENT_ID, REPLY_ID]);
    expect(slice.reason?.type).toBe('replyContext');
  });

  it.each([
    ['an unpublished parent', { status: 'draft' }],
    ['a private parent', { visibility: 'private' }],
  ] as const)('clears the reason when the ACL drops %s', async (_label, parentOverrides) => {
    const [slice] = await service.hydrateSlices([makeReplyContextSlice(parentOverrides)], {
      viewerId: VIEWER_ID,
    });

    // The parent is gone — and so is the header that described it.
    expect(slice.items.map((item) => item.post.id)).toEqual([REPLY_ID]);
    expect(slice.reason).toBeUndefined();
    expect(JSON.stringify(slice)).not.toContain('parenthandle');
  });
});
