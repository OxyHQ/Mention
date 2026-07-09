import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OxyServices } from '@oxyhq/core';

process.env.MENTION_MCP_JWT_SECRET = 'test-mcp-secret';

const mocks = vi.hoisted(() => ({
  authCodeFindOne: vi.fn(),
  authCodeFindOneAndUpdate: vi.fn(),
  authCodeCreate: vi.fn(),
  connectionCreate: vi.fn(),
  connectionFindOne: vi.fn(),
  registeredClientFindOne: vi.fn(),
  registeredClientCreate: vi.fn(),
  revokeJti: vi.fn(),
}));

vi.mock('../../mcp/models/McpAuthCode', () => ({
  McpAuthCode: {
    findOne: mocks.authCodeFindOne,
    findOneAndUpdate: mocks.authCodeFindOneAndUpdate,
    create: mocks.authCodeCreate,
  },
}));

vi.mock('../../mcp/models/McpConnection', () => ({
  McpConnection: {
    create: mocks.connectionCreate,
    findOne: mocks.connectionFindOne,
  },
}));

// Dynamic-client lookup (getMcpClientAsync) queries this for non-static ids.
vi.mock('../../mcp/models/McpRegisteredClient', () => ({
  McpRegisteredClient: {
    findOne: mocks.registeredClientFindOne,
    create: mocks.registeredClientCreate,
  },
}));

vi.mock('../../mcp/services/mcpRevocationService', () => ({
  revokeJti: mocks.revokeJti,
  isRevoked: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../mcp/services/mcpBundleService', () => ({
  setActiveAccount: vi.fn().mockResolvedValue(undefined),
}));

import { createMcpOAuthRoutes } from '../../mcp/routes/mcpOAuth.routes';
import { verifyAccessToken, hashToken } from '../../mcp/services/mcpTokenService';

const CLAUDE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

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

describe('POST /mcp/oauth/token', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.revokeJti.mockResolvedValue(undefined);
    // No dynamically-registered clients by default; static clients short-circuit
    // before this is consulted. `.lean()` mirrors the real mongoose query chain.
    mocks.registeredClientFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });
  });

  it('rejects an unsupported grant_type', async () => {
    const res = await request(app).post('/mcp/oauth/token').send({ grant_type: 'password' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_grant_type');
  });

  describe('authorization_code grant', () => {
    const verifier = 'a-very-long-random-code-verifier-value-1234567890';
    const challenge = pkce(verifier);

    function validCodeDoc(overrides: Record<string, unknown> = {}) {
      return {
        _id: 'code-doc-1',
        code: 'the-code',
        clientId: 'claude-web',
        oxyUserId: 'user-42',
        redirectUri: CLAUDE_REDIRECT,
        codeChallenge: challenge,
        scopes: ['mcp:read'],
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        ...overrides,
      };
    }

    it('exchanges a valid code (PKCE verified) for an access + refresh token', async () => {
      mocks.authCodeFindOne.mockResolvedValue(validCodeDoc());
      mocks.authCodeFindOneAndUpdate.mockResolvedValue(validCodeDoc({ usedAt: new Date() }));
      mocks.connectionCreate.mockResolvedValue({});

      const res = await request(app).post('/mcp/oauth/token').send({
        grant_type: 'authorization_code',
        code: 'the-code',
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
      expect(claims.sub).toBe('user-42');
      expect(claims.client_id).toBe('claude-web');

      // A connection was persisted with the HASH of the returned refresh token.
      expect(mocks.connectionCreate).toHaveBeenCalledTimes(1);
      const created = mocks.connectionCreate.mock.calls[0][0];
      expect(created.refreshTokenHash).toBe(hashToken(res.body.refresh_token));
      expect(created.oxyUserId).toBe('user-42');
      expect(created.bundleId).toBeTruthy();
      expect(created.isBundlePrimary).toBe(true);
    });

    it('rejects a code with a failing PKCE verifier', async () => {
      mocks.authCodeFindOne.mockResolvedValue(validCodeDoc());
      const res = await request(app).post('/mcp/oauth/token').send({
        grant_type: 'authorization_code',
        code: 'the-code',
        client_id: 'claude-web',
        redirect_uri: CLAUDE_REDIRECT,
        code_verifier: 'the-wrong-verifier',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
      expect(mocks.connectionCreate).not.toHaveBeenCalled();
    });

    it('rejects an already-used code', async () => {
      mocks.authCodeFindOne.mockResolvedValue(validCodeDoc({ usedAt: new Date() }));
      const res = await request(app).post('/mcp/oauth/token').send({
        grant_type: 'authorization_code',
        code: 'the-code',
        client_id: 'claude-web',
        redirect_uri: CLAUDE_REDIRECT,
        code_verifier: verifier,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
    });

    it('rejects a redirect_uri mismatch', async () => {
      mocks.authCodeFindOne.mockResolvedValue(validCodeDoc());
      const res = await request(app).post('/mcp/oauth/token').send({
        grant_type: 'authorization_code',
        code: 'the-code',
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
        code: 'the-code',
        client_id: 'not-a-client',
        redirect_uri: CLAUDE_REDIRECT,
        code_verifier: verifier,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_client');
    });
  });

  describe('refresh_token grant', () => {
    it('rotates the refresh token and mints a fresh access token', async () => {
      const save = vi.fn().mockResolvedValue(undefined);
      const connection = {
        oxyUserId: 'user-7',
        clientId: 'claude-web',
        scopes: ['mcp:read'],
        jti: 'old-jti',
        refreshTokenHash: hashToken('old-refresh'),
        revokedAt: null,
        save,
      };
      mocks.connectionFindOne.mockResolvedValue(connection);

      const res = await request(app).post('/mcp/oauth/token').send({
        grant_type: 'refresh_token',
        refresh_token: 'old-refresh',
        client_id: 'claude-web',
      });

      expect(res.status).toBe(200);
      expect(res.body.access_token).toBeTruthy();
      expect(res.body.refresh_token).toBeTruthy();
      expect(res.body.refresh_token).not.toBe('old-refresh');

      // Old family revoked, connection rotated + persisted.
      expect(mocks.revokeJti).toHaveBeenCalledWith('old-jti');
      expect(save).toHaveBeenCalledTimes(1);
      expect(connection.jti).not.toBe('old-jti');
      expect(connection.refreshTokenHash).toBe(hashToken(res.body.refresh_token));

      const claims = verifyAccessToken(res.body.access_token);
      expect(claims.sub).toBe('user-7');
      expect(claims.jti).toBe(connection.jti);
    });

    it('rejects an invalid/unknown refresh token', async () => {
      mocks.connectionFindOne.mockResolvedValue(null);
      const res = await request(app).post('/mcp/oauth/token').send({
        grant_type: 'refresh_token',
        refresh_token: 'nope',
        client_id: 'claude-web',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
    });

    it('rejects a revoked connection', async () => {
      mocks.connectionFindOne.mockResolvedValue({
        oxyUserId: 'user-7',
        clientId: 'claude-web',
        scopes: ['mcp:read'],
        jti: 'jti',
        refreshTokenHash: hashToken('r'),
        revokedAt: new Date(),
        save: vi.fn(),
      });
      const res = await request(app).post('/mcp/oauth/token').send({
        grant_type: 'refresh_token',
        refresh_token: 'r',
        client_id: 'claude-web',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
    });
  });
});
