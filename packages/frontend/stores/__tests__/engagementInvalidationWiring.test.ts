import type { FeedItem } from '@/db';
import { usePostsStore } from '../postsStore';

/**
 * Every engagement write must report the list it changed, and only on success.
 *
 * This is the join between the two halves of the fix and the one place a
 * regression would be silent: the read side keeps working perfectly, the write
 * side simply stops speaking, and every surface goes back to needing a reload.
 * `postsStore` is the single write authority — the three engagement hooks,
 * `usePostVote` and the videos screen all funnel through it — so asserting it
 * here covers all five call sites at once.
 */

const mockPosts = new Map<string, FeedItem>();

const mockInvalidate = jest.fn();

jest.mock('@/stores/engagementInvalidation', () => ({
  invalidateEngagementLists: (...args: unknown[]) => mockInvalidate(...args),
}));

const mockFeedService = {
  voteItem: jest.fn(),
  removeVote: jest.fn(),
  saveItem: jest.fn(),
  unsaveItem: jest.fn(),
  createBoost: jest.fn(),
  unboostItem: jest.fn(),
};

jest.mock('@/services/feedService', () => ({
  feedService: {
    voteItem: (...args: unknown[]) => mockFeedService.voteItem(...args),
    removeVote: (...args: unknown[]) => mockFeedService.removeVote(...args),
    saveItem: (...args: unknown[]) => mockFeedService.saveItem(...args),
    unsaveItem: (...args: unknown[]) => mockFeedService.unsaveItem(...args),
    createBoost: (...args: unknown[]) => mockFeedService.createBoost(...args),
    unboostItem: (...args: unknown[]) => mockFeedService.unboostItem(...args),
  },
}));

jest.mock('@/db', () => ({
  upsertPost: (post: FeedItem) => mockPosts.set(post.id, post),
  upsertPosts: (posts: FeedItem[]) => {
    for (const post of posts) mockPosts.set(post.id, post);
  },
  getPostById: (postId: string) => mockPosts.get(postId) ?? null,
  updatePost: (postId: string, updater: (previous: FeedItem) => FeedItem | null) => {
    const previous = mockPosts.get(postId);
    if (!previous) return null;
    const next = updater(previous);
    if (!next) return null;
    mockPosts.set(postId, next);
    return next;
  },
  deletePost: (postId: string) => mockPosts.delete(postId),
  pruneOldPosts: jest.fn(),
  setFeedItems: jest.fn(),
  appendFeedItems: jest.fn(),
  getAllFeedItems: () => [],
  getFeedMeta: () => null,
  clearFeed: jest.fn(),
  addFeedItemAtStart: jest.fn(),
  getFeedKeysForPost: () => [],
  removePostFromAllFeeds: jest.fn(),
  removeFeedItem: jest.fn(),
  buildFeedKey: (type: string, userId?: string) => (userId ? `user:${userId}:${type}` : type),
  getDb: () => null,
  rowToFeedItem: (row: FeedItem) => row,
  clearAllCachedData: jest.fn(),
}));

jest.mock('@/services/echoGuard', () => ({ markLocalAction: jest.fn() }));
jest.mock('@/lib/precacheActorsFromPosts', () => ({ precacheActorsFromPosts: jest.fn() }));
jest.mock('@/stores/feedScrollStore', () => ({
  publishNewLocalPost: jest.fn(),
  publishRemovedLocalPost: jest.fn(),
}));
jest.mock('@oxyhq/core/logger', () => ({
  ...jest.requireActual('@oxyhq/core/logger'),
  createLogger: () => ({
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  }),
}));

const POST_ID = 'post-1';

function seedPost(): void {
  mockPosts.set(POST_ID, {
    id: POST_ID,
    engagement: { likes: 0, replies: 0, boosts: 0, saves: 0, downvotes: 0 },
    viewerState: { isLiked: false, isBoosted: false, isSaved: false, isDownvoted: false },
  } as unknown as FeedItem);
}

const accepted = { success: true, data: {} };
const refused = { success: false, data: {} };

describe('postsStore reports every engagement it lands', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPosts.clear();
    seedPost();
  });

  it('reports a like, an unlike and a downvote as the likes list changing', async () => {
    mockFeedService.voteItem.mockResolvedValue(accepted);
    mockFeedService.removeVote.mockResolvedValue(accepted);

    await usePostsStore.getState().likePost({ postId: POST_ID, type: 'post' });
    expect(mockInvalidate).toHaveBeenLastCalledWith('like');

    await usePostsStore.getState().unlikePost({ postId: POST_ID, type: 'post' });
    expect(mockInvalidate).toHaveBeenLastCalledWith('like');

    // A downvote clears any like the viewer had, so it changes the same list.
    await usePostsStore.getState().downvotePost({ postId: POST_ID, type: 'post' });
    expect(mockInvalidate).toHaveBeenLastCalledWith('like');

    expect(mockInvalidate).toHaveBeenCalledTimes(3);
  });

  it('reports a boost and an unboost as the boosts list changing', async () => {
    mockFeedService.createBoost.mockResolvedValue(accepted);
    mockFeedService.unboostItem.mockResolvedValue(accepted);

    await usePostsStore.getState().boostPost({ postId: POST_ID });
    expect(mockInvalidate).toHaveBeenLastCalledWith('boost');

    await usePostsStore.getState().unboostPost({ postId: POST_ID });
    expect(mockInvalidate).toHaveBeenLastCalledWith('boost');

    expect(mockInvalidate).toHaveBeenCalledTimes(2);
  });

  it('reports a save and an unsave as the saved list changing', async () => {
    mockFeedService.saveItem.mockResolvedValue(accepted);
    mockFeedService.unsaveItem.mockResolvedValue(accepted);

    await usePostsStore.getState().savePost({ postId: POST_ID });
    expect(mockInvalidate).toHaveBeenLastCalledWith('save');

    await usePostsStore.getState().unsavePost({ postId: POST_ID });
    expect(mockInvalidate).toHaveBeenLastCalledWith('save');

    expect(mockInvalidate).toHaveBeenCalledTimes(2);
  });

  it('reports nothing when the server refuses the write', async () => {
    mockFeedService.voteItem.mockResolvedValue(refused);
    mockFeedService.createBoost.mockResolvedValue(refused);
    mockFeedService.saveItem.mockRejectedValue(new Error('network'));

    await expect(
      usePostsStore.getState().likePost({ postId: POST_ID, type: 'post' }),
    ).rejects.toThrow();
    await expect(usePostsStore.getState().boostPost({ postId: POST_ID })).rejects.toThrow();
    await expect(usePostsStore.getState().savePost({ postId: POST_ID })).rejects.toThrow();

    // A refused write leaves every list exactly as the caches already have it.
    expect(mockInvalidate).not.toHaveBeenCalled();
  });
});
