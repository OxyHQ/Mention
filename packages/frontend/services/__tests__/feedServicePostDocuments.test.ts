/**
 * `feedService`'s link-card calls. Both go to Mention's backend — the app never
 * calls Clarity itself.
 *
 * `getPostDocuments` is a viewer-aware read: signed in it carries the session
 * (so a followers-only post still gets its cards), a session the server rejects
 * falls back to the anonymous read, and signed out it goes straight there.
 */

const mockAuthenticatedPost = jest.fn();
const mockPublicPost = jest.fn();
let mockAccessToken: string | undefined = 'token';

jest.mock('@/utils/api', () => ({
  authenticatedClient: {
    get: jest.fn(),
    post: (...args: unknown[]) => mockAuthenticatedPost(...args),
  },
  publicClient: {
    post: (...args: unknown[]) => mockPublicPost(...args),
  },
  isNotFoundError: () => false,
}));

jest.mock('@/lib/oxyServices', () => ({
  oxyServices: {
    http: { getAccessToken: () => mockAccessToken },
    getClient: () => ({ getAccessToken: () => mockAccessToken }),
    getCurrentUserId: () => 'viewer-1',
  },
}));

jest.mock('@oxy.so/core/logger', () => ({
  ...jest.requireActual('@oxy.so/core/logger'),
  logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

import { feedService } from '../feedService';

const ANSWER = { posts: { a: { documents: [] } } };

describe('feedService link cards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAccessToken = 'token';
  });

  it('asks for pending cards with the session when signed in', async () => {
    mockAuthenticatedPost.mockResolvedValue({ data: ANSWER });

    await expect(feedService.getPostDocuments(['a'])).resolves.toEqual(ANSWER);
    expect(mockAuthenticatedPost).toHaveBeenCalledWith('/posts/documents', { ids: ['a'] }, { retry: false });
    expect(mockPublicPost).not.toHaveBeenCalled();
  });

  it('falls back to the anonymous read when the session is rejected', async () => {
    mockAuthenticatedPost.mockRejectedValue({ message: 'Unauthorized', status: 401 });
    mockPublicPost.mockResolvedValue({ data: ANSWER });

    await expect(feedService.getPostDocuments(['a'])).resolves.toEqual(ANSWER);
    expect(mockPublicPost).toHaveBeenCalledWith('/posts/documents', { ids: ['a'] });
  });

  it('does not hide any other failure behind the anonymous read', async () => {
    mockAuthenticatedPost.mockRejectedValue({ message: 'Server error', status: 500 });

    await expect(feedService.getPostDocuments(['a'])).rejects.toBeDefined();
    expect(mockPublicPost).not.toHaveBeenCalled();
  });

  it('goes straight to the anonymous read when signed out', async () => {
    mockAccessToken = undefined;
    mockPublicPost.mockResolvedValue({ data: ANSWER });

    await expect(feedService.getPostDocuments(['a'])).resolves.toEqual(ANSWER);
    expect(mockAuthenticatedPost).not.toHaveBeenCalled();
  });

  it("resolves the composer's links through the backend", async () => {
    const answer = { previews: [], pending: ['https://example.com/a'] };
    mockAuthenticatedPost.mockResolvedValue({ data: answer });
    const signal = new AbortController().signal;

    await expect(feedService.resolveLinkPreviews(['https://example.com/a'], signal)).resolves.toEqual(answer);
    expect(mockAuthenticatedPost).toHaveBeenCalledWith(
      '/posts/link-previews',
      { urls: ['https://example.com/a'] },
      { signal, retry: false },
    );
  });
});
