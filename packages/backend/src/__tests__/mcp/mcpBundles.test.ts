import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, isNull } from 'drizzle-orm';

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
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisReady: true,
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUserById: mocks.getUserById,
    getProfileByUsername: mocks.getProfileByUsername,
    getUsersByIds: vi.fn(),
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
import { signLinkToken } from '../../mcp/services/mcpBundleService';
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
  jti: 'jti-1',
  scope: 'mcp:read mcp:write',
  clientId: 'claude-web',
  bundleId: BUNDLE,
  primaryUserId: USER_A,
  activeUserId: USER_A,
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

  it('POST /mcp/bundles/link-token returns a frontend link URL', async () => {
    const app = buildApp(USER_A, bundleContext);
    const res = await request(app).post('/mcp/bundles/link-token');
    expect(res.status).toBe(200);
    expect(res.body.linkUrl).toContain('/oauth/mcp/link?token=');
    expect(res.body.token).toBeTruthy();
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

  it('POST /mcp/bundles/link/complete creates a linked connection', async () => {
    await seedConnection(USER_A, { isBundlePrimary: true });
    const token = signLinkToken(BUNDLE, 'claude-web');
    mocks.getUserById.mockResolvedValue({
      id: USER_B,
      username: 'brand',
      name: { displayName: 'Brand' },
    });

    const res = await request(buildApp(USER_B))
      .post('/mcp/bundles/link/complete')
      .send({ token });

    expect(res.status).toBe(200);
    expect(res.body.handle).toBeTruthy();

    const [linked] = await getDb()
      .select()
      .from(mcpConnections)
      .where(and(eq(mcpConnections.oxyUserId, USER_B), isNull(mcpConnections.revokedAt)));
    expect(linked.bundleId).toBe(BUNDLE);
    expect(linked.isBundlePrimary).toBe(false);
    // Scopes are inherited from the primary — a linked account must never gain
    // more than the grant Claude actually holds.
    expect(linked.scopes).toEqual(['mcp:read', 'mcp:write']);
  });

  it('POST /mcp/bundles/link/complete is idempotent for an already-linked account', async () => {
    await seedConnection(USER_A, { isBundlePrimary: true });
    await seedConnection(USER_B);
    mocks.getUserById.mockResolvedValue({
      id: USER_B,
      username: 'brand',
      name: { displayName: 'Brand' },
    });

    const res = await request(buildApp(USER_B))
      .post('/mcp/bundles/link/complete')
      .send({ token: signLinkToken(BUNDLE, 'claude-web') });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Already linked');

    // One LIVE row, not two. The partial unique index allows revoked history
    // beside it, so this is about live rows specifically.
    const live = await getDb()
      .select()
      .from(mcpConnections)
      .where(and(eq(mcpConnections.oxyUserId, USER_B), isNull(mcpConnections.revokedAt)));
    expect(live).toHaveLength(1);
  });

  it('POST /mcp/bundles/link/complete re-links an account whose previous link was revoked', async () => {
    await seedConnection(USER_A, { isBundlePrimary: true });
    await seedConnection(USER_B, { isBundlePrimary: false, revoked: true });
    mocks.getUserById.mockResolvedValue({
      id: USER_B,
      username: 'brand',
      name: { displayName: 'Brand' },
    });

    const res = await request(buildApp(USER_B))
      .post('/mcp/bundles/link/complete')
      .send({ token: signLinkToken(BUNDLE, 'claude-web') });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Account linked');

    // Revoke-and-re-link is the ordinary recovery path, so BOTH rows survive:
    // one live, one as the revocation record. A dedupe here would destroy the
    // history or, worse, the live row.
    const all = await getDb()
      .select()
      .from(mcpConnections)
      .where(eq(mcpConnections.oxyUserId, USER_B));
    expect(all).toHaveLength(2);
    expect(all.filter((row) => row.revokedAt === null)).toHaveLength(1);
  });

  it('POST /mcp/bundles/link/complete rejects reused link tokens', async () => {
    mocks.redisSet.mockResolvedValue(null);

    const res = await request(buildApp(USER_B))
      .post('/mcp/bundles/link/complete')
      .send({ token: signLinkToken(BUNDLE, 'claude-web') });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('already used');
  });

  it('POST /mcp/bundles/link/complete refuses a bundle with no live primary', async () => {
    await seedConnection(USER_A, { isBundlePrimary: true, revoked: true });

    const res = await request(buildApp(USER_B))
      .post('/mcp/bundles/link/complete')
      .send({ token: signLinkToken(BUNDLE, 'claude-web') });

    expect(res.status).toBe(404);
  });
});
