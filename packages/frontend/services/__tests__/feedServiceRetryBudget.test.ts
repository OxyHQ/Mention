/**
 * What one failed feed load costs, measured through the real service.
 *
 * `useFeedState` used to wrap every feed fetch in four attempts of its own, and
 * each of those went through the SDK's linked client, which retries a 5xx three
 * more times (1s/2s/4s) — up to 16 requests for one failed load, from every
 * mounted feed at once, at a backend that was failing *because* it had been rate
 * limited. This asserts the two halves of the fix together: the transport's
 * retry is switched off for feed reads, and the app's own policy is the only one
 * left.
 */

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
    getClient: () => ({ getAccessToken: () => mockGetAccessToken() }),
    getCurrentUserId: () => 'viewer-1',
  },
}));

jest.mock('@oxy.so/core/logger', () => ({
  ...jest.requireActual('@oxy.so/core/logger'),
  logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

// Jest must install the transport mocks before this singleton is loaded.
// eslint-disable-next-line import/first
import { feedService, setFeedViewerRequestScope } from '../feedService';
// eslint-disable-next-line import/first
import { FEED_MAX_ATTEMPTS } from '@/utils/feedRetry';

/** The shape `@oxy.so/core`'s `handleHttpError` throws for a server failure. */
function serverError(status: number): unknown {
  return { message: `HTTP ${status} error`, code: 'INTERNAL_ERROR', status };
}

describe('feed read retry budget', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccessToken.mockReturnValue('token-1');
    // A fresh viewer generation per test, so no in-flight promise is shared
    // between them.
    setFeedViewerRequestScope(`viewer-${Math.random()}`);
  });

  it('spends FEED_MAX_ATTEMPTS requests on a feed that keeps failing', async () => {
    mockAuthenticatedGet.mockRejectedValue(serverError(500));

    await expect(feedService.getFeed({ type: 'for_you', limit: 20 })).rejects.toThrow();

    expect(mockAuthenticatedGet).toHaveBeenCalledTimes(FEED_MAX_ATTEMPTS);
    expect(FEED_MAX_ATTEMPTS).toBeLessThanOrEqual(3);
  });

  it('turns the transport\'s own retry off, so the two policies cannot multiply', async () => {
    mockAuthenticatedGet.mockRejectedValue(serverError(503));

    await expect(feedService.getFeed({ type: 'for_you', limit: 20 })).rejects.toThrow();

    for (const [, config] of mockAuthenticatedGet.mock.calls) {
      expect(config).toMatchObject({ retry: false });
    }
  });

  it('recovers a blip without the caller ever seeing a failure', async () => {
    mockAuthenticatedGet
      .mockRejectedValueOnce(serverError(500))
      .mockResolvedValue({ data: { items: [], hasMore: false } });

    const feed = await feedService.getFeed({ type: 'for_you', limit: 20 });

    expect(feed.items).toEqual([]);
    expect(mockAuthenticatedGet).toHaveBeenCalledTimes(2);
  });

  it('spends exactly one request on a failure that asking again cannot fix', async () => {
    mockAuthenticatedGet.mockRejectedValue(serverError(404));

    await expect(feedService.getFeed({ type: 'for_you', limit: 20 })).rejects.toThrow();

    expect(mockAuthenticatedGet).toHaveBeenCalledTimes(1);
  });

  it('applies the same policy to a profile feed', async () => {
    mockAuthenticatedGet.mockRejectedValue(serverError(502));

    await expect(
      feedService.getUserFeed('user-1', { type: 'posts', limit: 20 }),
    ).rejects.toBeDefined();

    expect(mockAuthenticatedGet).toHaveBeenCalledTimes(FEED_MAX_ATTEMPTS);
  });

  it('retries an anonymous read too, which the transport never would', async () => {
    // A signed-out reader's feed goes out over plain axios, which has no retry
    // of its own — the reason the policy lives in front of the transport.
    mockGetAccessToken.mockReturnValue(undefined);
    mockPublicGet
      .mockRejectedValueOnce(serverError(500))
      .mockResolvedValue({ data: { items: [], hasMore: false } });

    await feedService.getFeed({ type: 'for_you', limit: 20 });

    expect(mockPublicGet).toHaveBeenCalledTimes(2);
    expect(mockAuthenticatedGet).not.toHaveBeenCalled();
  });
});
