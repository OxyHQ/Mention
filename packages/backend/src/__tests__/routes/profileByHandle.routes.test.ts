import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `GET /profile/by-handle`: the web app's ONLY way to a federated profile.
 * Oxy is asked server-to-server as Mention's workload; Mention's instance and
 * erasure rules run on its answer; the viewer's relationship is read per request
 * with the viewer's own session and never shared.
 */

const { serviceRequest, callerOxyUser, viewerGet, isBlockedDomain, isAccountErased, cacheStore } =
  vi.hoisted(() => ({
    serviceRequest: vi.fn(),
    callerOxyUser: vi.fn(),
    viewerGet: vi.fn(),
    isBlockedDomain: vi.fn((_host: string) => false),
    isAccountErased: vi.fn(async (_id: string) => false),
    cacheStore: new Map<string, unknown>(),
  }));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ serviceRequest }),
  callerOxyUser,
}));

vi.mock('../../middleware/rateLimiter', () => ({
  apiRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../connectors/activitypub/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../connectors/activitypub/constants')>()),
  isBlockedDomain,
}));

vi.mock('../../services/accounts/accountErasure/erasedAccounts', () => ({ isAccountErased }));

// The suite has no Redis, where every real cache is a miss; this one gets a
// store so a warm read is observable.
vi.mock('../../utils/cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/cache')>();
  const { createMemoryCache } = await import('../helpers/memoryCache');
  return {
    ...actual,
    createCache: (config: Parameters<typeof actual.createCache>[0]) =>
      config.name === 'ProfileByHandleCache'
        ? createMemoryCache(cacheStore)
        : actual.createCache(config),
  };
});

import profileByHandleRoutes from '../../routes/profileByHandle.routes';

const VIEWER_HEADER = 'x-test-viewer';

const app = express();
// Stands in for `optionalAuth`: a signed-in request carries a verified user.
app.use((req: Request, _res: Response, next: NextFunction) => {
  const viewer = req.header(VIEWER_HEADER);
  if (viewer) (req as Request & { user?: { id: string } }).user = { id: viewer };
  next();
});
app.use('/profile/by-handle', profileByHandleRoutes);

const federated = {
  id: 'fed-atrupar',
  username: 'atrupar.com@bsky.social',
  type: 'federated',
  isFederated: true,
  name: { displayName: 'Aaron Rupar' },
  federation: { actorUri: 'did:plc:atrupar', domain: 'bsky.social' },
  externalIdentities: [
    {
      canonicalAcct: 'atrupar.com@bsky.social',
      network: 'bsky.social',
      protocol: 'atproto',
      actorUri: 'did:plc:atrupar',
      transportAcct: 'atrupar.com',
      sourceUserId: 'fed-atrupar',
    },
  ],
  redirectedUserIds: [],
};

const local = {
  id: 'local-alice',
  username: 'alice',
  type: 'local',
  name: { displayName: 'Alice' },
  redirectedUserIds: [],
};

const mastodon = {
  id: 'fed-bob',
  username: 'bob@spam.example',
  type: 'federated',
  isFederated: true,
  name: { displayName: 'Bob' },
  federation: { actorUri: 'https://spam.example/users/bob', domain: 'spam.example' },
  redirectedUserIds: [],
};

function oxyError(status: number): Error {
  return Object.assign(new Error(`Oxy ${status}`), { status });
}

function get(handle: string, viewer?: string) {
  const req = request(app).get('/profile/by-handle').query({ handle });
  return viewer ? req.set(VIEWER_HEADER, viewer) : req;
}

beforeEach(() => {
  vi.clearAllMocks();
  cacheStore.clear();
  isBlockedDomain.mockImplementation(() => false);
  isAccountErased.mockResolvedValue(false);
  callerOxyUser.mockImplementation((req: { user?: { id: string } }) =>
    req.user ? { users: { get: viewerGet } } : undefined,
  );
  viewerGet.mockResolvedValue({
    ...federated,
    relationship: { isFollowing: true, followsYou: false },
  });
});

describe('GET /profile/by-handle resolves server-side', () => {
  it('resolves a federated handle through Oxy as Mention, in its one spelling', async () => {
    serviceRequest.mockResolvedValue(federated);

    const res = await get('@Atrupar.com@Bsky.Social');

    expect(res.status).toBe(200);
    expect(res.body.profile).toMatchObject({
      id: 'fed-atrupar',
      username: 'atrupar.com@bsky.social',
    });
    expect(serviceRequest).toHaveBeenCalledTimes(1);
    expect(serviceRequest).toHaveBeenCalledWith(
      'GET',
      '/profiles/resolve',
      { handle: 'atrupar.com@bsky.social' },
      expect.objectContaining({ cache: false }),
    );
    // Anonymous: no relationship, and no per-viewer read was made.
    expect(res.body.profile.relationship).toBeUndefined();
    expect(viewerGet).not.toHaveBeenCalled();
  });

  it('resolves a local handle the same way', async () => {
    serviceRequest.mockResolvedValue(local);

    const res = await get('@Alice');

    expect(res.status).toBe(200);
    expect(res.body.profile).toMatchObject({ id: 'local-alice', username: 'alice' });
    expect(serviceRequest).toHaveBeenCalledWith(
      'GET',
      '/profiles/resolve',
      { handle: 'alice' },
      expect.anything(),
    );
  });

  it("adds the signed-in viewer's relationship from their own Oxy read, uncached", async () => {
    serviceRequest.mockResolvedValue(federated);

    const first = await get('atrupar.com@bsky.social', 'viewer-1');
    viewerGet.mockResolvedValue({
      ...federated,
      relationship: { isFollowing: false, followsYou: true },
    });
    const second = await get('atrupar.com@bsky.social', 'viewer-1');

    expect(first.body.profile.relationship).toEqual({ isFollowing: true, followsYou: false });
    expect(second.body.profile.relationship).toEqual({ isFollowing: false, followsYou: true });
    expect(viewerGet).toHaveBeenCalledTimes(2);
    expect(viewerGet).toHaveBeenCalledWith('fed-atrupar', { cache: false });
    // The public profile was read once and shared.
    expect(serviceRequest).toHaveBeenCalledTimes(1);
  });

  it('never shares one viewer relationship with another reader', async () => {
    // Even if Oxy's answer carried one, the shared entry drops it.
    serviceRequest.mockResolvedValue({
      ...federated,
      relationship: { isFollowing: true, followsYou: true },
    });

    await get('atrupar.com@bsky.social', 'viewer-1');
    const anonymous = await get('atrupar.com@bsky.social');

    expect(anonymous.body.profile.relationship).toBeUndefined();
    expect(serviceRequest).toHaveBeenCalledTimes(1);
  });

  it('skips the relationship read on a self-view', async () => {
    serviceRequest.mockResolvedValue(federated);

    const res = await get('atrupar.com@bsky.social', 'fed-atrupar');

    expect(res.body.profile.relationship).toBeUndefined();
    expect(viewerGet).not.toHaveBeenCalled();
  });

  it('still serves the profile when the relationship read fails', async () => {
    serviceRequest.mockResolvedValue(federated);
    viewerGet.mockRejectedValue(oxyError(502));

    const res = await get('atrupar.com@bsky.social', 'viewer-1');

    expect(res.status).toBe(200);
    expect(res.body.profile.id).toBe('fed-atrupar');
    expect(res.body.profile.relationship).toBeUndefined();
  });
});

describe('GET /profile/by-handle has one answer for every miss', () => {
  it.each([
    ['Oxy has no such profile', () => serviceRequest.mockResolvedValue(null)],
    ['Oxy answers 404', () => serviceRequest.mockRejectedValue(oxyError(404))],
    [
      'Oxy refuses to discover the handle (400)',
      () => serviceRequest.mockRejectedValue(oxyError(400)),
    ],
  ])('unknown handle: %s', async (_label, arrange) => {
    arrange();

    const localMiss = await get('nobody');
    const federatedMiss = await get('nobody@mastodon.social');

    // Identical status and body: an unknown local account is not told apart
    // from an unknown remote one, or from any other miss below.
    expect(localMiss.status).toBe(200);
    expect(localMiss.body).toEqual({ profile: null });
    expect(federatedMiss.status).toBe(200);
    expect(federatedMiss.body).toEqual({ profile: null });
  });

  it.each(['a@b@c', '../etc/passwd', 'alice bob', '', 'x'.repeat(400)])(
    'malformed handle %j is a miss and never reaches Oxy',
    async (handle) => {
      const res = await get(handle);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ profile: null });
      expect(serviceRequest).not.toHaveBeenCalled();
    },
  );

  it('an account Oxy told Mention was erased is a miss', async () => {
    serviceRequest.mockResolvedValue(federated);
    isAccountErased.mockResolvedValue(true);

    const res = await get('atrupar.com@bsky.social');

    expect(res.body).toEqual({ profile: null });
  });

  it('keeps a miss only briefly, so a just-discovered account is not stuck "not found"', async () => {
    serviceRequest.mockResolvedValueOnce(null).mockResolvedValueOnce(federated);

    // The memory cache honours `ttlSecondsFor`; the real one expires a miss
    // after seconds. Clearing stands in for that expiry.
    expect((await get('atrupar.com@bsky.social')).body).toEqual({ profile: null });
    cacheStore.clear();
    expect((await get('atrupar.com@bsky.social')).body.profile.id).toBe('fed-atrupar');
  });
});

describe("GET /profile/by-handle applies Mention's instance policy", () => {
  it('a profile on an instance Mention refuses is a miss', async () => {
    serviceRequest.mockResolvedValue(mastodon);
    isBlockedDomain.mockImplementation((host) => host === 'spam.example');

    const res = await get('bob@spam.example');

    expect(res.body).toEqual({ profile: null });
  });

  it('a profile that arrives through a refused transport is a miss', async () => {
    serviceRequest.mockResolvedValue({
      ...mastodon,
      username: 'bob@x.com',
      federation: { actorUri: 'https://bridge.example/users/bob', domain: 'x.com' },
      externalIdentities: [
        {
          canonicalAcct: 'bob@x.com',
          network: 'x.com',
          protocol: 'activitypub',
          actorUri: 'https://bridge.example/users/bob',
          transportAcct: 'bob@bridge.example',
          sourceUserId: 'fed-bob',
        },
      ],
    });
    isBlockedDomain.mockImplementation((host) => host === 'bridge.example');

    const res = await get('bob@x.com');

    expect(res.body).toEqual({ profile: null });
  });

  it('applies a refusal on the next look, even to a cached profile', async () => {
    serviceRequest.mockResolvedValue(mastodon);

    expect((await get('bob@spam.example')).body.profile.id).toBe('fed-bob');
    isBlockedDomain.mockImplementation((host) => host === 'spam.example');
    expect((await get('bob@spam.example')).body).toEqual({ profile: null });
    expect(serviceRequest).toHaveBeenCalledTimes(1);
  });

  it('never refuses a local account on instance policy', async () => {
    serviceRequest.mockResolvedValue(local);
    isBlockedDomain.mockImplementation(() => true);

    const res = await get('alice');

    expect(res.body.profile.id).toBe('local-alice');
  });
});

describe('GET /profile/by-handle on an Oxy outage', () => {
  it('answers 503, not "not found", and caches nothing', async () => {
    serviceRequest.mockRejectedValueOnce(oxyError(500)).mockResolvedValueOnce(federated);

    const failed = await get('atrupar.com@bsky.social');
    const retried = await get('atrupar.com@bsky.social');

    expect(failed.status).toBe(503);
    expect(failed.body.profile).toBeUndefined();
    expect(retried.status).toBe(200);
    expect(retried.body.profile.id).toBe('fed-atrupar');
    expect(serviceRequest).toHaveBeenCalledTimes(2);
  });
});
