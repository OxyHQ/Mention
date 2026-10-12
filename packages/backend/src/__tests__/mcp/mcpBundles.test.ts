import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The connector's account routes (`/mcp/bundles/*`). Oxy owns which accounts an
 * MCP connection may act as; these routes read that set off the request's
 * connection and relay switches and link requests to Oxy, carrying the MCP
 * bearer as the SUBJECT of a service-authenticated call.
 */

const mocks = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getProfileByUsername: vi.fn(),
  serviceRequest: vi.fn(),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    users: {
      get: mocks.getUserById,
      byUsername: mocks.getProfileByUsername,
      getMany: vi.fn(),
    },
    // The connection routes reach Oxy through the SERVICE credential; the MCP
    // bearer travels as the subject of the call, never as its credential.
    serviceRequest: mocks.serviceRequest,
  }),
}));

import mcpBundlesRoutes from '../../mcp/routes/mcpBundles.routes';
import type { OxyAuthRequestWithMcp } from '../../mcp/middleware/mcpAuth';

const USER_A = 'mcpbun-user-a';
const USER_B = 'mcpbun-user-b';

function buildApp(userId: string, mcpContext?: OxyAuthRequestWithMcp['mcp']) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const authReq = req as express.Request & {
      user?: { id: string };
      mcp?: OxyAuthRequestWithMcp['mcp'];
    };
    authReq.user = { id: userId };
    if (mcpContext) {
      authReq.mcp = mcpContext;
    }
    next();
  });
  app.use('/mcp/bundles', mcpBundlesRoutes);
  return app;
}

const centralContext: OxyAuthRequestWithMcp['mcp'] = {
  jti: 'central-jti',
  scope: 'social.accounts.read social.accounts.link social.accounts.switch',
  clientId: 'central-client',
  primaryUserId: 'owner-user',
  activeUserId: USER_A,
};

/** A central connection Oxy says covers two accounts, acting as the first. */
const connectedCentralContext: OxyAuthRequestWithMcp['mcp'] = {
  ...centralContext,
  connection: {
    connectionId: 'connection-1',
    originAccountId: USER_A,
    activeAccountId: USER_A,
    accounts: [
      { accountId: USER_A, isOrigin: true, linkedAt: '2026-01-01T00:00:00.000Z' },
      { accountId: USER_B, isOrigin: false, linkedAt: '2026-02-01T00:00:00.000Z' },
    ],
  },
};

describe('MCP bundles routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserById.mockResolvedValue({
      id: USER_A,
      username: 'alice',
      name: { displayName: 'Alice' },
    });
  });

  it('refuses a caller that is not an MCP connection', async () => {
    const app = buildApp(USER_A);
    const [accounts, link, active] = await Promise.all([
      request(app).get('/mcp/bundles/accounts'),
      request(app).post('/mcp/bundles/link-token'),
      request(app).post('/mcp/bundles/active').send({ handle: '@brand' }),
    ]);
    expect([accounts.status, link.status, active.status]).toEqual([403, 403, 403]);
    expect(mocks.serviceRequest).not.toHaveBeenCalled();
  });

  it('keeps a central connection isolated to its one bound account', async () => {
    const res = await request(buildApp(USER_A, centralContext)).get('/mcp/bundles/accounts');

    expect(res.status).toBe(200);
    expect(res.body.accounts).toEqual([
      expect.objectContaining({
        oxyUserId: USER_A,
        isPrimary: true,
        isActive: true,
      }),
    ]);
  });

  it('lists every account Oxy says the central connection covers', async () => {
    mocks.getUserById.mockImplementation(async (id: string) => ({
      id,
      username: id === USER_A ? 'alice' : 'brand',
      name: { displayName: id === USER_A ? 'Alice' : 'Brand' },
    }));

    const res = await request(buildApp(USER_A, connectedCentralContext)).get(
      '/mcp/bundles/accounts',
    );

    expect(res.status).toBe(200);
    expect(res.body.connectionId).toBe('connection-1');
    expect(res.body.accounts).toEqual([
      expect.objectContaining({ oxyUserId: USER_A, isPrimary: true, isActive: true }),
      expect.objectContaining({ oxyUserId: USER_B, isPrimary: false, isActive: false }),
    ]);
  });

  it('hands back the Oxy link that connects another account', async () => {
    mocks.serviceRequest.mockResolvedValue({
      link_url: 'https://auth.oxy.so/mcp/link?intent=oxy_mli_test',
      expires_in: 900,
      connection_id: 'connection-1',
    });

    const res = await request(buildApp(USER_A, centralContext))
      .post('/mcp/bundles/link-token')
      .set('Authorization', 'Bearer mcp-access-token');

    expect(res.status).toBe(200);
    expect(res.body.linkUrl).toBe('https://auth.oxy.so/mcp/link?intent=oxy_mli_test');
    expect(res.body.expiresInSeconds).toBe(900);
    expect(mocks.serviceRequest).toHaveBeenCalledWith(
      'POST',
      '/auth/mcp/oauth/connections/link-intent',
      { token: 'mcp-access-token' },
    );
  });

  it('switches a central connection to another connected account by handle', async () => {
    mocks.getProfileByUsername.mockResolvedValue({ id: USER_B, username: 'brand' });
    mocks.getUserById.mockResolvedValue({
      id: USER_B,
      username: 'brand',
      name: { displayName: 'Brand' },
    });
    mocks.serviceRequest.mockResolvedValue({
      connection: {
        connection_id: 'connection-1',
        origin_account_id: USER_A,
        active_account_id: USER_B,
        accounts: [
          { account_id: USER_A, is_origin: true, linked_at: '2026-01-01T00:00:00.000Z' },
          { account_id: USER_B, is_origin: false, linked_at: '2026-02-01T00:00:00.000Z' },
        ],
      },
    });

    const res = await request(buildApp(USER_A, connectedCentralContext))
      .post('/mcp/bundles/active')
      .set('Authorization', 'Bearer mcp-access-token')
      .send({ handle: '@brand' });

    expect(res.status).toBe(200);
    expect(res.body.activeUserId).toBe(USER_B);
    expect(mocks.serviceRequest).toHaveBeenCalledWith(
      'POST',
      '/auth/mcp/oauth/connections/active',
      { token: 'mcp-access-token', account_id: USER_B },
    );
  });

  it("relays Oxy's refusal to act as an account that never approved the connection", async () => {
    mocks.getProfileByUsername.mockResolvedValue({ id: USER_B, username: 'brand' });
    // The SDK normalizes an OAuth refusal into this shape, with
    // `error_description` already promoted to `message`.
    mocks.serviceRequest.mockRejectedValue({
      status: 404,
      code: 'invalid_request',
      message: 'That account is not connected to this MCP connection',
    });

    const res = await request(buildApp(USER_A, connectedCentralContext))
      .post('/mcp/bundles/active')
      .set('Authorization', 'Bearer mcp-access-token')
      .send({ handle: '@brand' });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('That account is not connected to this MCP connection');
  });

  it('refuses a central connection request that carries no MCP bearer', async () => {
    const res = await request(buildApp(USER_A, centralContext)).post('/mcp/bundles/link-token');

    expect(res.status).toBe(401);
    expect(mocks.serviceRequest).not.toHaveBeenCalled();
  });

  it('GET /mcp/bundles/me never exposes the raw Oxy id when Oxy is down', async () => {
    mocks.getUserById.mockRejectedValueOnce(new Error('oxy unavailable'));

    const res = await request(buildApp(USER_A, centralContext)).get('/mcp/bundles/me');

    expect(res.status).toBe(200);
    expect(res.body.oxyUserId).toBe(USER_A);
    expect(res.body.username).toBe('');
    expect(res.body.handle).toBe('');
    expect(res.body.displayName).toBe('Unknown user');
  });

  it('GET /mcp/bundles/me degrades safely when Oxy returns an identity miss', async () => {
    mocks.getUserById.mockResolvedValueOnce({
      id: USER_A,
      username: USER_A,
      name: { displayName: USER_A },
    });

    const res = await request(buildApp(USER_A, centralContext)).get('/mcp/bundles/me');

    expect(res.status).toBe(200);
    expect(res.body.username).toBe('');
    expect(res.body.handle).toBe('');
    expect(res.body.displayName).toBe('Unknown user');
  });

  it('GET /mcp/bundles/me reports the origin account as primary, a linked one as not', async () => {
    const asOrigin = await request(buildApp(USER_A, connectedCentralContext)).get(
      '/mcp/bundles/me',
    );
    expect(asOrigin.body.isPrimary).toBe(true);

    mocks.getUserById.mockResolvedValue({
      id: USER_B,
      username: 'brand',
      name: { displayName: 'Brand' },
    });
    const asLinked = await request(
      buildApp(USER_B, {
        ...connectedCentralContext!,
        activeUserId: USER_B,
        connection: { ...connectedCentralContext!.connection!, activeAccountId: USER_B },
      }),
    ).get('/mcp/bundles/me');
    expect(asLinked.body.isPrimary).toBe(false);
  });
});
