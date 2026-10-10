/**
 * Which thread a replies feed reads.
 *
 * The replies endpoint is `/feed/replies/<parent id>`, and the same parent is
 * what the feed query narrows its rows to and what a new reply is matched on
 * (`feedThreadParentId`). The places that asked disagreed on the order —
 * `parentPostId || postId` here, `postId || parentPostId` everywhere else — so a
 * feed carrying both could read one thread and filter for another.
 */

const mockAuthenticatedGet = jest.fn();

jest.mock('@/utils/api', () => ({
  authenticatedClient: {
    get: (...args: unknown[]) => mockAuthenticatedGet(...args),
  },
  publicClient: {},
  isNotFoundError: () => false,
}));

jest.mock('@/lib/oxyServices', () => ({
  oxyServices: { http: { getAccessToken: () => 'token' } },
}));

jest.mock('@oxy.so/core/logger', () => ({
  ...jest.requireActual('@oxy.so/core/logger'),
  logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

// Jest must install the transport/auth mocks before this singleton is loaded.
import { feedService } from '../feedService';

const EMPTY_PAGE = { items: [], hasMore: false, totalCount: 0 };

beforeEach(() => {
  mockAuthenticatedGet.mockReset();
  mockAuthenticatedGet.mockResolvedValue({ data: EMPTY_PAGE });
});

describe('feedService replies feed', () => {
  it('reads the thread the parent post id names, with its cursor, limit and sort', async () => {
    const controller = new AbortController();

    await feedService.getFeed(
      {
        type: 'replies',
        cursor: 'c-2',
        limit: 20,
        filters: { parentPostId: 'post-1', sort: 'top' },
      },
      { signal: controller.signal },
    );

    expect(mockAuthenticatedGet).toHaveBeenCalledWith(
      '/feed/replies/post-1',
      expect.objectContaining({
        params: { cursor: 'c-2', limit: 20, sort: 'top' },
        signal: controller.signal,
      }),
    );
  });

  it('prefers the parent post id when a feed carries both, the order every thread match uses', async () => {
    await feedService.getFeed(
      { type: 'replies', filters: { parentPostId: 'parent', postId: 'other' } },
      { signal: new AbortController().signal },
    );

    expect(mockAuthenticatedGet).toHaveBeenCalledWith('/feed/replies/parent', expect.anything());
  });

  it('answers an empty page without a request when the feed names no thread', async () => {
    const page = await feedService.getFeed(
      { type: 'replies' },
      { signal: new AbortController().signal },
    );

    expect(page).toEqual({ items: [], hasMore: false, nextCursor: undefined, totalCount: 0 });
    expect(mockAuthenticatedGet).not.toHaveBeenCalled();
  });
});
