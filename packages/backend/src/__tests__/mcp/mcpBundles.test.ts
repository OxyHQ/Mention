import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.MENTION_MCP_JWT_SECRET = 'test-mcp-secret-that-is-at-least-32-bytes';

const mocks = vi.hoisted(() => ({
  connectionFindOne: vi.fn(),
  connectionFind: vi.fn(),
  connectionCreate: vi.fn(),
  connectionUpdateOne: vi.fn(),
  connectionCountDocuments: vi.fn(),
  getUserById: vi.fn(),
  getProfileByUsername: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisReady: true,
}));

vi.mock('../../mcp/models/McpConnection', () => ({
  McpConnection: {
    findOne: mocks.connectionFindOne,
    find: mocks.connectionFind,
    create: mocks.connectionCreate,
    updateOne: mocks.connectionUpdateOne,
    countDocuments: mocks.connectionCountDocuments,
  },
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

import mcpBundlesRoutes from '../../mcp/routes/mcpBundles.routes';
import { signLinkToken } from '../../mcp/services/mcpBundleService';
import type { OxyAuthRequestWithMcp } from '../../mcp/middleware/mcpAuth';

function buildApp(mcpContext?: OxyAuthRequestWithMcp['mcp']) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const authReq = req as express.Request & { user?: { id: string }; mcp?: OxyAuthRequestWithMcp['mcp'] };
    authReq.user = { id: 'user-a' };
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
  bundleId: 'bundle-1',
  primaryUserId: 'user-a',
  activeUserId: 'user-a',
};

describe('MCP bundles routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisReady = true;
    mocks.redisSet.mockResolvedValue('OK');
    mocks.connectionUpdateOne.mockResolvedValue({ matchedCount: 1 });
    mocks.connectionCountDocuments.mockResolvedValue(1);
    mocks.getUserById.mockResolvedValue({
      id: 'user-a',
      username: 'alice',
      name: { displayName: 'Alice' },
    });
  });

  it('POST /mcp/bundles/link-token returns a frontend link URL', async () => {
    const app = buildApp(bundleContext);
    const res = await request(app).post('/mcp/bundles/link-token');
    expect(res.status).toBe(200);
    expect(res.body.linkUrl).toContain('/oauth/mcp/link?token=');
    expect(res.body.token).toBeTruthy();
  });

  it('GET /mcp/bundles/me never exposes the raw Oxy id when Oxy is down', async () => {
    mocks.getUserById.mockRejectedValueOnce(new Error('oxy unavailable'));

    const res = await request(buildApp(bundleContext)).get('/mcp/bundles/me');

    expect(res.status).toBe(200);
    expect(res.body.oxyUserId).toBe('user-a');
    expect(res.body.username).toBe('');
    expect(res.body.handle).toBe('');
    expect(res.body.displayName).toBe('Unknown user');
  });

  it('GET /mcp/bundles/me degrades safely when Oxy returns an identity miss', async () => {
    mocks.getUserById.mockResolvedValueOnce({
      id: 'user-a',
      username: 'user-a',
      name: { displayName: 'user-a' },
    });

    const res = await request(buildApp(bundleContext)).get('/mcp/bundles/me');

    expect(res.status).toBe(200);
    expect(res.body.username).toBe('');
    expect(res.body.handle).toBe('');
    expect(res.body.displayName).toBe('Unknown user');
  });

  it('POST /mcp/bundles/active switches active account by handle', async () => {
    const app = buildApp(bundleContext);
    mocks.getProfileByUsername.mockResolvedValue({ id: 'user-b', username: 'brand' });
    mocks.connectionFindOne.mockReturnValue({
      lean: () => Promise.resolve({ oxyUserId: 'user-b', bundleId: 'bundle-1' }),
    });
    mocks.getUserById.mockResolvedValueOnce({
      id: 'user-b',
      username: 'brand',
      name: { displayName: 'Brand' },
    });

    const res = await request(app).post('/mcp/bundles/active').send({ handle: '@brand' });
    expect(res.status).toBe(200);
    expect(res.body.activeUserId).toBe('user-b');
    expect(mocks.redisSet).toHaveBeenCalled();
    expect(mocks.connectionUpdateOne).toHaveBeenCalled();
  });

  it('POST /mcp/bundles/active returns 503 when persistence fails', async () => {
    const app = buildApp(bundleContext);
    mocks.getProfileByUsername.mockResolvedValue({ id: 'user-b', username: 'brand' });
    mocks.connectionFindOne.mockReturnValue({
      lean: () => Promise.resolve({ oxyUserId: 'user-b', bundleId: 'bundle-1' }),
    });
    mocks.redisReady = false;
    mocks.connectionUpdateOne.mockResolvedValue({ matchedCount: 0 });

    const res = await request(app).post('/mcp/bundles/active').send({ handle: '@brand' });
    expect(res.status).toBe(503);
  });

  it('POST /mcp/bundles/link/complete creates a linked connection', async () => {
    const token = signLinkToken('bundle-1', 'claude-web');
    mocks.connectionFindOne
      .mockReturnValueOnce({ lean: () => Promise.resolve(null) })
      .mockReturnValueOnce(
        Promise.resolve({
          bundleId: 'bundle-1',
          isBundlePrimary: true,
          clientId: 'claude-web',
          scopes: ['mcp:read', 'mcp:write'],
          clientLabel: 'Claude',
        }),
      );
    mocks.connectionCreate.mockResolvedValue({});
    mocks.getUserById.mockResolvedValue({
      id: 'user-b',
      username: 'brand',
      name: { displayName: 'Brand' },
    });

    const authApp = express();
    authApp.use(express.json());
    authApp.use((req, _res, next) => {
      (req as express.Request & { user?: { id: string } }).user = { id: 'user-b' };
      next();
    });
    authApp.use('/mcp/bundles', mcpBundlesRoutes);

    const res = await request(authApp).post('/mcp/bundles/link/complete').send({ token });
    expect(res.status).toBe(200);
    expect(res.body.handle).toBeTruthy();
    expect(mocks.connectionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        oxyUserId: 'user-b',
        bundleId: 'bundle-1',
        isBundlePrimary: false,
      }),
    );
  });

  it('POST /mcp/bundles/link/complete rejects reused link tokens', async () => {
    const token = signLinkToken('bundle-1', 'claude-web');
    mocks.redisSet.mockResolvedValue(null);

    const authApp = express();
    authApp.use(express.json());
    authApp.use((req, _res, next) => {
      (req as express.Request & { user?: { id: string } }).user = { id: 'user-b' };
      next();
    });
    authApp.use('/mcp/bundles', mcpBundlesRoutes);

    const res = await request(authApp).post('/mcp/bundles/link/complete').send({ token });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('already used');
  });
});
