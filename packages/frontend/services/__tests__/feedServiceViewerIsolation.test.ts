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
    getClient: () => ({
      getAccessToken: () => mockGetAccessToken(),
    }),
  },
}));

jest.mock('@/lib/logger', () => ({
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
// eslint-disable-next-line import/first
import {
  feedService,
  setFeedViewerRequestScope,
} from '../feedService';

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
      items: [{ id: 'post-1', viewerState: { isSaved: true } }],
      hasMore: false,
    };
    const responseB = {
      items: [{ id: 'post-1', viewerState: { isSaved: false } }],
      hasMore: false,
    };
    let activeViewer = 'viewer-a';

    // Oxy can switch the active linked account while retaining one device
    // session token, so viewer generation—not token inequality—must isolate A/B.
    mockGetAccessToken.mockReturnValue('shared-session-token');
    mockAuthenticatedGet.mockImplementation(() =>
      activeViewer === 'viewer-a'
        ? pendingA.promise
        : Promise.resolve({ data: responseB }),
    );

    setFeedViewerRequestScope('viewer-a');
    const requestA = feedService.getMtnFeed(
      'author|profile-owner|posts' as never,
    );
    expect(mockAuthenticatedGet).toHaveBeenCalledTimes(1);

    activeViewer = 'viewer-b';
    setFeedViewerRequestScope('viewer-b');
    const receivedByB = await feedService.getMtnFeed(
      'author|profile-owner|posts' as never,
    );

    expect(mockAuthenticatedGet).toHaveBeenCalledTimes(2);
    expect(receivedByB).toEqual(responseB);

    pendingA.resolve({ data: responseA });
    await expect(requestA).resolves.toEqual(responseA);
  });

  it('propagates a caller-owned AbortSignal through profile feeds', async () => {
    const signal = new AbortController().signal;
    mockGetAccessToken.mockReturnValue('token-a');
    mockAuthenticatedGet.mockResolvedValue({
      data: { items: [], hasMore: false },
    });
    setFeedViewerRequestScope('viewer-a');

    await feedService.getUserFeed(
      'profile-owner',
      { type: 'posts', limit: 20 },
      { signal },
    );

    expect(mockAuthenticatedGet).toHaveBeenCalledWith(
      '/feed/mtn',
      expect.objectContaining({ signal }),
    );
  });
});
