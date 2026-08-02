import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { OxyServices } from '@oxyhq/core';

process.env.MENTION_MCP_JWT_SECRET = 'test-mcp-secret-that-is-at-least-32-bytes';

/**
 * The MCP token endpoint, against REAL `mcp_auth_codes` and `mcp_connections`
 * rows.
 *
 * These used to be mocked models, and the port made the mocks inert — but the
 * bigger reason to move them is that the two properties this endpoint exists to
 * hold cannot be observed against a fake at all:
 *
 *  - **A code is single-use.** The mock's `findOneAndUpdate` answered whatever
 *    it was told, so "already used" was a stub's return value rather than the
 *    database refusing a second claim. Here the same code is redeemed twice for
 *    real and the second attempt has to lose.
 *  - **The stored value is a HASH.** A connection row now really carries
 *    `sha256(refresh_token)`, so "the token we returned is the one that
 *    authenticates" is checked against the row a refresh would actually find.
 *
 * `revokeJti` stays mocked: the Redis blocklist is a different mechanism with
 * its own tests, and what matters here is WHICH family gets revoked and when.
 */

const mocks = vi.hoisted(() => ({
  revokeJti: vi.fn(),
}));

vi.mock('../../mcp/services/mcpRevocationService', () => ({
  revokeJti: mocks.revokeJti,
  isRevoked: vi.fn().mockResolvedValue(false),
}));

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { mcpAuthCodes, mcpConnections } from '../../db/schema/mcp';
import { claimAuthCode, createAuthCode } from '../../db/mcp/mcpAuthCodeRepository';
import { createMcpOAuthRoutes } from '../../mcp/routes/mcpOAuth.routes';
import { verifyAccessToken, hashToken } from '../../mcp/services/mcpTokenService';

const CLAUDE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

/**
 * Per-file namespace. Vitest runs files in parallel against ONE database, so
 * every row this suite writes carries it and every cleanup is scoped to it —
 * never "delete all connections".
 */
const SCOPE = 'mcptok';
const OXY_USER = `${SCOPE}-user-42`;
const REFRESH_OXY_USER = `${SCOPE}-user-7`;

const seededCodeIds: string[] = [];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  // The token endpoint never invokes oxy.auth(); a passthrough stub is enough.
  const fakeOxy = {
    auth: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  } as unknown as OxyServices;
  app.use(createMcpOAuthRoutes(fakeOxy));
  return app;
}

function pkce(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

beforeAll(async () => {
  await connectPostgres();
}, 60_000);

afterAll(async () => {
  await closePostgres();
});

describe('POST /mcp/oauth/token', () => {
  const app = buildApp();

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.revokeJti.mockResolvedValue(undefined);

    const db = getDb();
    if (seededCodeIds.length > 0) {
      await db.delete(mcpAuthCodes).where(inArray(mcpAuthCodes.id, seededCodeIds));
      seededCodeIds.length = 0;
    }
    await db
      .delete(mcpConnections)
      .where(inArray(mcpConnections.oxyUserId, [OXY_USER, REFRESH_OXY_USER]));
  });

  it('rejects an unsupported grant_type', async () => {
    const res = await request(app).post('/mcp/oauth/token').send({ grant_type: 'password' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_grant_type');
  });

  describe('authorization_code grant', () => {
    const verifier = 'a-very-long-random-code-verifier-value-1234567890';
    const challenge = pkce(verifier);

    /** A real row. `code` is namespaced because it is UNIQUE across the table. */
    async function seedCode(
      overrides: { usedAt?: Date; expiresAt?: Date; suffix?: string } = {}
    ): Promise<string> {
      const row = await createAuthCode({
        code: `${SCOPE}-code-${overrides.suffix ?? 'default'}`,
        clientId: 'claude-web',
        oxyUserId: OXY_USER,
        redirectUri: CLAUDE_REDIRECT,
        codeChallenge: challenge,
        scopes: ['mcp:read'],
        expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60_000),
      });
      seededCodeIds.push(row.id);
      if (overrides.usedAt) {
        await getDb()
          .update(mcpAuthCodes)
          .set({ usedAt: overrides.usedAt })
          .where(eq(mcpAuthCodes.id, row.id));
      }
      return row.code;
    }

    it('exchanges a valid code (PKCE verified) for an access + refresh token', async () => {
      const code = await seedCode();

      const res = await request(app).post('/mcp/oauth/token').send({
        grant_type: 'authorization_code',
        code,
        client_id: 'claude-web',
        redirect_uri: CLAUDE_REDIRECT,
        code_verifier: verifier,
      });

      expect(res.status).toBe(200);
      expect(res.body.token_type).toBe('Bearer');
      expect(res.body.access_token).toBeTruthy();
      expect(res.body.refresh_token).toBeTruthy();
      expect(res.body.scope).toBe('mcp:read');

      // Access token is valid and carries the granted identity.
      const claims = verifyAccessToken(res.body.access_token);
      expect(claims.sub).toBe(OXY_USER);
      expect(claims.client_id).toBe('claude-web');

      // A connection row exists carrying the HASH of the returned refresh token
      // — never the token itself.
      const created = await getDb()
        .select()
        .from(mcpConnections)
        .where(eq(mcpConnections.oxyUserId, OXY_USER));
      expect(created).toHaveLength(1);
      expect(created[0].refreshTokenHash).toBe(hashToken(res.body.refresh_token));
      expect(created[0].refreshTokenHash).not.toBe(res.body.refresh_token);
      expect(created[0].bundleId).toBeTruthy();
      expect(created[0].isBundlePrimary).toBe(true);
      expect(created[0].activeOxyUserId).toBe(OXY_USER);
      expect(created[0].revokedAt).toBeNull();

      // The code is spent, by the same statement that authorized the exchange.
      const [spent] = await getDb()
        .select()
        .from(mcpAuthCodes)
        .where(eq(mcpAuthCodes.code, code));
      expect(spent.usedAt).not.toBeNull();
    });

    it('lets exactly ONE of two concurrent claims win', async () => {
      // The discriminating case, and the only one that observes the claim at
      // all. Redeeming twice in SEQUENCE is rejected by the route's own
      // `usedAt` read, so a sequential test passes even with the condition
      // stripped out of the UPDATE — mutation-verified, it did. Under a real
      // race both requests read `used_at IS NULL` and the WHERE is the only
      // thing left between one authorization and two token families.
      const code = await seedCode({ suffix: 'race' });
      const [row] = await getDb().select().from(mcpAuthCodes).where(eq(mcpAuthCodes.code, code));

      const outcomes = await Promise.all([claimAuthCode(row.id), claimAuthCode(row.id)]);

      expect(outcomes.filter(Boolean)).toHaveLength(1);
    });

    it('refuses to redeem the same code twice, and mints only one connection', async () => {
      const code = await seedCode({ suffix: 'reuse' });

      const first = await request(app).post('/mcp/oauth/token').send({
        grant_type: 'authorization_code',
        code,
        client_id: 'claude-web',
        redirect_uri: CLAUDE_REDIRECT,
        code_verifier: verifier,
      });
      expect(first.status).toBe(200);

      // Same code, same everything. The row is now stamped, so the conditional
      // claim matches nothing — this is the single-use guarantee, and its false
      // answer would hand out a second token family for one authorization.
      const second = await request(app).post('/mcp/oauth/token').send({
        grant_type: 'authorization_code',
        code,
        client_id: 'claude-web',
        redirect_uri: CLAUDE_REDIRECT,
        code_verifier: verifier,
      });
      expect(second.status).toBe(400);
      expect(second.body.error).toBe('invalid_grant');

      const connections = await getDb()
        .select()
        .from(mcpConnections)
        .where(eq(mcpConnections.oxyUserId, OXY_USER));
      expect(connections).toHaveLength(1);
    });

    it('rejects a code with a failing PKCE verifier', async () => {
      const code = await seedCode({ suffix: 'pkce' });
      const res = await request(app).post('/mcp/oauth/token').send({
        grant_type: 'authorization_code',
        code,
        client_id: 'claude-web',
        redirect_uri: CLAUDE_REDIRECT,
        code_verifier: 'the-wrong-verifier',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');

      const connections = await getDb()
        .select()
        .from(mcpConnections)
        .where(eq(mcpConnections.oxyUserId, OXY_USER));
      expect(connections).toEqual([]);
    });

    it('rejects an already-used code', async () => {
      const code = await seedCode({ suffix: 'used', usedAt: new Date() });
      const res = await request(app).post('/mcp/oauth/token').send({
        grant_type: 'authorization_code',
        code,
        client_id: 'claude-web',
        redirect_uri: CLAUDE_REDIRECT,
        code_verifier: verifier,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
    });

    it('rejects an expired code', async () => {
      const code = await seedCode({ suffix: 'stale', expiresAt: new Date(Date.now() - 60_000) });
      const res = await request(app).post('/mcp/oauth/token').send({
        grant_type: 'authorization_code',
        code,
        client_id: 'claude-web',
        redirect_uri: CLAUDE_REDIRECT,
        code_verifier: verifier,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
    });

    it('rejects a redirect_uri mismatch', async () => {
      await seedCode({ suffix: 'redirect' });
      const res = await request(app).post('/mcp/oauth/token').send({
        grant_type: 'authorization_code',
        code: `${SCOPE}-code-redirect`,
        client_id: 'claude-web',
        redirect_uri: 'https://evil.example/callback',
        code_verifier: verifier,
      });
      // redirect_uri is not in the client allowlist -> invalid_request before lookup
      expect(res.status).toBe(400);
    });

    it('rejects an unknown client', async () => {
      const res = await request(app).post('/mcp/oauth/token').send({
        grant_type: 'authorization_code',
        code: `${SCOPE}-code-default`,
        client_id: 'not-a-client',
        redirect_uri: CLAUDE_REDIRECT,
        code_verifier: verifier,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_client');
    });
  });

  describe('refresh_token grant', () => {
    /** A live connection holding `sha256(refreshToken)`. */
    async function seedConnection(
      refreshToken: string,
      overrides: { revokedAt?: Date; jti?: string } = {}
    ): Promise<void> {
      await getDb()
        .insert(mcpConnections)
        .values({
          oxyUserId: REFRESH_OXY_USER,
          clientId: 'claude-web',
          clientLabel: 'Claude',
          scopes: ['mcp:read'],
          bundleId: `${SCOPE}-bundle`,
          isBundlePrimary: true,
          refreshTokenHash: hashToken(refreshToken),
          jti: overrides.jti ?? 'old-jti',
          lastUsedAt: new Date(),
          revokedAt: overrides.revokedAt ?? null,
        });
    }

    it('rotates the refresh token and mints a fresh access token', async () => {
      await seedConnection('old-refresh');

      const res = await request(app).post('/mcp/oauth/token').send({
        grant_type: 'refresh_token',
        refresh_token: 'old-refresh',
        client_id: 'claude-web',
      });

      expect(res.status).toBe(200);
      expect(res.body.access_token).toBeTruthy();
      expect(res.body.refresh_token).toBeTruthy();
      expect(res.body.refresh_token).not.toBe('old-refresh');

      // The row moved onto the new family, and the old one is blocklisted.
      const [rotated] = await getDb()
        .select()
        .from(mcpConnections)
        .where(eq(mcpConnections.oxyUserId, REFRESH_OXY_USER));
      expect(mocks.revokeJti).toHaveBeenCalledWith('old-jti');
      expect(rotated.jti).not.toBe('old-jti');
      expect(rotated.refreshTokenHash).toBe(hashToken(res.body.refresh_token));

      const claims = verifyAccessToken(res.body.access_token);
      expect(claims.sub).toBe(REFRESH_OXY_USER);
      expect(claims.jti).toBe(rotated.jti);
    });

    it('refuses to rotate the same refresh token twice', async () => {
      await seedConnection('one-shot-refresh');

      const first = await request(app).post('/mcp/oauth/token').send({
        grant_type: 'refresh_token',
        refresh_token: 'one-shot-refresh',
        client_id: 'claude-web',
      });
      expect(first.status).toBe(200);

      // The presented hash is no longer current, so the conditional rotation
      // matches nothing. Without that condition both callers would mint a live
      // family from ONE refresh token and the second would silently win.
      const second = await request(app).post('/mcp/oauth/token').send({
        grant_type: 'refresh_token',
        refresh_token: 'one-shot-refresh',
        client_id: 'claude-web',
      });
      expect(second.status).toBe(400);
      expect(second.body.error).toBe('invalid_grant');

      const [row] = await getDb()
        .select()
        .from(mcpConnections)
        .where(eq(mcpConnections.oxyUserId, REFRESH_OXY_USER));
      expect(row.refreshTokenHash).toBe(hashToken(first.body.refresh_token));
    });

    it('rejects an invalid/unknown refresh token', async () => {
      const res = await request(app).post('/mcp/oauth/token').send({
        grant_type: 'refresh_token',
        refresh_token: 'nope',
        client_id: 'claude-web',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
    });

    it('rejects a revoked connection', async () => {
      await seedConnection('revoked-refresh', { revokedAt: new Date(), jti: 'revoked-jti' });
      const res = await request(app).post('/mcp/oauth/token').send({
        grant_type: 'refresh_token',
        refresh_token: 'revoked-refresh',
        client_id: 'claude-web',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
      expect(mocks.revokeJti).not.toHaveBeenCalled();
    });
  });
});
