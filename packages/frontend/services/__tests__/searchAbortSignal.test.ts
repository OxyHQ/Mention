import type { HydratedPost } from '@mention/shared-types';
import { PostVisibility } from '@mention/shared-types/post';
import { searchService } from '../searchService';

const mockAuthGet = jest.fn();
const mockPublicGet = jest.fn();
const mockSearchProfiles = jest.fn();
const mockGetProfileByUsername = jest.fn();
const mockGetSavedPosts = jest.fn();
const mockOxyHttpGet = jest.fn();

jest.mock('@/utils/api', () => ({
  authenticatedClient: {
    get: (...args: unknown[]) => mockAuthGet(...args),
  },
  publicClient: {
    get: (...args: unknown[]) => mockPublicGet(...args),
  },
  isUnauthorizedError: () => false,
}));

jest.mock('@/lib/oxyServices', () => ({
  oxyServices: {
    searchProfiles: (...args: unknown[]) => mockSearchProfiles(...args),
    getProfileByUsername: (...args: unknown[]) =>
      mockGetProfileByUsername(...args),
    // People search goes through the raw `httpService` seam rather than
    // `searchProfiles`, because that SDK method takes no `AbortSignal`. The mock
    // has to carry it or the people lane silently falls into its
    // exact-username fallback and the signal assertion below passes vacuously.
    httpService: {
      get: (...args: unknown[]) => mockOxyHttpGet(...args),
    },
  },
}));

jest.mock('@/services/feedService', () => ({
  feedService: {
    getSavedPosts: (...args: unknown[]) => mockGetSavedPosts(...args),
  },
}));

jest.mock('@/utils/storage', () => ({
  Storage: {
    get: jest.fn(),
    set: jest.fn(),
    remove: jest.fn(),
  },
}));

jest.mock('@oxy.so/core/logger', () => ({
  ...jest.requireActual('@oxy.so/core/logger'),
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

const canonicalSearchPost: HydratedPost = {
  id: 'post-search-1',
  content: { text: 'canonical result' },
  attachments: {},
  user: {
    id: 'author-1',
    username: 'alice',
    name: { displayName: 'Alice' },
  },
  authors: [{
    id: 'author-1',
    username: 'alice',
    name: { displayName: 'Alice' },
    role: 'owner',
    status: 'accepted',
  }],
  engagement: {
    likes: 1,
    downvotes: 0,
    boosts: 0,
    replies: 0,
  },
  viewerState: {
    isOwner: false,
    isCollaborator: false,
    isLiked: true,
    isDownvoted: false,
    isBoosted: false,
    isSaved: false,
  },
  permissions: {
    canReply: true,
    canDelete: false,
    canPin: false,
    canViewSources: false,
  },
  metadata: {
    visibility: PostVisibility.PUBLIC,
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
  },
};

/** A minimal, well-formed overview body: every lane present with a status. */
function overviewBody(): unknown {
  const lane = { status: 'ok', items: [], hasMore: false, tookMs: 1 };
  return {
    query: 'mention',
    lanes: {
      profiles: { ...lane, status: 'skipped' },
      posts: { ...lane, status: 'unavailable' },
      saved: { ...lane, status: 'unavailable' },
      hashtags: lane,
      lists: lane,
      feeds: lane,
      starterPacks: lane,
    },
    degraded: true,
    servedFromCache: false,
  };
}

describe('search AbortSignal propagation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthGet.mockImplementation((url: string) => {
      if (url === '/search') {
        return Promise.resolve({
          data: { posts: [], hasMore: false },
        });
      }
      if (url === '/lists') {
        return Promise.resolve({
          data: {
            items: [],
            pagination: {
              offset: 0,
              limit: 20,
              hasMore: false,
            },
          },
        });
      }
      if (url === '/hashtags/search') {
        return Promise.resolve({ data: { hashtags: [] } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    mockPublicGet.mockImplementation((url: string) => {
      if (url === '/search/overview') {
        return Promise.resolve({ data: overviewBody() });
      }
      return Promise.resolve({ data: { items: [] } });
    });
    mockSearchProfiles.mockResolvedValue({
      data: [],
      pagination: { offset: 0, limit: 20, hasMore: false },
    });
    mockOxyHttpGet.mockResolvedValue({
      data: [],
      pagination: { total: 0, offset: 0, limit: 20, hasMore: false },
    });
    mockGetSavedPosts.mockResolvedValue({
      success: true,
      data: { posts: [], hasMore: false },
    });
  });

  it('passes one query-owned signal to every private source in searchAll', async () => {
    const signal = new AbortController().signal;

    await searchService.searchAll('mention', true, signal);

    expect(mockAuthGet).toHaveBeenCalledWith(
      '/search',
      expect.objectContaining({ signal }),
    );
    expect(mockPublicGet).toHaveBeenCalledWith(
      '/search/overview',
      expect.objectContaining({ signal }),
    );
    expect(mockGetSavedPosts).toHaveBeenCalledWith(
      expect.objectContaining({ signal }),
    );
  });

  it('issues FOUR requests for the overview, not seven', async () => {
    const signal = new AbortController().signal;

    await searchService.searchAll('mention', true, signal);

    // Hashtags, lists, feeds and starter packs are now ONE server-side lane
    // fan-out, so none of their endpoints is called from here any more. What
    // remains is people (Oxy's own), posts and saved.
    const publicUrls = mockPublicGet.mock.calls.map(([url]) => url);
    const authUrls = mockAuthGet.mock.calls.map(([url]) => url);
    expect(publicUrls).toEqual(['/search/overview']);
    expect(authUrls).toEqual(['/search']);
    expect(authUrls).not.toContain('/lists');
    expect(authUrls).not.toContain('/hashtags/search');
    expect(publicUrls).not.toContain('/feeds');
    expect(publicUrls).not.toContain('/starter-packs');
  });

  it('reports a failed lane as empty rather than inventing results', async () => {
    const body = overviewBody() as { lanes: Record<string, { status: string; items: unknown[] }> };
    body.lanes.feeds = { status: 'error', items: [], hasMore: false, tookMs: 5 } as never;
    mockPublicGet.mockImplementation((url: string) =>
      Promise.resolve({ data: url === '/search/overview' ? body : { items: [] } }),
    );

    const results = await searchService.searchAll('mention', true);

    // The lane's failure reaches the client as a STATUS now — previously
    // `allSettled` collapsed a rejection into an empty section and the client
    // could not tell the two apart at all.
    expect(results.feeds).toEqual([]);
  });

  // People was the ONE lane that could not be cancelled: `searchProfiles` takes
  // no signal, so every keystroke started a profile search that ran to
  // completion and had its result discarded while holding a request-queue slot.
  // Since it is also the slowest lane (Oxy's `/profiles/search` has no trigram
  // index on `users`), those were the requests starving the live one.
  it('passes the query-owned signal to the people lane, which could not be cancelled', async () => {
    const signal = new AbortController().signal;

    await searchService.searchAll('mention', true, signal);

    expect(mockOxyHttpGet).toHaveBeenCalledWith(
      '/profiles/search',
      expect.objectContaining({
        params: expect.objectContaining({ query: 'mention' }),
        signal,
      }),
    );
    // `searchProfiles` is the un-cancellable path. Nothing in search may use it.
    expect(mockSearchProfiles).not.toHaveBeenCalled();
  });

  // The SDK retries anything whose status is not 4xx, and an AbortError carries
  // `status: 0`. A cancellation is an instruction, not a transient failure, so
  // it must never reach a fallback lookup or a retry.
  it('propagates a cancellation instead of falling back to an exact-username lookup', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mockOxyHttpGet.mockRejectedValueOnce(abortError);

    await expect(searchService.searchUsers('mention')).rejects.toThrow(abortError);
    expect(mockGetProfileByUsername).not.toHaveBeenCalled();
  });

  it('still falls back to an exact-username lookup on a REAL people-search failure', async () => {
    mockOxyHttpGet.mockRejectedValueOnce(new Error('upstream exploded'));
    mockGetProfileByUsername.mockResolvedValueOnce({ id: 'u1', username: 'mention' });

    await expect(searchService.searchUsers('mention')).resolves.toEqual([
      { id: 'u1', username: 'mention' },
    ]);
    expect(mockGetProfileByUsername).toHaveBeenCalledWith('mention');
  });

  it('passes the signal through paginated private searches', async () => {
    const signal = new AbortController().signal;

    await searchService.searchPostsPage('mention', 'cursor-v1', signal);
    await searchService.searchListsPage('mention', 20, signal);
    await searchService.searchSavedPage('mention', 2, signal);

    expect(mockAuthGet).toHaveBeenCalledWith(
      '/search',
      expect.objectContaining({
        params: expect.objectContaining({ cursor: 'cursor-v1' }),
        signal,
      }),
    );
    expect(mockAuthGet).toHaveBeenCalledWith(
      '/lists',
      expect.objectContaining({
        params: expect.objectContaining({ offset: 20 }),
        signal,
      }),
    );
    expect(mockGetSavedPosts).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, signal }),
    );
  });

  it('passes the signal through the paginated people tab', async () => {
    const signal = new AbortController().signal;

    await searchService.searchUsersPage('mention', 20, signal);

    expect(mockOxyHttpGet).toHaveBeenCalledWith(
      '/profiles/search',
      expect.objectContaining({
        params: expect.objectContaining({ query: 'mention', offset: 20 }),
        signal,
      }),
    );
  });

  it('returns search posts on the canonical hydrated contract', async () => {
    mockAuthGet.mockResolvedValueOnce({
      data: { posts: [canonicalSearchPost], hasMore: false },
    });

    const page = await searchService.searchPostsPage('canonical');

    expect(page.posts).toEqual([canonicalSearchPost]);
    expect(page.posts[0]?.viewerState.isLiked).toBe(true);
    expect(page.posts[0]).not.toHaveProperty('_id');
    expect(page.posts[0]).not.toHaveProperty('isLiked');
    expect(page.posts[0]?.user).not.toHaveProperty('handle');
  });

  it('does not admit partial legacy saved-post rows into search results', async () => {
    mockGetSavedPosts.mockResolvedValueOnce({
      success: true,
      data: {
        posts: [{
          id: 'legacy-post',
          content: { text: 'missing canonical state' },
          isSaved: true,
        }],
        hasMore: false,
      },
    });

    await expect(searchService.searchSaved('legacy')).resolves.toEqual([]);
  });
});
