import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Oxy supplies canonical identity; Mention imports source content and renders that exact profile. */

const { resolve, classifyQuery, getUserById, makeServiceRequest, connectorFor, fetchProfile } = vi.hoisted(() => ({
  resolve: vi.fn(),
  makeServiceRequest: vi.fn(),
  connectorFor: vi.fn(),
  fetchProfile: vi.fn(),
  classifyQuery: vi.fn(() => 'activitypub' as const),
  getUserById: vi.fn(),
}));

// Same isolation strategy as `connectorsRoutesSharingGate.test.ts`: the route
// module transitively imports the server entrypoint and the full connector
// registry graph — stub the heavy/circular deps so it loads standalone. The
// bridge policy itself is deliberately NOT stubbed: which hosts are asked is the
// thing under test, and a stubbed policy would test a list nobody reviewed.
vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({ getUserById }),
}));

vi.mock('@oxy.so/core/server', () => ({
  getRequiredOxyUserId: () => 'local-user-1',
}));

vi.mock('../../connectors/activitypub/constants', () => ({
  FEDERATION_ENABLED: true,
  isBlockedDomain: () => false,
  FEDERATION_DOMAIN: 'mention.earth',
  AP_CONTENT_TYPE: 'application/activity+json',
  USER_AGENT: 'Mention/mention.earth (ActivityPub)',
  resolveOxyUser: vi.fn(),
  FEDERATION_BLOCKS: [],
  federationUrls: {
    actor: (u: string) => `https://mention.earth/ap/users/${u}`,
    inbox: (u: string) => `https://mention.earth/ap/users/${u}/inbox`,
    outbox: (u: string) => `https://mention.earth/ap/users/${u}/outbox`,
    featured: (u: string) => `https://mention.earth/ap/users/${u}/collections/featured`,
    followers: (u: string) => `https://mention.earth/ap/users/${u}/followers`,
    following: (u: string) => `https://mention.earth/ap/users/${u}/following`,
    sharedInbox: () => 'https://mention.earth/ap/inbox',
  },
}));
vi.mock('../../connectors/atproto/constants', () => ({
  ATPROTO_ENABLED: false,
  isDid: (v: string) => v.startsWith('did:'),
  isAtUri: (v: string) => v.startsWith('at://'),
  isAtprotoHandle: () => false,
}));

vi.mock('../../connectors/index', () => ({
  connectorRegistry: {
    list: () => [],
    connectorFor,
    resolve: (...args: unknown[]) => resolve(...args),
  },
}));
vi.mock('../../connectors/resolve', () => ({ classifyQuery }));

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
  getServiceOxyClient: () => ({ getUserById, makeServiceRequest }),
}));

vi.mock('../../services/fediverseSharing', () => ({
  isFediverseSharingEnabled: vi.fn(async () => true),
}));

import connectorsRoutes from '../../connectors/connectors.routes';
import { oxyIdentityFixture } from '../helpers/oxyIdentityFixtures';

const app = express();
app.use(express.json());
app.use('/federation', connectorsRoutes);

const source = { actorUri: 'https://bird.makeup/users/elonmusk', transportAcct: 'elonmusk@bird.makeup', canonicalAcct: 'elonmusk@x.com', network: 'x.com' };

beforeEach(() => {
  vi.clearAllMocks();
  classifyQuery.mockReturnValue('activitypub');
  makeServiceRequest.mockResolvedValue(oxyIdentityFixture(source));
  connectorFor.mockReturnValue({ id: 'activitypub', enabled: true, fetchProfile });
  fetchProfile.mockResolvedValue({ externalId: source.actorUri, handle: source.transportAcct });
});

describe('GET /federation/resolve delegates public identity discovery to Oxy', () => {
  it.each(['https://x.com/elonmusk', '@elonmusk@x.com', '@elonmusk@bird.makeup'])(
    'passes %s to Oxy and imports only its returned transport actor', async (handle) => {
      const res = await request(app).get('/federation/resolve').query({ handle });
      expect(res.status).toBe(200);
      expect(res.body.actor).toMatchObject({ handle: 'elonmusk@x.com', externalId: source.actorUri, oxyUserId: 'oxy-resolved' });
      expect(makeServiceRequest).toHaveBeenCalledWith('POST', '/federation/identities/resolve', { handle });
      expect(fetchProfile).toHaveBeenCalledExactlyOnceWith(source.actorUri);
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it('returns no match when Oxy cannot prove a profile for the query', async () => {
    makeServiceRequest.mockRejectedValue(Object.assign(new Error('Unknown profile'), { status: 404 }));
    const res = await request(app).get('/federation/resolve').query({ handle: 'https://x.com/unknown' });
    expect(res.status).toBe(200);
    expect(res.body.actor).toBeNull();
    expect(fetchProfile).not.toHaveBeenCalled();
  });

  it('does not import a source rejected by Mention transport policy', async () => {
    connectorFor.mockReturnValue(undefined);
    const res = await request(app).get('/federation/resolve').query({ handle: 'https://x.com/elonmusk' });
    expect(res.body.actor).toBeNull();
    expect(fetchProfile).not.toHaveBeenCalled();
  });

  it('does not use a source response whose Oxy owner disagrees with the public profile', async () => {
    const response = oxyIdentityFixture(source);
    response.externalIdentity.userId = 'somebody-else';
    makeServiceRequest.mockResolvedValue(response);
    const res = await request(app).get('/federation/resolve').query({ handle: source.transportAcct });
    expect(res.status).toBe(500);
    expect(fetchProfile).not.toHaveBeenCalled();
  });

  it('imports atproto by the DID Oxy verified and renders its canonical username', async () => {
    const did = 'did:plc:verified';
    makeServiceRequest.mockResolvedValue(oxyIdentityFixture({ actorUri: did, transportAcct: 'alice.bsky.social',
      canonicalAcct: 'alice@bsky.social', network: 'bsky.social', protocol: 'atproto' }));
    connectorFor.mockReturnValue({ id: 'atproto', enabled: true, fetchProfile });
    fetchProfile.mockResolvedValue({ externalId: did });
    const res = await request(app).get('/federation/resolve').query({ handle: did });
    expect(res.body.actor).toMatchObject({ handle: 'alice@bsky.social', externalId: did, network: 'atproto' });
  });
});
