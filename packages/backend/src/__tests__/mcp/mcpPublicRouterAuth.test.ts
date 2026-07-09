import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { OxyAuthRequest } from '@oxyhq/core/server';

process.env.MENTION_MCP_JWT_SECRET = 'test-mcp-secret';
process.env.MENTION_MCP_PUBLIC_URL = 'https://mcp.mention.earth';

vi.mock('../../mcp/services/mcpRevocationService', () => ({
  isRevoked: vi.fn().mockResolvedValue(false),
  revokeJti: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../mcp/services/mcpBundleService', () => ({
  resolveBundleContext: vi.fn().mockResolvedValue({
    bundleId: 'bundle-test',
    primaryUserId: 'mcp-user-1',
    activeUserId: 'mcp-user-1',
    clientId: 'claude-web',
    jti: 'jti-public-router',
  }),
}));

import {
  bearerLooksLikeMcpToken,
  createOptionalMcpAuth,
} from '../../mcp/middleware/mcpAuth';
import { signAccessToken } from '../../mcp/services/mcpTokenService';

/** Mirrors production optionalAuth after the MCP pass (oxy stub always fails). */
function productionOptionalAuthWithoutOxy(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if ((req as OxyAuthRequest).user?.id) {
    next();
    return;
  }
  if (!req.headers.authorization) {
    next();
    return;
  }
  if (bearerLooksLikeMcpToken(req)) {
    next();
    return;
  }
  (req as OxyAuthRequest).user = undefined;
  next();
}

function buildPublicRouterApp(options: { mountOptionalMcpAuth: boolean }) {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  if (options.mountOptionalMcpAuth) {
    router.use(createOptionalMcpAuth());
  }
  router.use(productionOptionalAuthWithoutOxy);
  router.post('/feed/boost', (req, res) => {
    const userId = (req as OxyAuthRequest).user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    return res.json({ ok: true, userId });
  });
  router.get('/feed/mtn', (req, res) => {
    const userId = (req as OxyAuthRequest).user?.id ?? null;
    return res.json({ userId });
  });
  app.use(router);
  return app;
}

describe('MCP JWT on public API router', () => {
  const token = signAccessToken({
    oxyUserId: 'mcp-user-1',
    clientId: 'claude-web',
    scopes: ['mcp:read', 'mcp:write'],
    jti: 'jti-public-router',
  });

  it('rejects boost on public router when optional MCP auth is not mounted', async () => {
    const app = buildPublicRouterApp({ mountOptionalMcpAuth: false });
    const res = await request(app)
      .post('/feed/boost')
      .set('Authorization', `Bearer ${token}`)
      .send({ originalPostId: 'post-1' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Authentication required');
  });

  it('accepts boost on public router when optional MCP auth is mounted', async () => {
    const app = buildPublicRouterApp({ mountOptionalMcpAuth: true });
    const res = await request(app)
      .post('/feed/boost')
      .set('Authorization', `Bearer ${token}`)
      .send({ originalPostId: 'post-1' });
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('mcp-user-1');
  });

  it('resolves viewer id for personalized feed routes', async () => {
    const app = buildPublicRouterApp({ mountOptionalMcpAuth: true });
    const res = await request(app)
      .get('/feed/mtn')
      .query({ descriptor: 'for_you' })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('mcp-user-1');
  });
});
