import type { HydratedPost } from '@mention/shared-types';
import { PostVisibility } from '@mention/shared-types/post';
import { searchService } from '../searchService';

const mockAuthGet = jest.fn();
const mockPublicGet = jest.fn();
const mockSearchProfiles = jest.fn();
const mockGetProfileByUsername = jest.fn();
const mockGetSavedPosts = jest.fn();

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

jest.mock('@oxyhq/core/logger', () => ({
  ...jest.requireActual('@oxyhq/core/logger'),
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
    mockPublicGet.mockResolvedValue({ data: { items: [] } });
    mockSearchProfiles.mockResolvedValue({
      data: [],
      pagination: { offset: 0, limit: 20, hasMore: false },
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
    expect(mockAuthGet).toHaveBeenCalledWith(
      '/lists',
      expect.objectContaining({ signal }),
    );
    expect(mockGetSavedPosts).toHaveBeenCalledWith(
      expect.objectContaining({ signal }),
    );
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
