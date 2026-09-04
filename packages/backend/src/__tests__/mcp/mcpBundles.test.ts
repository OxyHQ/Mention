import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';

process.env.MENTION_MCP_JWT_SECRET = 'test-mcp-secret-that-is-at-least-32-bytes';

/**
 * The multi-account bundle routes, against REAL `mcp_connections` rows.
 *
 * Bundle membership is a PERMISSION question — "is this account linked to the
 * connector making the request" — and its `revoked_at IS NULL` half decides
 * whether a revoked account can still be switched to. A mocked model answers
 * that question with whatever the mock was told, which is the one thing a
 * permission gate must never be checked against.
 *
 * Redis stays mocked with a controllable `isReady`, because the 503 case is
 * specifically "NEITHER store recorded the switch" and the only way to observe
 * it is to fail both halves deliberately.
 */

const mocks = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getProfileByUsername: vi.fn(),
  makeServiceRequest: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisReady: true,
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUserById: mocks.getUserById,
    getProfileByUsername: mocks.getProfileByUsername,
    getUsersByIds: vi.fn(),
    // The connection routes reach Oxy through the SERVICE credential; the MCP
    // bearer travels as the subject of the call, never as its credential.
    makeServiceRequest: mocks.makeServiceRequest,
  }),
}));

vi.mock('../../utils/redis', () => ({
  getRedisClient: () => ({
    get isReady() {
      return mocks.redisReady;
    },
    get: mocks.redisGet,
    set: mocks.redisSet,
  }),
}));

vi.mock('../../utils/redisHelpers', () => ({
  withRedisFallback: vi.fn(async (redis, fn, fallback) => {
    if (!redis.isReady) return fallback;
    try {
      return await fn();
    } catch {
      return fallback;
    }
  }),
}));

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { mcpConnections } from '../../db/schema/mcp';
import { createConnection } from '../../db/mcp/mcpConnectionRepository';
import mcpBundlesRoutes from '../../mcp/routes/mcpBundles.routes';
import type { OxyAuthRequestWithMcp } from '../../mcp/middleware/mcpAuth';

/** Per-file namespace — vitest runs files in parallel against one database. */
const SCOPE = 'mcpbun';
const USER_A = `${SCOPE}-user-a`;
const USER_B = `${SCOPE}-user-b`;
const BUNDLE = `${SCOPE}-bundle-1`;
const OWNED_USER_IDS = [USER_A, USER_B];

/** A live connection in this file's bundle. */
async function seedConnection(
  oxyUserId: string,
  options: { isBundlePrimary: boolean; revoked?: boolean } = { isBundlePrimary: false },
): Promise<string> {
  const row = await createConnection({
    oxyUserId,
    clientId: 'claude-web',
    clientLabel: 'Claude',
    scopes: ['mcp:read', 'mcp:write'],
    bundleId: BUNDLE,
    isBundlePrimary: options.isBundlePrimary,
    activeOxyUserId: options.isBundlePrimary ? USER_A : null,
    refreshTokenHash: `${SCOPE}-${oxyUserId}-${Date.now()}-${Math.random()}`,
    jti: `${SCOPE}-${oxyUserId}-jti`,
    lastUsedAt: new Date(),
  });
  if (options.revoked) {
    await getDb()
      .update(mcpConnections)
      .set({ revokedAt: new Date() })
      .where(eq(mcpConnections.id, row.id));
  }
  return row.id;
}

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

const bundleContext: OxyAuthRequestWithMcp['mcp'] = {
  authMode: 'legacy',
  jti: 'jti-1',
  scope: 'mcp:read mcp:write',
  clientId: 'claude-web',
  bundleId: BUNDLE,
  primaryUserId: USER_A,
  activeUserId: USER_A,
};

const centralContext: OxyAuthRequestWithMcp['mcp'] = {
  authMode: 'central',
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

beforeAll(async () => {
  await connectPostgres();
}, 60_000);

afterAll(async () => {
  await getDb().delete(mcpConnections).where(inArray(mcpConnections.oxyUserId, OWNED_USER_IDS));
  await closePostgres();
});

describe('MCP bundles routes', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.redisReady = true;
    mocks.redisSet.mockResolvedValue('OK');
    mocks.getUserById.mockResolvedValue({
      id: USER_A,
      username: 'alice',
      name: { displayName: 'Alice' },
    });

    await getDb().delete(mcpConnections).where(inArray(mcpConnections.oxyUserId, OWNED_USER_IDS));
  });

  it('retires new account links on a legacy bundle', async () => {
    // Legacy bundles keep their members but cannot grow: widening a connection
    // is Oxy's now, and a legacy bundle has no Oxy connection to widen.
    const app = buildApp(USER_A, bundleContext);
    const [start, complete] = await Promise.all([
      request(app).post('/mcp/bundles/link-token'),
      request(app).post('/mcp/bundles/link/complete').send({ token: 'old-link' }),
    ]);
    expect(start.status).toBe(410);
    expect(complete.status).toBe(410);
    expect(start.body.code).toBe('legacy_account_linking_retired');
    expect(complete.body.code).toBe('legacy_account_linking_retired');
  });

  it('GET /mcp/bundles/accounts lists live members and marks the active one', async () => {
    await seedConnection(USER_A, { isBundlePrimary: true });
    await seedConnection(USER_B);
    mocks.getUserById.mockImplementation(async (id: string) => ({
      id,
      username: id === USER_A ? 'alice' : 'brand',
      name: { displayName: id === USER_A ? 'Alice' : 'Brand' },
    }));

    const res = await request(buildApp(USER_A, bundleContext)).get('/mcp/bundles/accounts');

    expect(res.status).toBe(200);
    // Primary first, then oldest — the order the route relies on.
    expect(res.body.accounts.map((a: { oxyUserId: string }) => a.oxyUserId)).toEqual([
      USER_A,
      USER_B,
    ]);
    expect(res.body.accounts[0].isPrimary).toBe(true);
    expect(res.body.accounts[0].isActive).toBe(true);
    expect(res.body.accounts[1].isPrimary).toBe(false);
  });

  it('keeps a central connection isolated to its one bound account', async () => {
    const res = await request(buildApp(USER_A, centralContext)).get('/mcp/bundles/accounts');

    expect(res.status).toBe(200);
    expect(res.body.bundleId).toBeNull();
    expect(res.body.accounts).toEqual([expect.objectContaining({
      oxyUserId: USER_A,
      isPrimary: true,
      isActive: true,
    })]);
  });

  it('lists every account Oxy says the central connection covers', async () => {
    mocks.getUserById.mockImplementation(async (id: string) => ({
      id,
      username: id === USER_A ? 'alice' : 'brand',
      name: { displayName: id === USER_A ? 'Alice' : 'Brand' },
    }));

    const res = await request(buildApp(USER_A, connectedCentralContext))
      .get('/mcp/bundles/accounts');

    expect(res.status).toBe(200);
    expect(res.body.connectionId).toBe('connection-1');
    expect(res.body.accounts).toEqual([
      expect.objectContaining({ oxyUserId: USER_A, isPrimary: true, isActive: true }),
      expect.objectContaining({ oxyUserId: USER_B, isPrimary: false, isActive: false }),
    ]);
  });

  it('hands back the Oxy link that connects another account', async () => {
    mocks.makeServiceRequest.mockResolvedValue({
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
    expect(mocks.makeServiceRequest).toHaveBeenCalledWith(
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
    mocks.makeServiceRequest.mockResolvedValue({
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
    expect(mocks.makeServiceRequest).toHaveBeenCalledWith(
      'POST',
      '/auth/mcp/oauth/connections/active',
      { token: 'mcp-access-token', account_id: USER_B },
    );
  });

  it('relays Oxy\'s refusal to act as an account that never approved the connection', async () => {
    mocks.getProfileByUsername.mockResolvedValue({ id: USER_B, username: 'brand' });
    mocks.makeServiceRequest.mockRejectedValue(Object.assign(new Error('refused'), {
      status: 404,
      data: { error_description: 'That account is not connected to this MCP connection' },
    }));

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
    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
  });

  it('GET /mcp/bundles/accounts omits a revoked member', async () => {
    await seedConnection(USER_A, { isBundlePrimary: true });
    await seedConnection(USER_B, { isBundlePrimary: false, revoked: true });

    const res = await request(buildApp(USER_A, bundleContext)).get('/mcp/bundles/accounts');

    expect(res.status).toBe(200);
    expect(res.body.accounts.map((a: { oxyUserId: string }) => a.oxyUserId)).toEqual([USER_A]);
  });

  it('GET /mcp/bundles/me never exposes the raw Oxy id when Oxy is down', async () => {
    mocks.getUserById.mockRejectedValueOnce(new Error('oxy unavailable'));

    const res = await request(buildApp(USER_A, bundleContext)).get('/mcp/bundles/me');

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

    const res = await request(buildApp(USER_A, bundleContext)).get('/mcp/bundles/me');

    expect(res.status).toBe(200);
    expect(res.body.username).toBe('');
    expect(res.body.handle).toBe('');
    expect(res.body.displayName).toBe('Unknown user');
  });

  it('POST /mcp/bundles/active switches active account by handle', async () => {
    await seedConnection(USER_A, { isBundlePrimary: true });
    await seedConnection(USER_B);
    mocks.getProfileByUsername.mockResolvedValue({ id: USER_B, username: 'brand' });
    mocks.getUserById.mockResolvedValue({
      id: USER_B,
      username: 'brand',
      name: { displayName: 'Brand' },
    });

    const res = await request(buildApp(USER_A, bundleContext))
      .post('/mcp/bundles/active')
      .send({ handle: '@brand' });

    expect(res.status).toBe(200);
    expect(res.body.activeUserId).toBe(USER_B);
    expect(mocks.redisSet).toHaveBeenCalled();

    // The durable half landed on the bundle's PRIMARY row, which is where the
    // fallback is read from when Redis has nothing.
    const [primary] = await getDb()
      .select()
      .from(mcpConnections)
      .where(and(eq(mcpConnections.bundleId, BUNDLE), eq(mcpConnections.isBundlePrimary, true)));
    expect(primary.activeOxyUserId).toBe(USER_B);
  });

  it('POST /mcp/bundles/active refuses an account that is not linked', async () => {
    await seedConnection(USER_A, { isBundlePrimary: true });
    mocks.getProfileByUsername.mockResolvedValue({ id: USER_B, username: 'brand' });

    const res = await request(buildApp(USER_A, bundleContext))
      .post('/mcp/bundles/active')
      .send({ handle: '@brand' });

    expect(res.status).toBe(404);
  });

  it('POST /mcp/bundles/active refuses an account whose link was REVOKED', async () => {
    await seedConnection(USER_A, { isBundlePrimary: true });
    await seedConnection(USER_B, { isBundlePrimary: false, revoked: true });
    mocks.getProfileByUsername.mockResolvedValue({ id: USER_B, username: 'brand' });

    const res = await request(buildApp(USER_A, bundleContext))
      .post('/mcp/bundles/active')
      .send({ handle: '@brand' });

    // The whole point of the gate: a revoked row still EXISTS and still names
    // the bundle. Only `revoked_at IS NULL` distinguishes it.
    expect(res.status).toBe(404);
  });

  it('POST /mcp/bundles/active returns 503 when NEITHER store recorded the switch', async () => {
    // A live member to switch to, but no live PRIMARY to record it on, and
    // Redis unavailable — so both halves of the persistence fail.
    await seedConnection(USER_A, { isBundlePrimary: true, revoked: true });
    await seedConnection(USER_B);
    mocks.getProfileByUsername.mockResolvedValue({ id: USER_B, username: 'brand' });
    mocks.redisReady = false;

    const res = await request(buildApp(USER_A, bundleContext))
      .post('/mcp/bundles/active')
      .send({ handle: '@brand' });

    expect(res.status).toBe(503);
  });

});
