import { setFeedItems, appendFeedItems } from '@/db';
import type { FeedItem } from '@/db';
import { usePostsStore } from '../postsStore';
import {
  notifyFeedRankingChanged,
  subscribeToFeedRankingChanges,
} from '../feedRankingInvalidation';

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

describe('native feed social evidence lifetime', () => {
  beforeEach(() => {
    mockGetFeed.mockReset();
    usePostsStore.getState().resetViewerState({ clearCachedData: true });
    mockGetFeedMeta.mockReturnValue({ hasMore: true, nextCursor: 'fs1:next' });
  });
  const context = (postId: string) => ({
    type: 'likedBy',
    postId,
    actors: [{ id: 'known', name: { displayName: 'Known' } }],
    total: 1,
  });
  const page = (postId: string) => ({
    items: [],
    hasMore: true,
    slices: [{ _sliceKey: postId, items: [], socialContext: context(postId) }],
  });

  it('appends evidence only to its feed, replaces it on refresh and clears it on account change', async () => {
    mockGetFeed
      .mockResolvedValueOnce(page('first'))
      .mockResolvedValueOnce(page('second'))
      .mockResolvedValueOnce({ items: [], hasMore: false });
    await usePostsStore.getState().fetchFeed({ type: 'for_you' });
    await usePostsStore.getState().loadMoreFeed('for_you');
    expect(usePostsStore.getState().feedUI.for_you.socialContexts).toEqual([
      context('first'),
      context('second'),
    ]);
    expect(usePostsStore.getState().feedUI.following).toBeUndefined();
    await usePostsStore.getState().refreshFeed('for_you');
    expect(usePostsStore.getState().feedUI.for_you.socialContexts).toBeUndefined();
    usePostsStore.getState().resetViewerState({ clearCachedData: true });
    expect(usePostsStore.getState().feedUI).toEqual({});
  });

  it('does not install an outgoing viewer’s evidence after account reset', async () => {
    let resolvePage: ((value: ReturnType<typeof page>) => void) | undefined;
    mockGetFeed.mockReturnValueOnce(
      new Promise<ReturnType<typeof page>>((resolve) => {
        resolvePage = resolve;
      }),
    );
    const pending = usePostsStore.getState().fetchFeed({ type: 'for_you' });
    usePostsStore.getState().resetViewerState({ clearCachedData: true });
    if (!resolvePage) throw new Error('Feed request was not started');
    resolvePage(page('outgoing'));
    await pending;
    expect(usePostsStore.getState().feedUI).toEqual({});
  });
});

it.each(['initial', 'continuation'] as const)(
  'a mute rule refresh supersedes a pending native %s read',
  async (kind) => {
    jest.clearAllMocks();
    mockGetFeed.mockReset();
    usePostsStore.getState().resetViewerState({ clearCachedData: true });
    mockGetFeedMeta.mockReturnValue({ hasMore: true, nextCursor: 'fs1:old' });
    let finishOld:
      | ((value: { items: never[]; slices: unknown[]; hasMore: boolean }) => void)
      | undefined;
    let finishFresh: ((value: { items: never[]; hasMore: boolean }) => void) | undefined;
    mockGetFeed.mockReturnValueOnce(
      new Promise((resolve) => {
        finishOld = resolve;
      }),
    );
    const oldRead =
      kind === 'initial'
        ? usePostsStore.getState().fetchFeed({ type: 'for_you' })
        : usePostsStore.getState().loadMoreFeed('for_you');
    const signal: AbortSignal = mockGetFeed.mock.calls[0][1].signal;
    mockGetFeed.mockReturnValueOnce(
      new Promise((resolve) => {
        finishFresh = resolve;
      }),
    );
    let refresh: Promise<void> | undefined;
    const stop = subscribeToFeedRankingChanges({ type: 'for_you', viewerId: 'mute-reader' }, () => {
      refresh = usePostsStore.getState().refreshFeed('for_you', undefined, true);
    });
    notifyFeedRankingChanged('mute-reader');
    expect(signal.aborted).toBe(true);
    expect(mockGetFeed).toHaveBeenCalledTimes(2);
    if (!finishOld || !finishFresh) throw new Error('Both reads must start');
    finishOld({
      items: [],
      hasMore: true,
      slices: [{ socialContext: { type: 'likedBy', postId: 'stale', actors: [], total: 1 } }],
    });
    await oldRead;
    expect(appendFeedItems).not.toHaveBeenCalled();
    expect(setFeedItems).not.toHaveBeenCalled();
    expect(usePostsStore.getState().feedUI.for_you.isLoading).toBe(true);
    finishFresh({ items: [], hasMore: false });
    await refresh;
    expect(setFeedItems).toHaveBeenCalledTimes(1);
    expect(usePostsStore.getState().feedUI.for_you.socialContexts).toBeUndefined();
    expect(usePostsStore.getState().feedUI.for_you.isLoading).toBe(false);
    stop();
  },
);
