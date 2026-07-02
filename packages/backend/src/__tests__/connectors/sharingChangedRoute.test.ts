import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Contract test for `POST /federation/sharing-changed`.
 *
 * Split from `connectorsRoutesSharingGate.test.ts` (which covers the
 * pre-existing `/follow` and `/unfollow` gates) because this route needs
 * `sharingCleanup.service`'s `runSharingCleanup` MOCKED — the real
 * implementation is covered separately in
 * `connectors/activitypub/sharingCleanup.test.ts`, which needs that same
 * module UN-mocked. Mocking it file-wide here would make that other suite
 * test a mock instead of the real function.
 */

const {
  isFediverseSharingEnabled,
  invalidateFediverseSharing,
  invalidateWebfingerCache,
  enqueueSharingCleanup,
  runSharingCleanup,
  getUserById,
} = vi.hoisted(() => ({
  isFediverseSharingEnabled: vi.fn(),
  invalidateFediverseSharing: vi.fn(),
  invalidateWebfingerCache: vi.fn(),
  enqueueSharingCleanup: vi.fn(),
  runSharingCleanup: vi.fn(),
  getUserById: vi.fn(),
}));

// Same isolation strategy as `connectorsRoutesSharingGate.test.ts`: the route
// module transitively imports the server entrypoint and the full connector
// registry graph — stub the heavy/circular deps so it loads standalone.
vi.mock('../../../server', () => ({ oxy: { getUserById } }));

vi.mock('@oxyhq/core/server', () => ({
  getRequiredOxyUserId: () => 'local-user-1',
}));

vi.mock('../../connectors/activitypub/constants', () => ({ FEDERATION_ENABLED: true }));
vi.mock('../../connectors/atproto/constants', () => ({ ATPROTO_ENABLED: false }));

vi.mock('../../connectors/index', () => ({
  connectorRegistry: {
    list: () => [],
    connectorFor: vi.fn(),
    resolve: vi.fn(async () => null),
  },
}));
vi.mock('../../connectors/resolve', () => ({ classifyQuery: vi.fn(() => 'activitypub') }));

vi.mock('../../middleware/rateLimiter', () => ({
  apiRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../connectors/activitypub/ActivityPubConnector', () => ({
  activityPubConnector: {},
  isPermanentlyUnavailableOutboxReason: vi.fn(() => false),
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async () => []) },
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(),
  getServiceOxyClient: vi.fn(),
}));

vi.mock('../../models/Post', () => ({ Post: { find: vi.fn() } }));

vi.mock('../../models/FederatedFollow', () => ({
  default: { find: vi.fn(() => ({ lean: async () => [] })) },
}));

vi.mock('../../models/FederatedActor', () => ({
  default: { findOne: vi.fn(() => ({ select: () => ({ lean: async () => null }) })) },
}));

vi.mock('../../services/fediverseSharing', () => ({
  isFediverseSharingEnabled: (...args: unknown[]) => isFediverseSharingEnabled(...args),
  invalidateFediverseSharing: (...args: unknown[]) => invalidateFediverseSharing(...args),
}));

vi.mock('../../connectors/activitypub/webfingerCache', () => ({
  invalidateWebfingerCache: (...args: unknown[]) => invalidateWebfingerCache(...args),
}));

vi.mock('../../queue/producers', () => ({
  enqueueSharingCleanup: (...args: unknown[]) => enqueueSharingCleanup(...args),
}));

vi.mock('../../connectors/activitypub/sharingCleanup.service', () => ({
  runSharingCleanup: (...args: unknown[]) => runSharingCleanup(...args),
}));

import connectorsRoutes from '../../connectors/connectors.routes';

const app = express();
app.use(express.json());
app.use('/federation', connectorsRoutes);

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  invalidateFediverseSharing.mockResolvedValue(undefined);
  invalidateWebfingerCache.mockResolvedValue(undefined);
  getUserById.mockResolvedValue({ username: 'nate' });
  enqueueSharingCleanup.mockResolvedValue(true);
  runSharingCleanup.mockResolvedValue({ deletesSent: 0, followersRemoved: 0 });
});

describe('POST /federation/sharing-changed', () => {
  it('re-reads the flag from Oxy AFTER invalidating, then queues cleanup + invalidates the webfinger cache when now OFF', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    isFediverseSharingEnabled.mockResolvedValue(false);

    const res = await request(app).post('/federation/sharing-changed').expect(202);

    expect(res.body).toEqual({ status: 'ok', cleanupQueued: true });
    expect(invalidateFediverseSharing).toHaveBeenCalledWith('local-user-1');
    expect(isFediverseSharingEnabled).toHaveBeenCalledWith('local-user-1');
    expect(invalidateFediverseSharing.mock.invocationCallOrder[0])
      .toBeLessThan(isFediverseSharingEnabled.mock.invocationCallOrder[0]);

    expect(invalidateWebfingerCache).toHaveBeenCalledWith('nate');
    expect(enqueueSharingCleanup).toHaveBeenCalledWith({
      oxyUserId: 'local-user-1',
      username: 'nate',
      nonce: '1700000000000',
    });
    expect(runSharingCleanup).not.toHaveBeenCalled();
  });

  it('invalidates both caches but does NOT queue cleanup when now ON', async () => {
    isFediverseSharingEnabled.mockResolvedValue(true);

    const res = await request(app).post('/federation/sharing-changed').expect(202);

    expect(res.body).toEqual({ status: 'ok', cleanupQueued: false });
    expect(invalidateFediverseSharing).toHaveBeenCalledWith('local-user-1');
    expect(invalidateWebfingerCache).toHaveBeenCalledWith('nate');
    expect(enqueueSharingCleanup).not.toHaveBeenCalled();
    expect(runSharingCleanup).not.toHaveBeenCalled();
  });

  it('deletes the webfinger cache entry for the resolved username on BOTH an OFF and an ON transition', async () => {
    isFediverseSharingEnabled.mockResolvedValueOnce(false);
    await request(app).post('/federation/sharing-changed').expect(202);
    expect(invalidateWebfingerCache).toHaveBeenCalledWith('nate');

    invalidateWebfingerCache.mockClear();
    isFediverseSharingEnabled.mockResolvedValueOnce(true);

    await request(app).post('/federation/sharing-changed').expect(202);
    expect(invalidateWebfingerCache).toHaveBeenCalledWith('nate');
  });

  it('falls back to inline runSharingCleanup when the queue is unavailable', async () => {
    isFediverseSharingEnabled.mockResolvedValue(false);
    enqueueSharingCleanup.mockResolvedValue(false);
    runSharingCleanup.mockResolvedValue({ deletesSent: 2, followersRemoved: 1 });

    const res = await request(app).post('/federation/sharing-changed').expect(202);

    expect(res.body).toEqual({ status: 'ok', cleanupQueued: true });
    expect(runSharingCleanup).toHaveBeenCalledWith('local-user-1', 'nate');
  });

  it('skips webfinger invalidation and cleanup queuing when the user has no resolvable username', async () => {
    isFediverseSharingEnabled.mockResolvedValue(false);
    getUserById.mockResolvedValue(null);

    const res = await request(app).post('/federation/sharing-changed').expect(202);

    expect(res.body).toEqual({ status: 'ok', cleanupQueued: false });
    expect(invalidateWebfingerCache).not.toHaveBeenCalled();
    expect(enqueueSharingCleanup).not.toHaveBeenCalled();
  });

  it('500s and never queues cleanup when invalidateFediverseSharing throws', async () => {
    invalidateFediverseSharing.mockRejectedValue(new Error('redis down'));

    const res = await request(app).post('/federation/sharing-changed').expect(500);

    expect(res.body).toEqual({ error: 'Failed to apply sharing change' });
    expect(enqueueSharingCleanup).not.toHaveBeenCalled();
  });
});
