import type { HydratedPost } from '@mention/shared-types';
import { PostVisibility } from '@mention/shared-types/post';

const mockAuthenticatedGet = jest.fn();
const mockPublicGet = jest.fn();
const mockGetAccessToken = jest.fn();

jest.mock('@/utils/api', () => ({
  authenticatedClient: {
    get: (...args: unknown[]) => mockAuthenticatedGet(...args),
  },
  publicClient: {
    get: (...args: unknown[]) => mockPublicGet(...args),
  },
  isNotFoundError: () => false,
}));

jest.mock('@/lib/oxyServices', () => ({
  oxyServices: {
    http: {
      getAccessToken: () => mockGetAccessToken(),
    },
  },
}));

jest.mock('@oxy.so/core/logger', () => ({
  ...jest.requireActual('@oxy.so/core/logger'),
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('@/utils/apiError', () => ({
  normalizeApiError: (error: unknown) => ({
    message: error instanceof Error ? error.message : 'request failed',
    status:
      typeof error === 'object' && error !== null && 'status' in error
        ? (error as { status?: number }).status
        : undefined,
  }),
}));

// Jest must install the transport/auth mocks before this singleton is loaded.
import { feedService, setFeedViewerRequestScope } from '../feedService';

function viewerPost(viewerId: string, isSaved: boolean): HydratedPost {
  return {
    id: 'post-1',
    content: { text: viewerId },
    attachments: {},
    user: {
      id: 'author-1',
      username: 'alice',
      name: { displayName: 'Alice' },
    },
    authors: [
      {
        id: 'author-1',
        username: 'alice',
        name: { displayName: 'Alice' },
        role: 'owner',
        status: 'accepted',
      },
    ],
    engagement: {
      likes: 0,
      downvotes: 0,
      boosts: 0,
      replies: 0,
    },
    viewerState: {
      isOwner: false,
      isCollaborator: false,
      isLiked: false,
      isDownvoted: false,
      isBoosted: false,
      isSaved,
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
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('feedService viewer request isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPublicGet.mockRejectedValue(
      new Error('authenticated feed unexpectedly fell back to public'),
    );
  });

  it('does not let B inherit A pending personalized feed promise', async () => {
    const pendingA = deferred<{ data: unknown }>();
    const responseA = {
      items: [viewerPost('viewer-a', true)],
      hasMore: false,
    };
    const responseB = {
      items: [viewerPost('viewer-b', false)],
      hasMore: false,
    };
    let activeViewer = 'viewer-a';

    // Oxy can switch the active linked account while retaining one device
    // session token, so viewer generation—not token inequality—must isolate A/B.
    mockGetAccessToken.mockReturnValue('shared-session-token');
    mockAuthenticatedGet.mockImplementation(() =>
      activeViewer === 'viewer-a' ? pendingA.promise : Promise.resolve({ data: responseB }),
    );

    setFeedViewerRequestScope('viewer-a');
    const requestA = feedService.getMtnFeed('author|profile-owner|posts' as never);
    expect(mockAuthenticatedGet).toHaveBeenCalledTimes(1);

    activeViewer = 'viewer-b';
    setFeedViewerRequestScope('viewer-b');
    const receivedByB = await feedService.getMtnFeed('author|profile-owner|posts' as never);

    expect(mockAuthenticatedGet).toHaveBeenCalledTimes(2);
    expect(receivedByB).toEqual(responseB);
    expect(receivedByB.items[0]?.viewerState.isSaved).toBe(false);
    expect(receivedByB.items[0]).not.toHaveProperty('isSaved');

    pendingA.resolve({ data: responseA });
    await expect(requestA).resolves.toEqual(responseA);
  });

  it('keeps concurrent page sizes separate while sharing identical reads', async () => {
    const pending = deferred<{ data: unknown }>();
    mockGetAccessToken.mockReturnValue('page-size-token');
    setFeedViewerRequestScope('page-size-viewer');
    mockAuthenticatedGet.mockReturnValue(pending.promise);

    const small = feedService.getFeed({ type: 'explore', limit: 5 });
    const large = feedService.getFeed({ type: 'explore', limit: 30 });
    const sameSmall = feedService.getFeed({ type: 'explore', limit: 5 });
    pending.resolve({ data: { items: [], hasMore: false } });
    await Promise.all([small, large, sameSmall]);

    expect(mockAuthenticatedGet).toHaveBeenCalledTimes(2);
    expect(
      mockAuthenticatedGet.mock.calls
        .map(([, options]) => options.params.limit)
        .sort((a, b) => a - b),
    ).toEqual([5, 30]);
  });

  it.each(['feed', 'descriptor'] as const)(
    'an old anonymous %s read cannot remove a newer in-flight read after a session change',
    async (kind) => {
      const oldResponse = deferred<{ data: unknown }>();
      const newResponse = deferred<{ data: unknown }>();
      mockGetAccessToken.mockReturnValue(undefined);
      mockPublicGet.mockReset();
      mockPublicGet.mockReturnValueOnce(oldResponse.promise).mockReturnValue(newResponse.promise);
      const read = () =>
        kind === 'feed'
          ? feedService.getFeed({ type: 'explore', limit: 20 })
          : feedService.getMtnFeed('explore');
      setFeedViewerRequestScope('restoring-a');
      const oldRead = read();
      setFeedViewerRequestScope('restoring-b');
      const newRead = read();
      oldResponse.resolve({ data: { items: [], hasMore: false } });
      await oldRead;
      const joinedRead = read();
      newResponse.resolve({ data: { items: [], hasMore: false } });
      await Promise.all([newRead, joinedRead]);
      expect(mockPublicGet).toHaveBeenCalledTimes(2);
    },
  );

  it('loads an encoded topic page anonymously with its cursor and page size', async () => {
    mockGetAccessToken.mockReturnValue(undefined);
    const response = { items: [viewerPost('public', false)], hasMore: true };
    mockPublicGet.mockResolvedValue({ data: response });
    await expect(
      feedService.getPostsByTopic('Design & UI/UX', {
        type: 'topic',
        cursor: 'next-page',
        limit: 12,
      }),
    ).resolves.toEqual(response);
    expect(mockPublicGet).toHaveBeenCalledWith('/posts/topic/Design%20%26%20UI%2FUX', {
      params: { cursor: 'next-page', limit: 12 },
    });
    expect(mockAuthenticatedGet).not.toHaveBeenCalled();
  });

  it('propagates a caller-owned AbortSignal through profile feeds', async () => {
    const signal = new AbortController().signal;
    mockGetAccessToken.mockReturnValue('token-a');
    mockAuthenticatedGet.mockResolvedValue({
      data: { items: [], hasMore: false },
    });
    setFeedViewerRequestScope('viewer-a');

    await feedService.getUserFeed('profile-owner', { type: 'posts', limit: 20 }, { signal });

    expect(mockAuthenticatedGet).toHaveBeenCalledWith(
      '/feed/mtn',
      expect.objectContaining({ signal }),
    );
  });
});
