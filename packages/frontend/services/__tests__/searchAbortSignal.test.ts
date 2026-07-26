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

jest.mock('@/lib/logger', () => ({
  createScopedLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import { searchService } from '../searchService';

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
});
