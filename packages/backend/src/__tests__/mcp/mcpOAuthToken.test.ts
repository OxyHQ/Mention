import type { OxyServices } from '@oxyhq/core';
import { eq } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.MENTION_MCP_JWT_SECRET = 'test-mcp-secret-that-is-at-least-32-bytes';

const mocks = vi.hoisted(() => ({ revokeJti: vi.fn() }));

vi.mock('../../mcp/services/mcpRevocationService', () => ({
  revokeJti: mocks.revokeJti,
  isRevoked: vi.fn().mockResolvedValue(false),
}));

import { createConnection } from '../../db/mcp/mcpConnectionRepository';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { mcpConnections } from '../../db/schema/mcp';
import { createMcpOAuthRoutes } from '../../mcp/routes/mcpOAuth.routes';
import { hashToken, verifyAccessToken } from '../../mcp/services/mcpTokenService';

const OXY_USER = 'mcptok-user-7';
const BEFORE_CUTOFF = Date.parse('2026-09-02T00:00:00.000Z');
const AFTER_CUTOFF = Date.parse('2026-10-02T00:00:00.000Z');

function buildApp(now = BEFORE_CUTOFF) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(createMcpOAuthRoutes({} as OxyServices, { now: () => now }));
  return app;
}

async function seedConnection(refreshToken: string, revokedAt?: Date): Promise<void> {
  const row = await createConnection({
    oxyUserId: OXY_USER,
    clientId: 'claude-web',
    clientLabel: 'Claude',
    scopes: ['mcp:read'],
    bundleId: 'mcptok-bundle',
    isBundlePrimary: true,
    refreshTokenHash: hashToken(refreshToken),
    jti: 'old-jti',
    lastUsedAt: new Date(),
  });
  if (revokedAt) {
    await getDb()
      .update(mcpConnections)
      .set({ revokedAt })
      .where(eq(mcpConnections.id, row.id));
  }
}

beforeAll(async () => {
  await connectPostgres();
}, 60_000);

afterAll(async () => {
  await getDb().delete(mcpConnections).where(eq(mcpConnections.oxyUserId, OXY_USER));
  await closePostgres();
});

describe('legacy MCP refresh transition', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.revokeJti.mockResolvedValue(undefined);
    await getDb().delete(mcpConnections).where(eq(mcpConnections.oxyUserId, OXY_USER));
  });

  it('rotates a live pre-migration refresh family before the cutoff', async () => {
    await seedConnection('old-refresh');

    const response = await request(buildApp()).post('/mcp/oauth/token').send({
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh',
      client_id: 'claude-web',
    });

    expect(response.status).toBe(200);
    expect(response.body.refresh_token).not.toBe('old-refresh');
    const [rotated] = await getDb()
      .select()
      .from(mcpConnections)
      .where(eq(mcpConnections.oxyUserId, OXY_USER));
    expect(rotated.refreshTokenHash).toBe(hashToken(response.body.refresh_token));
    expect(mocks.revokeJti).toHaveBeenCalledWith('old-jti');
    expect(verifyAccessToken(response.body.access_token).sub).toBe(OXY_USER);
  });

  it('allows exactly one rotation of a refresh token', async () => {
    await seedConnection('one-shot-refresh');
    const app = buildApp();
    const first = await request(app).post('/mcp/oauth/token').send({
      grant_type: 'refresh_token',
      refresh_token: 'one-shot-refresh',
      client_id: 'claude-web',
    });
    const second = await request(app).post('/mcp/oauth/token').send({
      grant_type: 'refresh_token',
      refresh_token: 'one-shot-refresh',
      client_id: 'claude-web',
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('invalid_grant');
  });

  it('rejects revoked or unknown refresh families', async () => {
    await seedConnection('revoked-refresh', new Date());
    const app = buildApp();
    const [revoked, unknown] = await Promise.all([
      request(app).post('/mcp/oauth/token').send({
        grant_type: 'refresh_token',
        refresh_token: 'revoked-refresh',
        client_id: 'claude-web',
      }),
      request(app).post('/mcp/oauth/token').send({
        grant_type: 'refresh_token',
        refresh_token: 'unknown-refresh',
        client_id: 'claude-web',
      }),
    ]);
    expect(revoked.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(mocks.revokeJti).not.toHaveBeenCalled();
  });

  it('rejects duplicate or non-string OAuth parameters', async () => {
    await seedConnection('duplicate-refresh');
    const app = buildApp();
    const [duplicateGrant, duplicateToken, duplicateClient] = await Promise.all([
      request(app).post('/mcp/oauth/token').send({
        grant_type: ['refresh_token', 'authorization_code'],
        refresh_token: 'duplicate-refresh',
        client_id: 'claude-web',
      }),
      request(app).post('/mcp/oauth/token').send({
        grant_type: 'refresh_token',
        refresh_token: ['duplicate-refresh', 'another-refresh'],
        client_id: 'claude-web',
      }),
      request(app).post('/mcp/oauth/token').send({
        grant_type: 'refresh_token',
        refresh_token: 'duplicate-refresh',
        client_id: ['claude-web', 'another-client'],
      }),
    ]);

    expect(duplicateGrant.status).toBe(400);
    expect(duplicateGrant.body.error).toBe('unsupported_grant_type');
    expect(duplicateToken.status).toBe(400);
    expect(duplicateToken.body.error).toBe('invalid_request');
    expect(duplicateClient.status).toBe(400);
    expect(duplicateClient.body.error).toBe('invalid_request');
    expect(mocks.revokeJti).not.toHaveBeenCalled();
  });

  it('retires even a valid legacy refresh family at the fixed cutoff', async () => {
    await seedConnection('cutoff-refresh');
    const response = await request(buildApp(AFTER_CUTOFF)).post('/mcp/oauth/token').send({
      grant_type: 'refresh_token',
      refresh_token: 'cutoff-refresh',
      client_id: 'claude-web',
    });
    expect(response.status).toBe(410);
    expect(response.body.error).toBe('legacy_mcp_oauth_retired');
  });
});
