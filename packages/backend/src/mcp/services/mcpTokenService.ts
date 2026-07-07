import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import {
  MCP_ACCESS_TOKEN_TTL_SECONDS,
  MCP_ISSUER,
  MCP_TOKEN_AUDIENCE,
} from '../config/constants';

/**
 * MCP token service — the single authority for minting and verifying the JWT
 * access tokens and opaque refresh tokens used by the MCP OAuth flow.
 *
 * Access tokens are stateless HS256 JWTs signed with `MENTION_MCP_JWT_SECRET`;
 * they carry `sub` (Oxy user id), `jti` (the connection's rotating token-family
 * id — used for revocation), `client_id`, and `scope`. Refresh tokens are
 * high-entropy random strings; only their SHA-256 hash is persisted on the
 * `McpConnection`, so a database read cannot recover a usable refresh token.
 */

/** Claims embedded in an MCP access token (beyond the standard registered ones). */
export interface McpAccessTokenClaims {
  sub: string;
  jti: string;
  client_id: string;
  scope: string;
  aud: string | string[];
  iss: string;
  iat: number;
  exp: number;
}

export interface SignAccessTokenParams {
  oxyUserId: string;
  clientId: string;
  scopes: string[];
  /** Token-family id — mirrored from the connection so revocation can target it. */
  jti: string;
}

export interface GeneratedRefreshToken {
  /** The opaque token handed to the client (never stored). */
  token: string;
  /** SHA-256 hex digest persisted on the connection. */
  hash: string;
}

/**
 * Resolve the signing secret at call time (not module load) so tests and
 * deployments that set the env after import still work. Throws when unset — an
 * MCP token must never be signed with an empty/absent secret.
 */
function getSecret(): string {
  const secret = process.env.MENTION_MCP_JWT_SECRET;
  if (!secret || secret.length === 0) {
    throw new Error('MENTION_MCP_JWT_SECRET is not configured');
  }
  return secret;
}

/** Sign a short-lived MCP access token for the given connection. */
export function signAccessToken(params: SignAccessTokenParams): string {
  const { oxyUserId, clientId, scopes, jti } = params;
  return jwt.sign(
    {
      client_id: clientId,
      scope: scopes.join(' '),
    },
    getSecret(),
    {
      algorithm: 'HS256',
      subject: oxyUserId,
      audience: MCP_TOKEN_AUDIENCE,
      issuer: MCP_ISSUER,
      jwtid: jti,
      expiresIn: MCP_ACCESS_TOKEN_TTL_SECONDS,
    },
  );
}

/**
 * Verify an MCP access token's signature, audience, and issuer. Returns the
 * decoded claims on success; throws (jsonwebtoken error) on any failure. Does
 * NOT check the revocation blocklist — that is the middleware's job so a
 * verified-but-revoked token is a distinct, testable step.
 */
export function verifyAccessToken(token: string): McpAccessTokenClaims {
  const decoded = jwt.verify(token, getSecret(), {
    algorithms: ['HS256'],
    audience: MCP_TOKEN_AUDIENCE,
    issuer: MCP_ISSUER,
  });
  // `verify` returns `string | JwtPayload`; a signed object payload is always
  // an object here, but narrow explicitly rather than asserting.
  if (typeof decoded === 'string' || !decoded.sub || !decoded.jti) {
    throw new jwt.JsonWebTokenError('Malformed MCP access token payload');
  }
  return decoded as unknown as McpAccessTokenClaims;
}

/** SHA-256 hex digest of a token — the form persisted for refresh tokens. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Generate a new opaque refresh token and its storable hash. */
export function generateRefreshToken(): GeneratedRefreshToken {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

/** Generate a new token-family id (used for `jti` + revocation). */
export function generateJti(): string {
  return crypto.randomUUID();
}

/** Generate a single-use OAuth authorization code. */
export function generateAuthCode(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Verify a PKCE S256 challenge: `base64url(sha256(verifier)) === challenge`.
 * Constant-time comparison on the derived digests.
 */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (!codeVerifier || !codeChallenge) return false;
  const derived = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const a = Buffer.from(derived);
  const b = Buffer.from(codeChallenge);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
