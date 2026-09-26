/**
 * `feedService`'s bookmark-folder calls, against the routes the backend serves.
 *
 * Creating a folder is a server write now: it used to be component state on
 * the Saved screen and vanished on reload (OxyHQ/Mention#1124).
 */

const mockAuthenticatedGet = jest.fn();
const mockAuthenticatedPost = jest.fn();

jest.mock('@/utils/api', () => ({
  authenticatedClient: {
    get: (...args: unknown[]) => mockAuthenticatedGet(...args),
    post: (...args: unknown[]) => mockAuthenticatedPost(...args),
  },
  publicClient: {},
  isNotFoundError: () => false,
}));

jest.mock('@/lib/oxyServices', () => ({
  oxyServices: {
    getClient: () => ({ getAccessToken: () => 'token' }),
    getCurrentUserId: () => 'viewer-1',
  },
}));

jest.mock('@oxy.so/core/logger', () => ({
  ...jest.requireActual('@oxy.so/core/logger'),
  logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

// eslint-disable-next-line import/first
import { feedService } from '../feedService';

describe('feedService bookmark folders', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates a folder and returns the name the server stored', async () => {
    mockAuthenticatedPost.mockResolvedValue({ data: { folder: 'QA-empty' } });

    await expect(feedService.createBookmarkFolder('  QA-empty  ')).resolves.toBe('QA-empty');
    expect(mockAuthenticatedPost).toHaveBeenCalledWith('/posts/bookmarks/folders', { name: '  QA-empty  ' });
  });

  it('lists the folders, and an absent list as none', async () => {
    mockAuthenticatedGet.mockResolvedValueOnce({ data: { folders: ['a', 'b'] } });
    await expect(feedService.getBookmarkFolders()).resolves.toEqual(['a', 'b']);

    mockAuthenticatedGet.mockResolvedValueOnce({ data: {} });
    await expect(feedService.getBookmarkFolders()).resolves.toEqual([]);
  });
});
