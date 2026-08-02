import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

/**
 * The slice's POSTS are supplied by the caller, so this suite hands `hydrateSlices`
 * exactly the two rows it is about and nothing has to be seeded. Everything
 * hydration reads BESIDE them — viewer likes and bookmarks, author privacy
 * settings, polls, quote counts — is Postgres, so the connection is a
 * prerequisite even though those tables stay empty.
 */

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

import { closePostgres, connectPostgres } from '../../db/postgres';
import { PostHydrationService } from '../../services/PostHydrationService';

interface PostRowOverrides {
  status?: string;
  visibility?: string;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

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
    // The STORED discriminator, which is what both reply-context carriers read.
    // Absent it, `buildReplyParentAuthorMap` skips the row and the header names
    // nobody — the failure would look like an ACL decision rather than a fixture
    // missing a column.
    isReply: false,
  };
}

/**
 * A reply-context slice as `ThreadSlicingService` builds it: the parent first,
 * the reply second. The reason carries the TAG only — whom the reply answers is
 * resolved by hydration onto the reply's own `replyContext`.
 */
function makeReplyContextSlice(parentOverrides: PostRowOverrides = {}): FeedPostSlice {
  const parent = makePostRow(PARENT_ID, PARENT_AUTHOR_ID, parentOverrides);
  const reply = { ...makePostRow(REPLY_ID, REPLY_AUTHOR_ID), parentPostId: PARENT_ID, isReply: true };

  return {
    _sliceKey: `${PARENT_ID}+${REPLY_ID}`,
    isIncompleteThread: true,
    reason: { type: 'replyContext' },
    items: [
      { post: parent as unknown as HydratedPost, isThreadParent: true, isThreadChild: false, isThreadLastChild: false },
      { post: reply as unknown as HydratedPost, isThreadParent: false, isThreadChild: true, isThreadLastChild: true },
    ],
  };
}

describe('PostHydrationService — reply context under the viewer ACL', () => {
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

  it('names the parent author on the reply when the parent survives the ACL', async () => {
    const [slice] = await service.hydrateSlices([makeReplyContextSlice()], { viewerId: VIEWER_ID });

    expect(slice.items.map((item) => item.post.id)).toEqual([PARENT_ID, REPLY_ID]);
    expect(slice.reason?.type).toBe('replyContext');

    const reply = slice.items[1].post;
    expect(reply.replyContext?.parentAuthor?.id).toBe(PARENT_AUTHOR_ID);
    expect(reply.replyContext?.parentAuthor?.username).toBe('parenthandle');
  });

  it.each([
    ['an unpublished parent', { status: 'draft' }],
    ['a private parent', { visibility: 'private' }],
  ] as const)('names nobody, but still reports a reply, when the ACL drops %s', async (_label, parentOverrides) => {
    const [slice] = await service.hydrateSlices([makeReplyContextSlice(parentOverrides)], {
      viewerId: VIEWER_ID,
    });

    // The parent post is gone from the response…
    expect(slice.items.map((item) => item.post.id)).toEqual([REPLY_ID]);

    const reply = slice.items[0].post;
    // …and so is its author. Naming them would reveal both the existence of a
    // post this viewer was refused and who wrote it.
    expect(reply.replyContext?.parentAuthor).toBeUndefined();
    expect(JSON.stringify(slice)).not.toContain('parenthandle');
    expect(JSON.stringify(slice)).not.toContain('Parent Author');

    // But the row is STILL declared a reply, in both carriers. The reason used to
    // be stripped here along with the author it once held, which quietly let a
    // viewer who had hidden replies be served exactly the replies whose parent
    // they could not read — `removeReplies` filters on this tag.
    expect(reply.replyContext).toBeDefined();
    expect(slice.reason?.type).toBe('replyContext');
  });
});
