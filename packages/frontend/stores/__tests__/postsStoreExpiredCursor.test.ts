import { setFeedItems, appendFeedItems } from '@/db';
import type { FeedItem } from '@/db';
import { usePostsStore } from '../postsStore';

const mockGetFeed = jest.fn();
const mockGetFeedMeta = jest.fn();
const mockPosts = new Map<string, FeedItem>();
const mockGetPostById = jest.fn<Promise<FeedItem>, [string, AbortSignal | undefined]>();

jest.mock('@/db', () => ({
  upsertPost: (post: FeedItem) => {
    if (post.id) mockPosts.set(post.id, post);
  },
  upsertPosts: (posts: FeedItem[]) => {
    for (const post of posts) if (post.id) mockPosts.set(post.id, post);
  },
  getPostById: (postId: string) => mockPosts.get(postId) ?? null,
  getPostIdsReferencing: (ids: string[]) =>
    [...mockPosts.values()]
      .filter((post) =>
        [post.originalPost?.id, post.quotedPost?.id, post.boost?.originalPost?.id].some(
          (id) => id && ids.includes(id),
        ),
      )
      .map((post) => post.id),
  updatePost: () => null,
  deletePost: (postId: string) => {
    mockPosts.delete(postId);
  },
  pruneOldPosts: jest.fn(),
  setFeedItems: jest.fn(),
  appendFeedItems: jest.fn(),
  getAllFeedItems: () => [],
  getFeedMeta: () => mockGetFeedMeta(),
  clearFeed: jest.fn(),
  addFeedItemAtStart: jest.fn(),
  getFeedKeysForPost: () => [],
  removePostFromAllFeeds: jest.fn(),
  removeFeedItem: jest.fn(),
  buildFeedKey: (type: string, userId?: string) => (userId ? `user:${userId}:${type}` : type),
  getDb: () => null,
  rowToFeedItem: (row: FeedItem) => row,
  clearAllCachedData: () => {
    mockPosts.clear();
  },
}));

jest.mock('@/services/feedService', () => ({
  feedService: {
    getFeed: (...args: unknown[]) => mockGetFeed(...args),
    getPostById: (postId: string, signal?: AbortSignal) => mockGetPostById(postId, signal),
  },
}));
jest.mock('@/services/echoGuard', () => ({ markLocalAction: jest.fn() }));
jest.mock('@/stores/engagementInvalidation', () => ({ invalidateEngagementLists: jest.fn() }));
jest.mock('@/lib/precacheActorsFromPosts', () => ({ precacheActorsFromPosts: jest.fn() }));
jest.mock('@/stores/feedQueryCache', () => ({
  publishNewLocalPost: jest.fn(),
  publishRemovedLocalPost: jest.fn(),
}));
jest.mock('@oxy.so/core/logger', () => ({
  ...jest.requireActual('@oxy.so/core/logger'),
  createLogger: () => ({ debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
}));

describe('SQLite ranked cursor recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetFeed.mockReset();
    usePostsStore.getState().resetViewerState({ clearCachedData: true });
    mockGetFeedMeta.mockReturnValue({ hasMore: true, nextCursor: 'fs1:expired' });
  });

  it('replaces the feed instead of appending a fresh page to expired ranked pages', async () => {
    mockGetFeed.mockRejectedValueOnce({ status: 410, code: 'FEED_CURSOR_EXPIRED' });
    mockGetFeed.mockResolvedValueOnce({ items: [], nextCursor: 'fs1:new', hasMore: true });
    await usePostsStore.getState().loadMoreFeed('for_you', { topic: 'science' });
    expect(mockGetFeed).toHaveBeenCalledTimes(2);
    expect(mockGetFeed.mock.calls[1][0]).toEqual({
      type: 'for_you',
      limit: 20,
      filters: { topic: 'science' },
    });
    expect(setFeedItems).toHaveBeenCalledTimes(1);
    expect(appendFeedItems).not.toHaveBeenCalled();
  });

  it('tries recovery only once per cursor when the replacement also fails', async () => {
    mockGetFeed.mockRejectedValue({ status: 410, code: 'FEED_CURSOR_EXPIRED' });
    await usePostsStore.getState().loadMoreFeed('for_you');
    expect(mockGetFeed).toHaveBeenCalledTimes(2);
    await usePostsStore.getState().loadMoreFeed('for_you');
    expect(mockGetFeed).toHaveBeenCalledTimes(2);
  });

  it('never refreshes with new account credentials after an outgoing request fails', async () => {
    let fail!: (error: unknown) => void;
    mockGetFeed.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    const pending = usePostsStore.getState().loadMoreFeed('for_you');
    usePostsStore.getState().resetViewerState({ clearCachedData: true });
    fail({ status: 410, code: 'FEED_CURSOR_EXPIRED' });
    await pending;
    expect(mockGetFeed).toHaveBeenCalledTimes(1);
  });
});
