import crypto from 'crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OxyAuthRequest, OxyServer } from '@oxy.so/core/server';

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

import { createOptionalMcpAuth, createRequireMcpOrOxyAuth } from '../../mcp/middleware/mcpAuth';
import { config } from '../../config';

/** A Mention-issued token as the retired authority minted them: HS256, for the MCP resource. */
function retiredLegacyToken(): string {
  return jwt.sign(
    { client_id: 'test-client', scope: 'mcp:read mcp:write' },
    'any-secret-at-least-32-bytes-long-xx',
    { algorithm: 'HS256', subject: 'user-1', jwtid: crypto.randomUUID(), audience: config.mcp.resourceUrl, expiresIn: '5m' },
  );
}

function centralToken(
  scopes: string[],
  connection?: Record<string, unknown>,
): string {
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
    ...(connection ? { connection } : {}),
  });
  return value;
}

/** A connection Oxy reports as covering two accounts, acting as `activeId`. */
function connectionState(activeId: string): Record<string, unknown> {
  return {
    connection_id: 'connection-1',
    origin_account_id: 'account-1',
    active_account_id: activeId,
    accounts: [
      { account_id: 'account-1', is_origin: true, linked_at: '2026-01-01T00:00:00.000Z' },
      { account_id: 'account-2', is_origin: false, linked_at: '2026-02-01T00:00:00.000Z' },
    ],
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  const fakeOxy = {
    middleware: {
      auth: () => (_req: express.Request, res: express.Response) => res.status(401).json({ error: 'oxy_required' }),
    },
  } as unknown as OxyServer;
  app.use(createRequireMcpOrOxyAuth(fakeOxy));
  app.get('/resource', (_req, res) => res.json({ ok: true }));
  app.post('/resource', (_req, res) => res.status(201).json({ ok: true }));
  app.get('/notifications', (req, res) => res.json({ userId: (req as OxyAuthRequest).userId }));
  app.post('/posts', (req, res) => res.status(201).json({ userId: (req as OxyAuthRequest).userId }));
  app.delete('/feed/:postId/boost', (req, res) => res.json({ userId: (req as OxyAuthRequest).userId }));
  app.post('/mute', (req, res) => res.status(201).json({ userId: (req as OxyAuthRequest).userId }));
  return app;
}

function buildProductionOrderedApp() {
  const app = express();
  app.use(express.json());
  const fakeOxy = {
    middleware: {
      auth: () => (_req: express.Request, res: express.Response) => res.status(401).json({ error: 'oxy_required' }),
    },
  } as unknown as OxyServer;
  app.use(createOptionalMcpAuth());
  app.use(createRequireMcpOrOxyAuth(fakeOxy));
  app.post('/posts', (req, res) => res.status(201).json({ userId: (req as OxyAuthRequest).userId }));
  return app;
}

describe('createRequireMcpOrOxyAuth MCP scope enforcement', () => {
  const app = buildApp();
  const productionOrderedApp = buildProductionOrderedApp();

  beforeEach(() => {
    vi.clearAllMocks();
    centralTokens.clear();
  });
  it('refuses a token pre-resolved by optional auth when it lacks the route\'s capability', async () => {
    const res = await request(productionOrderedApp)
      .post('/posts')
      .set('Authorization', `Bearer ${centralToken(['social.notifications.read'])}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('insufficient_scope');
    expect(res.body.required_scope).toEqual(['social.posts.publish']);
  });

  it('serves a token pre-resolved by optional auth that carries the route\'s capability', async () => {
    const res = await request(productionOrderedApp)
      .post('/posts')
      .set('Authorization', `Bearer ${centralToken(['social.posts.publish'])}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ userId: 'account-1' });
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

  it('lets the boost capability undo its own boost', async () => {
    const res = await request(app)
      .delete('/feed/post-1/boost')
      .set('Authorization', `Bearer ${centralToken(['social.interact'])}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: 'account-1' });
  });

  it('keeps muting behind its own capability', async () => {
    const refused = await request(app)
      .post('/mute')
      .set('Authorization', `Bearer ${centralToken(['social.interact'])}`)
      .send({ mutedId: 'user-2' });
    expect(refused.status).toBe(403);
    expect(refused.body.required_scope).toEqual(['social.mutes.manage']);

    const allowed = await request(app)
      .post('/mute')
      .set('Authorization', `Bearer ${centralToken(['social.mutes.manage'])}`)
      .send({ mutedId: 'user-2' });
    expect(allowed.status).toBe(201);
  });

  it('does not widen central tokens to backend routes absent from the catalog', async () => {
    const res = await request(app)
      .get('/resource')
      .set('Authorization', `Bearer ${centralToken(['social.read'])}`);

    expect(res.status).toBe(403);
    expect(res.body.required_scope).toEqual([]);
  });
  it('serves the connection member Oxy selected, not the token account', async () => {
    const res = await request(app)
      .get('/notifications')
      .set(
        'Authorization',
        `Bearer ${centralToken(['social.notifications.read'], connectionState('account-2'))}`,
      );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: 'account-2' });
  });

  it('ignores a connection block that names an account it does not list', async () => {
    const invalid = {
      ...connectionState('account-2'),
      accounts: [{ account_id: 'account-1', is_origin: true, linked_at: '2026-01-01T00:00:00.000Z' }],
    };
    const res = await request(app)
      .get('/notifications')
      .set('Authorization', `Bearer ${centralToken(['social.notifications.read'], invalid)}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: 'account-1' });
  });

  it('ignores a connection block belonging to another connection', async () => {
    const foreign = { ...connectionState('account-2'), origin_account_id: 'account-9' };
    const res = await request(app)
      .get('/notifications')
      .set('Authorization', `Bearer ${centralToken(['social.notifications.read'], foreign)}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: 'account-1' });
  });
});

describe('retired Mention-issued MCP tokens', () => {
  const app = buildApp();

  it('are refused with an instruction to reconnect, never tried as an Oxy session', async () => {
    const res = await request(app).get('/notifications').set('Authorization', `Bearer ${retiredLegacyToken()}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: 'invalid_token',
      message: 'Mention-issued MCP tokens were retired on 2026-10-02. Reconnect through Oxy.',
    });
  });
});
