/**
 * Every post read writes its authors through a writer taken BEFORE the request,
 * which is bound to the account that asked (`lib/actorCache`). Taken after the
 * answer it would be the next account's, and the previous viewer's
 * `relationship` would land in it.
 */
import { actorWriter } from '@/lib/actorCache';
import { precacheActorsFromPosts } from '@/lib/precacheActorsFromPosts';
import { usePostsStore } from '../postsStore';

const mockOrder: string[] = [];
const mockRead = jest.fn();

jest.mock('@/db', () => ({
  upsertPost: jest.fn(),
  upsertPosts: jest.fn(),
  getPostById: () => null,
  setFeedItems: jest.fn(),
  appendFeedItems: () => 0,
  getAllFeedItems: () => [],
  getFeedMeta: () => ({ hasMore: true, nextCursor: 'next' }),
  clearFeed: jest.fn(),
  addFeedItemAtStart: jest.fn(),
  buildFeedKey: (type: string, userId?: string) => (userId ? `user:${userId}:${type}` : type),
  getDb: () => null,
  clearAllCachedData: jest.fn(),
}));
jest.mock('@/services/feedService', () => ({
  feedService: {
    getFeed: () => mockRead(),
    getUserFeed: () => mockRead(),
    getSavedPosts: () => mockRead(),
  },
}));
jest.mock('@/services/echoGuard', () => ({ markLocalAction: jest.fn() }));
jest.mock('@/stores/engagementInvalidation', () => ({ invalidateEngagementLists: jest.fn() }));
jest.mock('@/stores/feedQueryCache', () => ({
  publishNewLocalPost: jest.fn(),
  publishRemovedLocalPost: jest.fn(),
}));
jest.mock('@/lib/actorCache', () => ({
  actorWriter: jest.fn(() => {
    mockOrder.push('writer');
    return { cacheActors: () => {}, cacheActor: () => {} };
  }),
}));
jest.mock('@/lib/precacheActorsFromPosts', () => ({ precacheActorsFromPosts: jest.fn() }));
jest.mock('@oxy.so/core/logger', () => ({
  ...jest.requireActual('@oxy.so/core/logger'),
  createLogger: () => ({ debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
}));

const page = { items: [], hasMore: false, data: { posts: [], hasMore: false } };
const store = () => usePostsStore.getState();

describe('post reads and the actor cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOrder.length = 0;
    mockRead.mockImplementation(async () => {
      mockOrder.push('request');
      return page;
    });
    store().resetViewerState({ clearCachedData: true });
  });

  it.each([
    ['fetchFeed', () => store().fetchFeed({ type: 'for_you' })],
    ['fetchUserFeed', () => store().fetchUserFeed('person', { type: 'posts' })],
    ['fetchSavedPosts', () => store().fetchSavedPosts({})],
    ['refreshFeed', () => store().refreshFeed('for_you')],
    ['loadMoreFeed', () => store().loadMoreFeed('for_you')],
  ] as const)(
    '%s takes its writer before the request and writes through it',
    async (_name, read) => {
      await read();

      expect(mockOrder).toEqual(['writer', 'request']);
      const writer = jest.mocked(actorWriter).mock.results[0]?.value;
      expect(precacheActorsFromPosts).toHaveBeenCalledWith([], writer);
    },
  );
});
