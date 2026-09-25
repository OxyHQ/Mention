import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `POST /federation/follow` / `unfollow` with a LOCAL target: the route the MCP
 * `follow-user` tool maps to. A local account's edge is Oxy's. A central MCP
 * request has Oxy move it with the connector's token as consent, and nothing
 * reaches a federation connector or the fediverse-sharing gate. Federated
 * targets keep their path unchanged.
 */

const mocks = vi.hoisted(() => ({
  isFediverseSharingEnabled: vi.fn(),
  connectorFor: vi.fn(),
  deliver: vi.fn(),
  getUserById: vi.fn(),
  getProfileByUsername: vi.fn(),
  makeServiceRequest: vi.fn(),
  invalidateViewerRelations: vi.fn(),
}));

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({ getUserById: mocks.getUserById }),
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
vi.mock('../../connectors/atproto/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../connectors/atproto/constants')>()),
  ATPROTO_ENABLED: false,
}));

vi.mock('../../connectors/index', () => ({
  connectorRegistry: {
    list: () => [],
    connectorFor: (...args: unknown[]) => mocks.connectorFor(...args),
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
  getServiceOxyClient: () => ({
    getUserById: mocks.getUserById,
    getProfileByUsername: mocks.getProfileByUsername,
    makeServiceRequest: mocks.makeServiceRequest,
  }),
}));

vi.mock('../../utils/privacyHelpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/privacyHelpers')>()),
  invalidateViewerRelations: (...args: unknown[]) => mocks.invalidateViewerRelations(...args),
}));

vi.mock('../../services/fediverseSharing', () => ({
  isFediverseSharingEnabled: (...args: unknown[]) => mocks.isFediverseSharingEnabled(...args),
}));

import connectorsRoutes from '../../connectors/connectors.routes';
import { OWN_DOMAINS } from '../../connectors/activitypub/ownDomain';

const TARGET_ID = '01a0d834-b80a-7cbd-b416-5502d33318c9';

function buildApp(mcp?: { authMode: 'central' | 'legacy' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (mcp) Object.assign(req, { mcp: { ...mcp, activeUserId: 'local-user-1' } });
    next();
  });
  app.use('/federation', connectorsRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isFediverseSharingEnabled.mockResolvedValue(true);
  mocks.connectorFor.mockReturnValue({ deliver: mocks.deliver });
  mocks.deliver.mockResolvedValue(undefined);
  mocks.getProfileByUsername.mockImplementation(async (username: string) => {
    if (username === 'qatest0925') return { id: TARGET_ID, username: 'qatest0925', type: 'local' };
    throw Object.assign(new Error('not found'), { status: 404 });
  });
  mocks.getUserById.mockImplementation(async (id: string) => (
    id === TARGET_ID ? { id: TARGET_ID, username: 'qatest0925', type: 'local' } : { id, username: 'nate' }
  ));
  mocks.makeServiceRequest.mockResolvedValue({
    account_id: 'local-user-1',
    target_user_id: TARGET_ID,
    action: 'follow',
    changed: true,
  });
});

describe('POST /federation/follow — local accounts over a central MCP connection', () => {
  const ownAcct = `qatest0925@${OWN_DOMAINS[0]}`;

  it.each([
    ['a bare username', 'qatest0925'],
    ['an @username', '@qatest0925'],
    ['an acct on our own domain', ownAcct],
    ['an Oxy user id', TARGET_ID],
  ])('follows %s through Oxy with the connection token as consent', async (_label, actorUri) => {
    const res = await request(buildApp({ authMode: 'central' }))
      .post('/federation/follow')
      .set('Authorization', 'Bearer central-mcp-token')
      .send({ actorUri })
      .expect(200);

    expect(res.body).toMatchObject({ success: true, pending: false, changed: true, oxyUserId: TARGET_ID });
    expect(mocks.makeServiceRequest).toHaveBeenCalledWith('POST', '/auth/mcp/oauth/connections/follow', {
      token: 'central-mcp-token',
      tool: 'follow-user',
      target_user_id: TARGET_ID,
      action: 'follow',
    });
    expect(mocks.invalidateViewerRelations).toHaveBeenCalledWith('local-user-1');
    // No outbound activity: neither the connector nor the sharing gate is involved.
    expect(mocks.connectorFor).not.toHaveBeenCalled();
    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(mocks.isFediverseSharingEnabled).not.toHaveBeenCalled();
  });

  it('unfollows with the unfollow tool', async () => {
    await request(buildApp({ authMode: 'central' }))
      .post('/federation/unfollow')
      .set('Authorization', 'Bearer central-mcp-token')
      .send({ actorUri: '@qatest0925' })
      .expect(200);

    expect(mocks.makeServiceRequest).toHaveBeenCalledWith('POST', '/auth/mcp/oauth/connections/follow', {
      token: 'central-mcp-token',
      tool: 'unfollow-user',
      target_user_id: TARGET_ID,
      action: 'unfollow',
    });
  });

  it('refuses when Oxy moved a different account’s edge', async () => {
    mocks.makeServiceRequest.mockResolvedValue({ account_id: 'someone-else', changed: true });

    await request(buildApp({ authMode: 'central' }))
      .post('/federation/follow')
      .set('Authorization', 'Bearer central-mcp-token')
      .send({ actorUri: 'qatest0925' })
      .expect(500);
  });

  it('404s an unknown local account without asking Oxy to follow anything', async () => {
    mocks.getUserById.mockRejectedValue(Object.assign(new Error('nope'), { status: 404 }));

    await request(buildApp({ authMode: 'central' }))
      .post('/federation/follow')
      .set('Authorization', 'Bearer central-mcp-token')
      .send({ actorUri: 'nobody-here' })
      .expect(404);
    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
  });

  it('refuses a local follow with no consent Oxy accepts (legacy token, session)', async () => {
    for (const app of [buildApp({ authMode: 'legacy' }), buildApp()]) {
      await request(app)
        .post('/federation/follow')
        .set('Authorization', 'Bearer some-token')
        .send({ actorUri: 'qatest0925' })
        .expect(400);
    }
    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
  });

  it('leaves a remote acct on the federated path, unchanged', async () => {
    // Connector resolution reads Postgres, which this file does not start (the
    // sharing-gate suite covers delivery). What matters here is the path taken:
    // the fediverse-sharing gate, never Oxy's local follow.
    await request(buildApp({ authMode: 'central' }))
      .post('/federation/follow')
      .set('Authorization', 'Bearer central-mcp-token')
      .send({ actorUri: 'alice@remote.example' });

    expect(mocks.isFediverseSharingEnabled).toHaveBeenCalledWith('local-user-1');
    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
  });
});
