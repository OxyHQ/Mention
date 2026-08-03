import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OxyServices } from '@oxyhq/core';

process.env.MENTION_MCP_JWT_SECRET = 'test-mcp-secret';

vi.mock('../../mcp/services/mcpRevocationService', () => ({
  isRevoked: vi.fn().mockResolvedValue(false),
}));

import { createRequireMcpOrOxyAuth } from '../../mcp/middleware/mcpAuth';
import { signAccessToken } from '../../mcp/services/mcpTokenService';

function token(scopes: string[]): string {
  return signAccessToken({
    oxyUserId: 'user-1',
    clientId: 'test-client',
    scopes,
    jti: crypto.randomUUID(),
  });
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
  return app;
}

describe('createRequireMcpOrOxyAuth MCP scope enforcement', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
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
});
