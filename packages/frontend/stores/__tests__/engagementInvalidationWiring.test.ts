import type { FeedItem } from '@/db';
import { usePostsStore } from '../postsStore';

/**
 * Every engagement write must report the list it changed, and only on success.
 *
 * This is the join between the two halves of the fix and the one place a
 * regression would be silent: the read side keeps working perfectly, the write
 * side simply stops speaking, and every surface goes back to needing a reload.
 * `postsStore` is the single write authority — the feed row's commands
 * (`components/Feed/postInteractions.tsx`) and the videos screen both funnel
 * through it — so asserting it here covers every call site at once.
 */

const mockPosts = new Map<string, FeedItem>();

const mockInvalidate = jest.fn();
const mockLocalError = jest.fn();

jest.mock('@/stores/engagementInvalidation', () => ({
  invalidateEngagementLists: (...args: unknown[]) => mockInvalidate(...args),
}));

const mockInvalidateCounts = jest.fn();
jest.mock('@/stores/profileCountsInvalidation', () => ({
  invalidateProfileCounts: (...args: unknown[]) => mockInvalidateCounts(...args),
}));

const mockFeedService = {
  createPost: jest.fn(),
  createThread: jest.fn(),
  createReply: jest.fn(),
  voteItem: jest.fn(),
  removeVote: jest.fn(),
  saveItem: jest.fn(),
  unsaveItem: jest.fn(),
  createBoost: jest.fn(),
  unboostItem: jest.fn(),
};

jest.mock('@/services/feedService', () => ({
  feedService: {
    createPost: (...args: unknown[]) => mockFeedService.createPost(...args),
    createThread: (...args: unknown[]) => mockFeedService.createThread(...args),
    createReply: (...args: unknown[]) => mockFeedService.createReply(...args),
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
jest.mock('@/stores/feedQueryCache', () => ({
  publishNewLocalPost: jest.fn(),
  publishNewLocalReply: jest.fn(),
  publishRemovedLocalPost: jest.fn(),
}));
jest.mock('@oxy.so/core/logger', () => ({
  ...jest.requireActual('@oxy.so/core/logger'),
  createLogger: () => ({
    debug: jest.fn(),
    error: (...args: unknown[]) => mockLocalError(...args),
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
    expect(mockInvalidateCounts).not.toHaveBeenCalled();
  });
});

// The profile read "0 Posts" above the post it had just listed (#1140).
describe('postsStore refreshes the profile counters a write changes', () => {
  const published = (id: string, authorId: string) => ({
    id,
    user: { id: authorId },
    content: { text: id },
    attachments: {},
    documents: [],
    authors: [],
    engagement: { likes: 0, replies: 0, boosts: 0, saves: 0, downvotes: 0 },
    viewerState: {
      isOwner: true,
      isLiked: false,
      isBoosted: false,
      isSaved: false,
      isDownvoted: false,
    },
    permissions: {},
    metadata: { createdAt: '2026-09-25T10:00:00.000Z', status: 'published' },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPosts.clear();
    seedPost();
  });

  it('a published post or reply refreshes its author', async () => {
    mockFeedService.createPost.mockResolvedValue({
      success: true,
      post: published('new-post', 'author-1'),
    });
    await usePostsStore.getState().createPost({ content: { text: 'hi' } } as never);
    expect(mockInvalidateCounts).toHaveBeenCalledWith(expect.anything(), 'author-1');
  });

  it('a published thread refreshes its author', async () => {
    mockFeedService.createThread.mockResolvedValue({
      success: true,
      posts: [published('t-1', 'author-1'), published('t-2', 'author-1')],
    });
    await usePostsStore.getState().createThread({ posts: [] } as never);
    expect(mockInvalidateCounts).toHaveBeenCalledWith(expect.anything(), 'author-1');
  });

  it('a scheduled post changes no counter', async () => {
    mockFeedService.createPost.mockResolvedValue({
      success: true,
      post: {
        ...published('later', 'author-1'),
        metadata: { createdAt: '2026-09-25T10:00:00.000Z', status: 'scheduled' },
      },
    });
    await usePostsStore.getState().createPost({ content: { text: 'later' } } as never);
    expect(mockInvalidateCounts).not.toHaveBeenCalled();
  });

  it("a boost and an unboost refresh the viewer's counters", async () => {
    mockFeedService.createBoost.mockResolvedValue(accepted);
    mockFeedService.unboostItem.mockResolvedValue(accepted);

    await usePostsStore.getState().boostPost({ postId: POST_ID });
    await usePostsStore.getState().unboostPost({ postId: POST_ID });
    expect(mockInvalidateCounts).toHaveBeenCalledTimes(2);
  });
});

describe('publish outcomes after a viewer change', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPosts.clear();
  });

  it.each(['createPost', 'createThread', 'createReply'] as const)(
    '%s keeps a successful stale response out of the new viewer state',
    async (method) => {
      let complete!: (value: unknown) => void;
      mockFeedService[method].mockImplementation(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      const request =
        method === 'createPost'
          ? { content: { text: 'A' } }
          : method === 'createThread'
            ? { posts: [] }
            : { postId: 'parent', content: { text: 'A' } };
      const operation = usePostsStore.getState()[method](request as never);
      usePostsStore.getState().resetViewerState({ clearCachedData: true });
      usePostsStore.setState({ error: 'B state', isLoading: true });
      complete({ success: true, post: { id: 'a' }, posts: [{ id: 'a' }], reply: { id: 'a' } });
      await expect(operation).resolves.toEqual(method === 'createThread' ? [] : null);
      expect(usePostsStore.getState()).toMatchObject({ error: 'B state', isLoading: true });
      expect(mockPosts.size).toBe(0);
    },
  );

  it.each(['createPost', 'createThread', 'createReply'] as const)(
    '%s propagates a stale HTTP failure without changing the new viewer state',
    async (method) => {
      let reject!: (error: Error) => void;
      mockFeedService[method].mockImplementation(
        () =>
          new Promise((_resolve, rejectPromise) => {
            reject = rejectPromise;
          }),
      );
      const request =
        method === 'createPost'
          ? { content: { text: 'A' } }
          : method === 'createThread'
            ? { posts: [] }
            : { postId: 'parent', content: { text: 'A' } };
      const operation = usePostsStore.getState()[method](request as never);
      const expected = expect(operation).rejects.toThrow('HTTP 500');
      usePostsStore.getState().resetViewerState({ clearCachedData: true });
      usePostsStore.setState({ error: 'B state', isLoading: true });
      reject(new Error('HTTP 500'));
      await expected;
      expect(usePostsStore.getState()).toMatchObject({ error: 'B state', isLoading: true });
      expect(mockPosts.size).toBe(0);
    },
  );

  it.each(['createPost', 'createThread', 'createReply'] as const)(
    '%s propagates an ambiguous session-change outcome without changing the new viewer state',
    async (method) => {
      let reject!: (error: Error) => void;
      mockFeedService[method].mockImplementation(
        () =>
          new Promise((_resolve, rejectPromise) => {
            reject = rejectPromise;
          }),
      );
      const request =
        method === 'createPost'
          ? { content: { text: 'A' } }
          : method === 'createThread'
            ? { posts: [] }
            : { postId: 'parent', content: { text: 'A' } };
      const operation = usePostsStore.getState()[method](request as never);
      const expected = expect(operation).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
      usePostsStore.getState().resetViewerState({ clearCachedData: true });
      usePostsStore.setState({ error: 'B state', isLoading: true });
      reject(Object.assign(new Error('Outcome unknown'), { code: 'AUTH_SESSION_CHANGED' }));
      await expected;
      expect(usePostsStore.getState()).toMatchObject({ error: 'B state', isLoading: true });
      expect(mockPosts.size).toBe(0);
    },
  );

  it.each(['createPost', 'createThread', 'createReply'] as const)(
    '%s rejects a negative or incomplete response while viewer is current',
    async (method) => {
      const request =
        method === 'createPost'
          ? { content: { text: 'A' } }
          : method === 'createThread'
            ? { posts: [{ content: { text: 'A' } }] }
            : { postId: 'parent', content: { text: 'A' } };
      for (const result of [
        { success: false, post: null, posts: [], reply: null },
        { success: true, post: null, posts: [], reply: null },
      ]) {
        mockFeedService[method].mockResolvedValueOnce(result);
        await expect(usePostsStore.getState()[method](request as never)).rejects.toThrow();
      }
    },
  );
});

it.each(['createPost', 'createThread', 'createReply'] as const)(
  '%s preserves confirmed success when updating the local cache fails',
  async (method) => {
    const post = {
      id: 'confirmed',
      user: { id: 'author' },
      content: { text: 'hi' },
      attachments: {},
      documents: [],
      authors: [],
      engagement: { likes: 0, replies: 0, boosts: 0, saves: 0, downvotes: 0 },
      viewerState: {},
      permissions: {},
      metadata: { createdAt: '2026-09-25T10:00:00.000Z', status: 'published' },
    };
    const cache = jest.requireMock('@/stores/feedQueryCache');
    const update =
      method === 'createReply' ? cache.publishNewLocalReply : cache.publishNewLocalPost;
    update.mockImplementationOnce(() => {
      usePostsStore.getState().resetViewerState({ clearCachedData: true });
      usePostsStore.setState({ error: 'B state', isLoading: true });
      throw new Error('local cache failed');
    });
    mockFeedService[method].mockResolvedValueOnce({
      success: true,
      post,
      posts: [post],
      reply: post,
    });
    const request =
      method === 'createPost'
        ? { content: { text: 'hi' } }
        : method === 'createThread'
          ? { posts: [{ content: { text: 'hi' } }] }
          : { postId: 'parent', content: { text: 'hi' } };
    await expect(usePostsStore.getState()[method](request as never)).resolves.toBeTruthy();
    expect(mockLocalError).toHaveBeenCalledWith(
      expect.stringContaining('local cache update failed'),
      expect.any(Error),
    );
    expect(usePostsStore.getState()).toMatchObject({ error: 'B state', isLoading: true });
  },
);

it.each(['createPost', 'createThread', 'createReply'] as const)(
  '%s keeps confirmation even when the returned model cannot be hydrated locally',
  async (method) => {
    const partial = { id: 'confirmed-id' };
    mockFeedService[method].mockResolvedValueOnce({
      success: true,
      post: partial,
      posts: [partial],
      reply: partial,
    });
    const request =
      method === 'createPost'
        ? { content: { text: 'hi' } }
        : method === 'createThread'
          ? { posts: [{ content: { text: 'hi' } }] }
          : { postId: 'parent', content: { text: 'hi' } };
    await expect(usePostsStore.getState()[method](request as never)).resolves.toEqual(
      method === 'createThread' ? [] : null,
    );
    expect(mockLocalError).toHaveBeenCalledWith(
      expect.stringContaining('local cache update failed'),
      expect.any(Error),
    );
  },
);
