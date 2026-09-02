import crypto from 'crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OxyServices } from '@oxyhq/core';
import type { OxyAuthRequest } from '@oxyhq/core/server';

process.env.MENTION_MCP_JWT_SECRET = 'test-mcp-secret-that-is-at-least-32-bytes';

const centralTokens = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock('@oxyhq/mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxyhq/mcp')>()),
  introspectOxyMcpAccessToken: vi.fn(async (value: string) => centralTokens.get(value) ?? null),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getServiceToken: async () => 'service-token',
    invalidateServiceToken: () => undefined,
  }),
}));

vi.mock('../../mcp/services/mcpRevocationService', () => ({
  isRevoked: vi.fn().mockResolvedValue(false),
}));

// `resolveMcpUser` reads the durable connection row before it trusts a token, so
// without this the middleware waits on a Mongo connection this suite never opens
// and every case times out rather than exercising the scope check.
vi.mock('../../mcp/services/mcpBundleService', () => ({
  resolveBundleContext: vi.fn(async (jti: string, sub: string) => ({
    bundleId: 'bundle-1',
    clientId: 'test-client',
    primaryUserId: sub,
    activeUserId: sub,
    jti,
  })),
}));

import { createOptionalMcpAuth, createRequireMcpOrOxyAuth } from '../../mcp/middleware/mcpAuth';
import { signAccessToken } from '../../mcp/services/mcpTokenService';

function token(scopes: string[]): string {
  return signAccessToken({
    oxyUserId: 'user-1',
    clientId: 'test-client',
    scopes,
    jti: crypto.randomUUID(),
  });
}

function centralToken(scopes: string[]): string {
  const value = jwt.sign(
    { aud: 'mention-api' },
    'routing-only-test-secret',
    { algorithm: 'HS256' },
  );
  centralTokens.set(value, {
    iss: 'https://api.oxy.so',
    sub: 'owner-1',
    aud: 'mention-api',
    resource: 'https://mcp.mention.earth',
    client_id: 'central-client',
    scope: scopes.join(' '),
    jti: crypto.randomUUID(),
    iat: 1,
    exp: 4_102_444_800,
    account_id: 'account-1',
  });
  return value;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  const fakeOxy = {
    auth: () => (_req: express.Request, res: express.Response) => res.status(401).json({ error: 'oxy_required' }),
  } as unknown as OxyServices;
  app.use(createRequireMcpOrOxyAuth(fakeOxy));
  app.get('/resource', (_req, res) => res.json({ ok: true }));
  app.post('/resource', (_req, res) => res.status(201).json({ ok: true }));
  app.get('/notifications', (req, res) => res.json({ userId: (req as OxyAuthRequest).userId }));
  app.post('/posts', (req, res) => res.status(201).json({ userId: (req as OxyAuthRequest).userId }));
  return app;
}

function buildProductionOrderedApp() {
  const app = express();
  app.use(express.json());
  const fakeOxy = {
    auth: () => (_req: express.Request, res: express.Response) => res.status(401).json({ error: 'oxy_required' }),
  } as unknown as OxyServices;
  app.use(createOptionalMcpAuth());
  app.use(createRequireMcpOrOxyAuth(fakeOxy));
  app.post('/resource', (_req, res) => res.status(201).json({ ok: true }));
  return app;
}

describe('createRequireMcpOrOxyAuth MCP scope enforcement', () => {
  const app = buildApp();
  const productionOrderedApp = buildProductionOrderedApp();

  beforeEach(() => {
    vi.clearAllMocks();
    centralTokens.clear();
  });

  it('allows read-scoped MCP tokens on safe read requests', async () => {
    const res = await request(app).get('/resource').set('Authorization', `Bearer ${token(['mcp:read'])}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects read-only MCP tokens on mutating requests', async () => {
    const res = await request(app).post('/resource').set('Authorization', `Bearer ${token(['mcp:read'])}`).send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('insufficient_scope');
    expect(res.body.required_scope).toBe('mcp:write');
  });

  it('rejects offline_access-only MCP tokens on mutating requests', async () => {
    const res = await request(app).post('/resource').set('Authorization', `Bearer ${token(['offline_access'])}`).send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('insufficient_scope');
  });

  it('allows write-scoped MCP tokens on mutating requests', async () => {
    const res = await request(app).post('/resource').set('Authorization', `Bearer ${token(['mcp:read', 'mcp:write'])}`).send({});

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects read-only MCP tokens pre-resolved by optional auth on mutating requests', async () => {
    const res = await request(productionOrderedApp)
      .post('/resource')
      .set('Authorization', `Bearer ${token(['mcp:read'])}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('insufficient_scope');
    expect(res.body.required_scope).toBe('mcp:write');
  });

  it('allows write-scoped MCP tokens pre-resolved by optional auth on mutating requests', async () => {
    const res = await request(productionOrderedApp)
      .post('/resource')
      .set('Authorization', `Bearer ${token(['mcp:read', 'mcp:write'])}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
  });

  it('binds a central token to its exact account and semantic capability', async () => {
    const res = await request(app)
      .get('/notifications')
      .set('Authorization', `Bearer ${centralToken(['social.notifications.read'])}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: 'account-1' });
  });

  it('rejects a central token whose semantic capability belongs to another tool', async () => {
    const res = await request(app)
      .post('/posts')
      .set('Authorization', `Bearer ${centralToken(['social.notifications.read'])}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: 'insufficient_scope',
      required_scope: ['social.posts.publish'],
    });
  });

  it('does not widen central tokens to backend routes absent from the catalog', async () => {
    const res = await request(app)
      .get('/resource')
      .set('Authorization', `Bearer ${centralToken(['social.read'])}`);

    expect(res.status).toBe(403);
    expect(res.body.required_scope).toEqual([]);
  });
});
