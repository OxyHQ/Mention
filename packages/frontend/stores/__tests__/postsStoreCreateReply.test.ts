import type { FeedItem } from '@/db';
import type { HydratedPost } from '@mention/shared-types';
import { usePostsStore } from '../postsStore';

/**
 * A reply the server accepted reaches the thread it answers (OxyHQ/Mention#1140).
 *
 * `createReply` bumped the parent's count and returned nothing, so the thread's
 * replies list — a scoped feed no other write reaches — kept its empty state
 * until a pull-to-refresh. It now caches the hydrated reply the server returns
 * and publishes it for that list (`useFeedState` puts it on top), and a refused
 * reply publishes nothing.
 */

const mockPosts = new Map<string, FeedItem>();
const mockCreateReply = jest.fn();
const mockPublishNewLocalReply = jest.fn();

jest.mock('@/services/feedService', () => ({
  feedService: {
    createReply: (...args: unknown[]) => mockCreateReply(...args),
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
  publishNewLocalReply: (...args: unknown[]) => mockPublishNewLocalReply(...args),
  publishRemovedLocalPost: jest.fn(),
}));
jest.mock('@oxy.so/core/logger', () => ({
  ...jest.requireActual('@oxy.so/core/logger'),
  createLogger: () => ({ debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
}));

const PARENT = 'parent-1';

function hydratedReply(): HydratedPost {
  return {
    id: 'reply-1',
    parentPostId: PARENT,
    user: { id: 'viewer' },
    content: { text: 'hello' },
    engagement: { likes: 0, replies: 0, boosts: 0, saves: 0, downvotes: 0 },
    viewerState: { isOwner: true, isLiked: false, isBoosted: false, isSaved: false, isDownvoted: false },
    metadata: {},
    attachments: {},
    createdAt: '2026-09-25T12:00:00Z',
  } as unknown as HydratedPost;
}

describe('postsStore.createReply', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPosts.clear();
    mockPosts.set(PARENT, {
      id: PARENT,
      engagement: { likes: 0, replies: 0, boosts: 0, saves: 0, downvotes: 0 },
    } as unknown as FeedItem);
  });

  it('caches the server’s reply, hands it to the thread, and returns it', async () => {
    mockCreateReply.mockResolvedValue({ success: true, reply: hydratedReply() });

    const reply = await usePostsStore.getState().createReply({ postId: PARENT, content: { text: 'hello' } });

    expect(reply?.id).toBe('reply-1');
    expect(mockPosts.get('reply-1')?.parentPostId).toBe(PARENT);
    expect(mockPublishNewLocalReply).toHaveBeenCalledTimes(1);
    expect(mockPublishNewLocalReply.mock.calls[0][0]).toMatchObject({ id: 'reply-1', parentPostId: PARENT });
    expect(mockPosts.get(PARENT)?.engagement.replies).toBe(1);
  });

  it('publishes nothing when the server refuses the reply, and rolls the count back', async () => {
    mockCreateReply.mockResolvedValue({ success: false, reply: null });

    await expect(
      usePostsStore.getState().createReply({ postId: PARENT, content: { text: 'hello' } }),
    ).rejects.toThrow();

    expect(mockPublishNewLocalReply).not.toHaveBeenCalled();
    expect(mockPosts.get(PARENT)?.engagement.replies).toBe(0);
  });
});
