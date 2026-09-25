import type { HydratedPost, HydratedPostSummary } from '@mention/shared-types';
import { PostVisibility } from '@mention/shared-types/post';
import type { FeedItem } from '@/db';
import { postToRow, rowToFeedItem } from '@/db/schema';
import { usePostsStore } from '../postsStore';

/**
 * A post keeps its `createdAt` through every write the QA session made.
 *
 * #1140 item 23: on a profile that had boosted its own post, the original's row
 * read "now" while the API sent `createdAt` correctly for both entries. A header
 * says "now" for a date it cannot parse, and a row reads the SHARED cache over
 * the feed's own copy, so a write that dropped the date would produce exactly
 * that. This replays every write that session put through the store, with the
 * production payloads, and checks the date after each one — on the in-memory
 * store the tests run against AND through the SQLite row the device keeps.
 *
 * None of them drops it. The "now" was a label computed when the row first
 * rendered, seconds after publishing, and never recomputed (item 15; fixed by
 * `useTimeAgo`) — see `PostHeaderTimeLabel.test.tsx`.
 */

const mockFeedService = {
  createPost: jest.fn(),
  createBoost: jest.fn(),
  getUserFeed: jest.fn(),
};

jest.mock('@/services/feedService', () => ({
  feedService: {
    createPost: (...args: unknown[]) => mockFeedService.createPost(...args),
    createBoost: (...args: unknown[]) => mockFeedService.createBoost(...args),
    getUserFeed: (...args: unknown[]) => mockFeedService.getUserFeed(...args),
  },
}));
// The in-memory tables stand in for SQLite (jest-expo resolves the native
// database, which has no engine here); `expectDatesKept` covers the SQLite row.
jest.mock('@/db/database', () => jest.requireActual('@/db/database.web'));
jest.mock('@/services/echoGuard', () => ({ markLocalAction: jest.fn() }));
jest.mock('@/stores/engagementInvalidation', () => ({ invalidateEngagementLists: jest.fn() }));
jest.mock('@/stores/profileCountsInvalidation', () => ({ invalidateProfileCounts: jest.fn() }));
jest.mock('@/lib/queryClient', () => ({ queryClient: {} }));
jest.mock('@/lib/precacheActorsFromPosts', () => ({ precacheActorsFromPosts: jest.fn() }));
jest.mock('@/stores/feedScrollStore', () => ({
  publishNewLocalPost: jest.fn(),
  publishRemovedLocalPost: jest.fn(),
}));
jest.mock('@oxy.so/core/logger', () => ({
  ...jest.requireActual('@oxy.so/core/logger'),
  createLogger: () => ({ debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
}));

// The production values from the QA session (`/feed/mtn`, author|…|posts).
const AUTHOR_ID = '01a0d834-b80a-7cbd-b416-5502d33318c9';
const ORIGINAL_ID = '01a0d838-d23c-7783-be0b-8171e73de842';
const BOOST_ID = '01a0d83b-8f5a-76dc-9bbc-0153d9307833';
const ORIGINAL_CREATED_AT = '2026-09-25T10:59:57.629Z';
const BOOST_CREATED_AT = '2026-09-25T11:02:57.114Z';

const author = {
  id: AUTHOR_ID,
  username: 'qatest0925',
  name: {},
  avatar: null,
  verified: false,
  kind: 'personal',
} as unknown as HydratedPost['user'];

const strangerView = {
  viewerState: {
    isOwner: false,
    isCollaborator: false,
    isLiked: false,
    isDownvoted: false,
    isBoosted: false,
    isSaved: false,
  },
  permissions: { canReply: false, canDelete: false, canPin: false, canViewSources: false },
};

const ownerView = {
  viewerState: { ...strangerView.viewerState, isOwner: true },
  permissions: { canReply: true, canDelete: true, canPin: true, canViewSources: true },
};

function original(
  view: typeof strangerView,
  engagement: Partial<HydratedPost['engagement']> = {},
  updatedAt = ORIGINAL_CREATED_AT,
): HydratedPostSummary {
  return {
    id: ORIGINAL_ID,
    content: { text: 'QA test post from Android - please ignore' },
    attachments: {},
    documents: [],
    user: author,
    authors: [],
    engagement: { likes: 0, downvotes: 0, boosts: 0, replies: 0, saves: 0, views: null, impressions: null, ...engagement },
    ...view,
    metadata: {
      visibility: PostVisibility.PUBLIC,
      createdAt: ORIGINAL_CREATED_AT,
      updatedAt,
    },
  } as HydratedPostSummary;
}

function boost(view: typeof strangerView, embedded: HydratedPostSummary): HydratedPost {
  return {
    id: BOOST_ID,
    content: { text: '' },
    attachments: {},
    documents: [],
    user: author,
    authors: [],
    engagement: { likes: 0, downvotes: 0, boosts: 0, replies: 0, saves: 0, views: null, impressions: null },
    ...view,
    metadata: {
      visibility: PostVisibility.PUBLIC,
      createdAt: BOOST_CREATED_AT,
      updatedAt: BOOST_CREATED_AT,
    },
    originalPost: embedded,
    quotedPost: null,
    boost: { originalPost: embedded, actor: author },
  } as HydratedPost;
}

/** The cached copy as a row reads it, and as the device's SQLite row returns it. */
function expectDatesKept(step: string) {
  const store = usePostsStore.getState();
  for (const [id, createdAt] of [
    [ORIGINAL_ID, ORIGINAL_CREATED_AT],
    [BOOST_ID, BOOST_CREATED_AT],
  ] as const) {
    const cached = store.getPostFromDb(id);
    if (!cached) continue;
    expect({ step, id, createdAt: cached.metadata.createdAt }).toEqual({ step, id, createdAt });
    const fromRow = rowToFeedItem(postToRow(cached)) as FeedItem;
    expect({ step, id, createdAt: fromRow.metadata.createdAt }).toEqual({ step, id, createdAt });
  }
}

describe('postsStore keeps a post’s createdAt (#1140 item 23)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    usePostsStore.getState().resetViewerState({ clearCachedData: true });
  });

  it('through publish, the realtime echo, a boost, counters, and the profile feed', async () => {
    const store = () => usePostsStore.getState();

    // 1. Publish: the create response, hydrated for the author.
    mockFeedService.createPost.mockResolvedValue({ success: true, post: original(ownerView) });
    await store().createPost({ content: { text: 'QA test post from Android - please ignore' } } as never);
    expect(store().getPostFromDb(ORIGINAL_ID)).not.toBeNull();
    expectDatesKept('create');

    // 2. The realtime broadcast of the same post, hydrated for no viewer.
    store().addPostsToFeed([original(strangerView) as FeedItem], 'for_you');
    expectDatesKept('feed:updated original');

    // 3. Boost it: the optimistic write, then the server's answer.
    mockFeedService.createBoost.mockResolvedValue({ success: true });
    await store().boostPost({ postId: ORIGINAL_ID });
    expectDatesKept('boost');

    // 4. The boost's own broadcast, embedding the original.
    store().addPostsToFeed([boost(strangerView, original(strangerView, { boosts: 1 })) as FeedItem], 'following');
    expectDatesKept('feed:updated boost');

    // 5. A room's counter event (what `socketService` applies).
    store().updatePostEverywhere(ORIGINAL_ID, (prev) => ({
      ...prev,
      engagement: { ...prev.engagement, likes: 2, replies: 1 },
    }));
    expectDatesKept('engagement event');

    // 6. The profile feed as production served it: the boost, then the original.
    const later = original(strangerView, { likes: 2, boosts: 1, replies: 1 }, '2026-09-25T11:09:42.633Z');
    mockFeedService.getUserFeed.mockResolvedValue({
      items: [boost(strangerView, later), later],
      hasMore: false,
    });
    await store().fetchUserFeed(AUTHOR_ID, { type: 'posts' } as never);
    expectDatesKept('profile feed');

    // 7. The memory-mode feed caching the same page.
    store().cachePosts([boost(strangerView, later), later]);
    expectDatesKept('cachePosts');

    expect(store().getPostFromDb(ORIGINAL_ID)?.metadata.createdAt).toBe(ORIGINAL_CREATED_AT);
    expect(store().getPostFromDb(BOOST_ID)?.metadata.createdAt).toBe(BOOST_CREATED_AT);
  });
});
