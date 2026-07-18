/**
 * `searchService.searchAll` — the "All" tab fan-out — must gate its auth-only
 * sources on `canUsePrivateApi`.
 *
 * During the SSO cold-boot the viewer can be authenticated for 5–25s BEFORE the
 * private API is ready. Firing the auth-gated search sources (posts via
 * `/search`, lists via `/lists`, saved via `/posts/saved`) in that window 401s —
 * console noise, not a result — and, because the search query used to key on
 * `isAuthenticated` (unchanged), it never refetched, so those sections stayed
 * empty even after the session landed.
 *
 * The fix gates those three sources on `canUsePrivateApi` (and keys the query on
 * it, so it refetches when the private API lands). The PUBLIC sources — people
 * via Oxy, feeds via the public client, hashtags on the public router — must run
 * for every viewer regardless. These tests assert at the transport boundary:
 * which underlying request each source makes, and whether it fired at all.
 */

const mockAuthGet = jest.fn();
const mockPublicGet = jest.fn();
const mockSearchProfiles = jest.fn();
const mockGetProfileByUsername = jest.fn();
const mockGetSavedPosts = jest.fn();

// `/hashtags/search` and `/feeds` sit on the backend's PUBLIC router, so they
// never 401 — `authenticatedClient` just attaches a token when one exists.
// `/search` and `/lists` are on the authenticated router and are the 401 sources.
jest.mock('@/utils/api', () => ({
  authenticatedClient: { get: (...args: unknown[]) => mockAuthGet(...args) },
  publicClient: { get: (...args: unknown[]) => mockPublicGet(...args) },
  isUnauthorizedError: () => false,
}));

jest.mock('@/lib/oxyServices', () => ({
  oxyServices: {
    searchProfiles: (...args: unknown[]) => mockSearchProfiles(...args),
    getProfileByUsername: (...args: unknown[]) => mockGetProfileByUsername(...args),
  },
}));

jest.mock('@/services/feedService', () => ({
  feedService: {
    getSavedPosts: (...args: unknown[]) => mockGetSavedPosts(...args),
  },
}));

jest.mock('@/utils/storage', () => ({
  Storage: { get: jest.fn(), set: jest.fn(), remove: jest.fn() },
}));

jest.mock('@/lib/logger', () => ({
  createScopedLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import { searchService } from '@/services/searchService';

beforeEach(() => {
  jest.clearAllMocks();

  mockAuthGet.mockImplementation((url: string) => {
    switch (url) {
      case '/search':
        return Promise.resolve({ data: { posts: [{ id: 'p1', content: {} }] } });
      case '/lists':
        return Promise.resolve({ data: { items: [{ id: 'l1', name: 'List One' }] } });
      case '/hashtags/search':
        return Promise.resolve({ data: { hashtags: [{ tag: 'oxy', count: 3 }] } });
      default:
        return Promise.reject(new Error(`unexpected authenticated GET ${url}`));
    }
  });

  mockPublicGet.mockImplementation((url: string) => {
    if (url === '/feeds') return Promise.resolve({ data: { items: [{ id: 'f1', title: 'Feed One' }] } });
    return Promise.reject(new Error(`unexpected public GET ${url}`));
  });

  mockSearchProfiles.mockResolvedValue({
    data: [{ id: 'u1', username: 'oxy' }],
    pagination: { offset: 0, limit: 20, hasMore: false },
  });

  mockGetSavedPosts.mockResolvedValue({ success: true, data: { posts: [{ id: 's1', content: {} }] } });
});

describe('searchService.searchAll auth gating', () => {
  it('runs only the public sources when the private API is NOT ready', async () => {
    const result = await searchService.searchAll('oxy', false);

    // Public sources always run.
    expect(mockSearchProfiles).toHaveBeenCalled();
    expect(mockPublicGet).toHaveBeenCalledWith('/feeds', expect.anything());
    expect(mockAuthGet).toHaveBeenCalledWith('/hashtags/search', expect.anything());

    // Auth-gated sources must NEVER fire before the private API is ready.
    expect(mockAuthGet).not.toHaveBeenCalledWith('/search', expect.anything());
    expect(mockAuthGet).not.toHaveBeenCalledWith('/lists', expect.anything());
    expect(mockGetSavedPosts).not.toHaveBeenCalled();

    // Public sections populate; the gated sections stay quietly empty.
    expect(result.users).toHaveLength(1);
    expect(result.feeds).toHaveLength(1);
    expect(result.hashtags).toHaveLength(1);
    expect(result.posts).toEqual([]);
    expect(result.lists).toEqual([]);
    expect(result.saved).toEqual([]);
  });

  it('runs every source once the private API IS ready', async () => {
    const result = await searchService.searchAll('oxy', true);

    expect(mockAuthGet).toHaveBeenCalledWith('/search', expect.anything());
    expect(mockAuthGet).toHaveBeenCalledWith('/lists', expect.anything());
    expect(mockAuthGet).toHaveBeenCalledWith('/hashtags/search', expect.anything());
    expect(mockGetSavedPosts).toHaveBeenCalled();
    expect(mockSearchProfiles).toHaveBeenCalled();
    expect(mockPublicGet).toHaveBeenCalledWith('/feeds', expect.anything());

    expect(result.posts).toHaveLength(1);
    expect(result.lists).toHaveLength(1);
    expect(result.saved).toHaveLength(1);
    expect(result.users).toHaveLength(1);
    expect(result.feeds).toHaveLength(1);
    expect(result.hashtags).toHaveLength(1);
  });

  it('still surfaces a total failure of the public sources when signed out', async () => {
    // The gated sources short-circuit to a resolved empty page when signed out;
    // that fulfilled no-op must NOT mask a genuine total failure of the sources
    // that actually ran.
    mockSearchProfiles.mockRejectedValue(new Error('users down'));
    mockGetProfileByUsername.mockRejectedValue(new Error('exact-username fallback down'));
    mockPublicGet.mockRejectedValue(new Error('feeds down'));
    mockAuthGet.mockRejectedValue(new Error('hashtags down'));

    await expect(searchService.searchAll('oxy', false)).rejects.toThrow();
  });
});
