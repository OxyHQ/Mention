import crypto from 'crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OxyAuthRequest } from '@oxy.so/core/server';

process.env.MENTION_MCP_PUBLIC_URL = 'https://mcp.mention.earth';

/** What Oxy's introspection answers for each token this suite presents. */
const centralTokens = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock('@oxy.so/mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxy.so/mcp')>()),
  introspectOxyMcpAccessToken: vi.fn(async (value: string) => centralTokens.get(value) ?? null),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    serviceToken: async () => 'service-token',
    invalidateServiceToken: () => undefined,
  }),
}));

import {
  bearerLooksLikeMcpToken,
  createOptionalMcpAuth,
} from '../../mcp/middleware/mcpAuth';
import { config } from '../../config';

/** A central (Oxy-issued) MCP token for `mcp-user-1`, live until `centralTokens` forgets it. */
function centralToken(scopes: string[]): string {
  const value = jwt.sign({ aud: config.deploymentMcp.audience }, 'routing-only-test-secret', { algorithm: 'HS256' });
  centralTokens.set(value, {
    iss: config.oxyApiUrl.replace(/\/+$/, ''),
    sub: 'mcp-user-1',
    aud: config.deploymentMcp.audience,
    resource: config.mcp.resourceUrl,
    client_id: 'claude-web',
    scope: scopes.join(' '),
    jti: crypto.randomUUID(),
    iat: 1,
    exp: 4_102_444_800,
    account_id: 'mcp-user-1',
  });
  return value;
}

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

describe('MCP token on public API router', () => {
  let token: string;

  beforeEach(() => {
    centralTokens.clear();
    token = centralToken(['social.read', 'social.interact']);
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

  it('fails closed when Oxy no longer vouches for the token', async () => {
    centralTokens.clear();
    const app = buildPublicRouterApp({ mountOptionalMcpAuth: true });

    const res = await request(app)
      .post('/feed/boost')
      .set('Authorization', `Bearer ${token}`)
      .send({ originalPostId: 'post-1' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Authentication required');
  });
});
