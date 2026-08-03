import type { RequestHandler, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { OxyServices } from '@oxyhq/core';
import type { OxyAuthRequest } from '@oxyhq/core/server';
import { verifyAccessToken } from '../services/mcpTokenService';
import { isRevoked } from '../services/mcpRevocationService';
import { MCP_TOKEN_AUDIENCE } from '../config/constants';
import { resolveBundleContext } from '../services/mcpBundleService';
import type { McpBundleContext } from '../services/mcpBundleService';
import { logger } from '../../utils/logger';

export interface McpRequestContext {
  jti: string;
  scope: string;
  clientId: string;
  bundleId: string;
  primaryUserId: string;
  activeUserId: string;
}

export type OxyAuthRequestWithMcp = OxyAuthRequest & { mcp?: McpRequestContext };

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

/** Whether the request carries a bearer token whose `aud` is the MCP resource. */
export function bearerLooksLikeMcpToken(req: Request): boolean {
  const token = extractBearer(req);
  return token ? looksLikeMcpToken(token) : false;
}

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
  | {
      status: 'ok';
      userId: string;
      jti: string;
      scope: string;
      clientId: string;
      bundle: McpBundleContext;
    }
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

  // The Mongo connection row is the durable authorization grant and revocation
  // backstop. Never accept a self-contained JWT by `sub` alone: Redis can be
  // degraded and a revoked/missing connection must still fail closed.
  let bundle: McpBundleContext | null;
  try {
    bundle = await resolveBundleContext(claims.jti, claims.sub);
  } catch (error) {
    logger.warn('[McpAuth] Durable connection lookup failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return { status: 'invalid' };
  }
  if (!bundle) {
    return { status: 'revoked' };
  }

  return {
    status: 'ok',
    userId: claims.sub,
    jti: claims.jti,
    scope: claims.scope ?? '',
    clientId: claims.client_id ?? '',
    bundle,
  };
}

function parseScopeSet(scope: string): Set<string> {
  return new Set(scope.split(/\s+/).map((value) => value.trim()).filter(Boolean));
}

function requiredMcpScopeForRequest(req: Request): 'mcp:read' | 'mcp:write' {
  return ['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase()) ? 'mcp:read' : 'mcp:write';
}

function enforceMcpRequestScope(req: Request, res: Response, outcome: Extract<McpAuthOutcome, { status: 'ok' }>): boolean {
  const requiredScope = requiredMcpScopeForRequest(req);
  if (parseScopeSet(outcome.scope).has(requiredScope)) {
    return true;
  }

  res.status(403).json({
    error: 'insufficient_scope',
    message: `MCP token requires ${requiredScope} scope for this request`,
    required_scope: requiredScope,
  });
  return false;
}

/** Attach the resolved MCP identity to the request in the Oxy-compatible shape. */
function attachMcpIdentity(
  req: OxyAuthRequest,
  outcome: Extract<McpAuthOutcome, { status: 'ok' }>,
): void {
  const { bundle } = outcome;
  req.user = { id: bundle.activeUserId } as OxyAuthRequest['user'];
  req.userId = bundle.activeUserId;
  req.accessToken = undefined;
  (req as OxyAuthRequestWithMcp).mcp = {
    jti: bundle.jti,
    scope: outcome.scope,
    clientId: bundle.clientId,
    bundleId: bundle.bundleId,
    primaryUserId: bundle.primaryUserId,
    activeUserId: bundle.activeUserId,
  };
}

/**
 * Optional MCP auth: resolve `req.user` from a valid MCP token if present, else
 * pass through untouched. Never rejects the request.
 */
export function createOptionalMcpAuth(): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
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
        if (!enforceMcpRequestScope(req, res, outcome)) {
          return;
        }
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
