import type { FeedItem } from '@/db';
import { getCachedAncestorChain } from '../postsStore';

/**
 * The ancestor chain has to be on screen in the FIRST commit.
 *
 * The post-detail screen's ancestor walk is async and sets state from an effect
 * — after the browser has already painted — so a fully cached thread showed the
 * focused post alone for a frame and then pushed it down as its parents
 * appeared. Opening a post from a feed is exactly the case where every ancestor
 * is already cached, which is to say the common case was the janky one.
 *
 * What can break here is the walk itself: order, bounds, and where it stops. A
 * version that SKIPPED an uncached hop would return a chain with a hole in it
 * and render parents out of order under the focused post — worse than the jank
 * it replaced, and invisible until someone opened a partially cached thread.
 */

const mockCache = new Map<string, FeedItem>();

jest.mock('@/db', () => ({
  getPostById: (postId: string) => mockCache.get(postId) ?? null,
  upsertPost: jest.fn(),
  upsertPosts: jest.fn(),
  updatePost: () => null,
  deletePost: jest.fn(),
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
  clearAllCachedData: () => mockCache.clear(),
}));

jest.mock('@/services/feedService', () => ({ feedService: {} }));
jest.mock('@/services/echoGuard', () => ({ markLocalAction: jest.fn() }));
jest.mock('@/stores/engagementInvalidation', () => ({ invalidateEngagementLists: jest.fn() }));
jest.mock('@/lib/precacheActorsFromPosts', () => ({ precacheActorsFromPosts: jest.fn() }));
jest.mock('@/stores/feedScrollStore', () => ({
  publishNewLocalPost: jest.fn(),
  publishRemovedLocalPost: jest.fn(),
}));
jest.mock('@oxyhq/core/logger', () => ({
  ...jest.requireActual('@oxyhq/core/logger'),
  createLogger: () => ({ debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
}));

/**
 * A cached row. Only `id` and `parentPostId` are read by the walk, so the rest
 * of `FeedItem` is deliberately absent — a full fixture would suggest the walk
 * depends on fields it never touches.
 */
function seed(id: string, parentPostId?: string): void {
  mockCache.set(id, { id, parentPostId } as FeedItem);
}

const ids = (chain: FeedItem[]): string[] => chain.map((post) => post.id);

beforeEach(() => {
  mockCache.clear();
});

describe('getCachedAncestorChain', () => {
  it('returns the fully cached chain root first', () => {
    seed('root');
    seed('mid', 'root');
    seed('leaf', 'mid');

    expect(ids(getCachedAncestorChain('leaf', 'mid'))).toEqual(['root', 'mid']);
  });

  it('stops at the first uncached hop instead of skipping it', () => {
    // `root` is referenced but NOT cached. `['root','mid']` would be a fabrication
    // and `['mid']` is the honest partial answer — the async walk fetches the rest
    // and replaces the whole chain.
    seed('mid', 'root');
    seed('leaf', 'mid');

    expect(ids(getCachedAncestorChain('leaf', 'mid'))).toEqual(['mid']);
  });

  it('is empty for a root post, and empty on a cold cache', () => {
    seed('leaf');
    expect(getCachedAncestorChain('leaf', undefined)).toEqual([]);

    mockCache.clear();
    expect(getCachedAncestorChain('leaf', 'mid')).toEqual([]);
  });

  it('breaks a cycle rather than looping', () => {
    seed('a', 'b');
    seed('b', 'a');
    seed('leaf', 'a');

    expect(ids(getCachedAncestorChain('leaf', 'a'))).toEqual(['b', 'a']);
  });

  it('breaks a cycle that points back at the focused post', () => {
    // `visited` is seeded with the focused post for this case specifically.
    seed('a', 'leaf');
    seed('leaf', 'a');

    expect(ids(getCachedAncestorChain('leaf', 'a'))).toEqual(['a']);
  });

  it('stops at the depth cap on a long chain', () => {
    // 40 cached ancestors against a cap of 30. Without the bound this walks the
    // whole chain; with it, the async walk owns everything past the cap.
    seed('p0');
    for (let index = 1; index <= 40; index += 1) seed(`p${index}`, `p${index - 1}`);
    seed('leaf', 'p40');

    const chain = getCachedAncestorChain('leaf', 'p40');
    expect(chain).toHaveLength(30);
    // Root first, so the LAST entry is the immediate parent.
    expect(chain[chain.length - 1]?.id).toBe('p40');
  });
});
