import type { RequestHandler, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { OxyServices } from '@oxyhq/core';
import type { OxyAuthRequest } from '@oxyhq/core/server';
import { verifyAccessToken } from '../services/mcpTokenService';
import { isRevoked } from '../services/mcpRevocationService';
import { MCP_TOKEN_AUDIENCE } from '../config/constants';
import { logger } from '../../utils/logger';

/**
 * Dual-auth for MCP.
 *
 * The MCP OAuth flow mints first-party JWT access tokens (`aud: mention-mcp`)
 * that Mention itself validates, in ADDITION to the normal Oxy session tokens
 * that `oxy.auth()` validates against the Oxy API. These middlewares let a
 * request authenticate with EITHER credential:
 *
 *  - {@link createOptionalMcpAuth} — if the request carries a valid MCP token,
 *    resolve `req.user`/`req.userId` from it; otherwise pass through untouched
 *    (for a later Oxy pass or anonymous access).
 *  - {@link createRequireMcpOrOxyAuth} — resolve an MCP token if present and
 *    valid; otherwise delegate to `oxy.auth()` (which enforces a valid Oxy
 *    session). A bearer token that IS an MCP token but fails validation is
 *    rejected 401 rather than falling through to Oxy (which would reject it too,
 *    but with a misleading error).
 *
 * On success both set `req.user = { id: sub }` and `req.userId = sub`, matching
 * the shape `oxy.auth()` produces so downstream handlers (`req.user?.id`,
 * `getRequiredOxyUserId`) work identically regardless of credential type.
 */

/** Pull a bearer token from the Authorization header, or `undefined`. */
function extractBearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : undefined;
}

/**
 * Whether a bearer token is (claims to be) an MCP token — decoded WITHOUT
 * signature verification, purely to route it down the MCP validation path vs.
 * the Oxy path. Real validation happens in {@link resolveMcpUser}.
 */
function looksLikeMcpToken(token: string): boolean {
  try {
    const decoded = jwt.decode(token, { json: true });
    if (!decoded || typeof decoded !== 'object') return false;
    const aud = decoded.aud;
    return aud === MCP_TOKEN_AUDIENCE || (Array.isArray(aud) && aud.includes(MCP_TOKEN_AUDIENCE));
  } catch {
    return false;
  }
}

type McpAuthOutcome =
  | { status: 'ok'; userId: string; jti: string; scope: string; clientId: string }
  | { status: 'invalid' }
  | { status: 'revoked' };

/** Verify + revocation-check an MCP token. Never throws. */
async function resolveMcpUser(token: string): Promise<McpAuthOutcome> {
  let claims: ReturnType<typeof verifyAccessToken>;
  try {
    claims = verifyAccessToken(token);
  } catch (error) {
    logger.debug('[McpAuth] Access token verification failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return { status: 'invalid' };
  }

  if (await isRevoked(claims.jti)) {
    return { status: 'revoked' };
  }

  return {
    status: 'ok',
    userId: claims.sub,
    jti: claims.jti,
    scope: claims.scope ?? '',
    clientId: claims.client_id ?? '',
  };
}

/** Attach the resolved MCP identity to the request in the Oxy-compatible shape. */
function attachMcpIdentity(req: OxyAuthRequest, outcome: Extract<McpAuthOutcome, { status: 'ok' }>): void {
  req.user = { id: outcome.userId } as OxyAuthRequest['user'];
  req.userId = outcome.userId;
  req.accessToken = undefined;
  // Expose MCP-specific context for handlers that want to scope by grant.
  (req as OxyAuthRequest & { mcp?: { jti: string; scope: string; clientId: string } }).mcp = {
    jti: outcome.jti,
    scope: outcome.scope,
    clientId: outcome.clientId,
  };
}

/**
 * Optional MCP auth: resolve `req.user` from a valid MCP token if present, else
 * pass through untouched. Never rejects the request.
 */
export function createOptionalMcpAuth(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = extractBearer(req);
    if (!token || !looksLikeMcpToken(token)) {
      next();
      return;
    }
    const outcome = await resolveMcpUser(token);
    if (outcome.status === 'ok') {
      attachMcpIdentity(req as OxyAuthRequest, outcome);
    }
    next();
  };
}

/**
 * Require EITHER a valid MCP token OR a valid Oxy session. If the bearer token
 * is an MCP token it is validated here (and a bad one is rejected 401 without
 * falling through to Oxy). Otherwise the request is delegated to `oxy.auth()`.
 */
export function createRequireMcpOrOxyAuth(oxy: OxyServices): RequestHandler {
  const oxyAuth = oxy.auth();

  return async (req: Request, res: Response, next: NextFunction) => {
    // An earlier pass (e.g. the global rate limiter's optional auth) may have
    // already resolved an Oxy identity — honour it and skip re-verification.
    if ((req as OxyAuthRequest).user?.id) {
      next();
      return;
    }

    const token = extractBearer(req);
    if (token && looksLikeMcpToken(token)) {
      const outcome = await resolveMcpUser(token);
      if (outcome.status === 'ok') {
        attachMcpIdentity(req as OxyAuthRequest, outcome);
        next();
        return;
      }
      res.status(401).json({
        error: 'invalid_token',
        message: outcome.status === 'revoked' ? 'MCP token has been revoked' : 'Invalid MCP token',
      });
      return;
    }

    // Not an MCP token — enforce a normal Oxy session.
    oxyAuth(req, res, next);
  };
}
