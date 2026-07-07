import crypto from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';

// Secret must be present before any sign/verify call (read lazily at call time).
process.env.MENTION_MCP_JWT_SECRET = 'test-mcp-secret';

import {
  signAccessToken,
  verifyAccessToken,
  hashToken,
  generateRefreshToken,
  generateJti,
  generateAuthCode,
  verifyPkceS256,
} from '../../mcp/services/mcpTokenService';
import { MCP_TOKEN_AUDIENCE } from '../../mcp/config/constants';

describe('mcpTokenService', () => {
  beforeAll(() => {
    process.env.MENTION_MCP_JWT_SECRET = 'test-mcp-secret';
  });

  describe('access tokens', () => {
    it('signs a token whose claims round-trip through verify', () => {
      const token = signAccessToken({
        oxyUserId: 'user-1',
        clientId: 'claude-web',
        scopes: ['mcp:read', 'mcp:write'],
        jti: 'jti-1',
      });
      const claims = verifyAccessToken(token);
      expect(claims.sub).toBe('user-1');
      expect(claims.jti).toBe('jti-1');
      expect(claims.client_id).toBe('claude-web');
      expect(claims.scope).toBe('mcp:read mcp:write');
      expect(claims.aud).toBe(MCP_TOKEN_AUDIENCE);
    });

    it('rejects a token signed with a different secret', () => {
      const forged = jwt.sign({ scope: 'mcp:read' }, 'wrong-secret', {
        algorithm: 'HS256',
        subject: 'user-1',
        audience: MCP_TOKEN_AUDIENCE,
        jwtid: 'jti-1',
      });
      expect(() => verifyAccessToken(forged)).toThrow();
    });

    it('rejects a token with the wrong audience', () => {
      const wrongAud = jwt.sign({ scope: 'mcp:read' }, 'test-mcp-secret', {
        algorithm: 'HS256',
        subject: 'user-1',
        audience: 'some-other-resource',
        jwtid: 'jti-1',
      });
      expect(() => verifyAccessToken(wrongAud)).toThrow();
    });

    it('rejects an expired token', () => {
      const expired = jwt.sign({ scope: 'mcp:read' }, 'test-mcp-secret', {
        algorithm: 'HS256',
        subject: 'user-1',
        audience: MCP_TOKEN_AUDIENCE,
        jwtid: 'jti-1',
        expiresIn: -10,
      });
      expect(() => verifyAccessToken(expired)).toThrow();
    });

    it('throws when the signing secret is unset', () => {
      const prev = process.env.MENTION_MCP_JWT_SECRET;
      delete process.env.MENTION_MCP_JWT_SECRET;
      try {
        expect(() =>
          signAccessToken({ oxyUserId: 'u', clientId: 'claude-web', scopes: [], jti: 'j' }),
        ).toThrow(/MENTION_MCP_JWT_SECRET/);
      } finally {
        process.env.MENTION_MCP_JWT_SECRET = prev;
      }
    });
  });

  describe('refresh tokens', () => {
    it('generates a token whose hash matches hashToken', () => {
      const { token, hash } = generateRefreshToken();
      expect(token).toBeTruthy();
      expect(hash).toBe(hashToken(token));
      // The stored form is a sha256 hex digest, never the raw token.
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).not.toBe(token);
    });

    it('produces unique tokens across calls', () => {
      const a = generateRefreshToken();
      const b = generateRefreshToken();
      expect(a.token).not.toBe(b.token);
      expect(a.hash).not.toBe(b.hash);
    });
  });

  describe('id generators', () => {
    it('generateJti returns a uuid-shaped id', () => {
      expect(generateJti()).toMatch(/^[0-9a-f-]{36}$/);
    });
    it('generateAuthCode returns a non-empty opaque string', () => {
      expect(generateAuthCode().length).toBeGreaterThan(20);
    });
  });

  describe('verifyPkceS256', () => {
    it('accepts a verifier whose S256 challenge matches', () => {
      const verifier = 'the-code-verifier-value';
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      expect(verifyPkceS256(verifier, challenge)).toBe(true);
    });

    it('rejects a mismatched verifier', () => {
      const challenge = crypto.createHash('sha256').update('right').digest('base64url');
      expect(verifyPkceS256('wrong', challenge)).toBe(false);
    });

    it('rejects empty inputs', () => {
      expect(verifyPkceS256('', 'x')).toBe(false);
      expect(verifyPkceS256('x', '')).toBe(false);
    });
  });
});
