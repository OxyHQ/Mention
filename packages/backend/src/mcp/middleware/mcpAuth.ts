import {
  MENTION_CAPABILITY_AUDIENCE,
  MENTION_LEGACY_MCP_AUTH_CUTOFF_MS,
  MENTION_MCP_RESOURCE,
  mentionCapabilityRequirementsForRequest,
} from '@mention/shared-types/mcpCapabilities';
import type { OxyServices } from '@oxyhq/core';
import type { OxyAuthRequest } from '@oxyhq/core/server';
import { extractBearerToken, introspectOxyMcpAccessToken } from '@oxyhq/mcp';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { MCP_TOKEN_AUDIENCE } from '../config/constants';
import { resolveBundleContext, type McpBundleContext } from '../services/mcpBundleService';
import { isRevoked } from '../services/mcpRevocationService';
import { verifyAccessToken } from '../services/mcpTokenService';

export interface McpRequestContext {
  authMode: 'central' | 'legacy';
  jti: string;
  scope: string;
  clientId: string;
  bundleId?: string;
  primaryUserId: string;
  activeUserId: string;
}

export type OxyAuthRequestWithMcp = OxyAuthRequest & { mcp?: McpRequestContext };

type McpAuthOutcome =
  | { status: 'ok'; context: McpRequestContext }
  | { status: 'invalid' }
  | { status: 'revoked' };

/** Whether the request carries a bearer that claims either MCP token audience. */
export function bearerLooksLikeMcpToken(req: Request): boolean {
  const token = extractBearerToken(req.headers);
  return token ? tokenKind(token) !== null : false;
}

function tokenKind(token: string): 'central' | 'legacy' | null {
  try {
    const decoded = jwt.decode(token, { json: true });
    if (!decoded || typeof decoded !== 'object') return null;
    const audiences = Array.isArray(decoded.aud) ? decoded.aud : [decoded.aud];
    if (audiences.includes(MENTION_CAPABILITY_AUDIENCE)) return 'central';
    if (audiences.includes(MCP_TOKEN_AUDIENCE)) return 'legacy';
    return null;
  } catch {
    return null;
  }
}

function normalizeScope(value: string | string[]): string {
  const scopes = Array.isArray(value) ? value : value.split(/\s+/);
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))]
    .sort()
    .join(' ');
}

async function resolveCentralMcpUser(token: string): Promise<McpAuthOutcome> {
  try {
    const oxy = getServiceOxyClient();
    const oxyApiUrl = config.oxyApiUrl.replace(/\/+$/, '');
    const claims = await introspectOxyMcpAccessToken(token, {
      endpoint: `${oxyApiUrl}/auth/mcp/oauth/introspect`,
      getServiceToken: () => oxy.getServiceToken(),
      invalidateServiceToken: () => oxy.invalidateServiceToken(),
    });
    if (!claims) return { status: 'revoked' };
    if (
      claims.iss !== oxyApiUrl
      || claims.aud !== MENTION_CAPABILITY_AUDIENCE
      || claims.resource !== MENTION_MCP_RESOURCE
    ) {
      return { status: 'invalid' };
    }
    return {
      status: 'ok',
      context: {
        authMode: 'central',
        jti: claims.jti,
        scope: normalizeScope(claims.scope),
        clientId: claims.client_id,
        primaryUserId: claims.sub,
        activeUserId: claims.account_id,
      },
    };
  } catch (error) {
    logger.warn('[McpAuth] Central token introspection failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return { status: 'invalid' };
  }
}

async function resolveLegacyMcpUser(token: string): Promise<McpAuthOutcome> {
  if (Date.now() >= MENTION_LEGACY_MCP_AUTH_CUTOFF_MS) {
    return { status: 'revoked' };
  }

  let claims: ReturnType<typeof verifyAccessToken>;
  try {
    claims = verifyAccessToken(token);
  } catch (error) {
    logger.debug('[McpAuth] Legacy access token verification failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return { status: 'invalid' };
  }

  if (await isRevoked(claims.jti)) return { status: 'revoked' };

  let bundle: McpBundleContext | null;
  try {
    bundle = await resolveBundleContext(claims.jti, claims.sub);
  } catch (error) {
    logger.warn('[McpAuth] Durable legacy connection lookup failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return { status: 'invalid' };
  }
  if (!bundle) return { status: 'revoked' };

  return {
    status: 'ok',
    context: {
      authMode: 'legacy',
      jti: bundle.jti,
      scope: claims.scope ?? '',
      clientId: bundle.clientId,
      bundleId: bundle.bundleId,
      primaryUserId: bundle.primaryUserId,
      activeUserId: bundle.activeUserId,
    },
  };
}

async function resolveMcpUser(token: string): Promise<McpAuthOutcome> {
  return tokenKind(token) === 'central'
    ? resolveCentralMcpUser(token)
    : resolveLegacyMcpUser(token);
}

function scopeSet(scope: string): Set<string> {
  return new Set(scope.split(/\s+/).map((value) => value.trim()).filter(Boolean));
}

function requestHasMcpScope(req: Request, context: McpRequestContext): boolean {
  const scopes = scopeSet(context.scope);
  if (context.authMode === 'legacy') {
    const required = ['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())
      ? 'mcp:read'
      : 'mcp:write';
    return scopes.has(required);
  }
  return mentionCapabilityRequirementsForRequest(req.method, req.path).some(
    (requirement) =>
      requirement.requiredCapabilities.every((capability) => scopes.has(capability)),
  );
}

function enforceMcpRequestScope(
  req: Request,
  res: Response,
  context: McpRequestContext,
): boolean {
  if (requestHasMcpScope(req, context)) return true;

  if (context.authMode === 'legacy') {
    const required = ['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())
      ? 'mcp:read'
      : 'mcp:write';
    res.status(403).json({
      error: 'insufficient_scope',
      message: `MCP token requires ${required} scope for this request`,
      required_scope: required,
    });
    return false;
  }

  const requirements = mentionCapabilityRequirementsForRequest(req.method, req.path);
  const required = [...new Set(
    requirements.flatMap((requirement) => requirement.requiredCapabilities),
  )].sort();
  res.status(403).json({
    error: 'insufficient_scope',
    message: required.length > 0
      ? `MCP token lacks a capability required for ${req.method} ${req.path}`
      : 'This Mention endpoint is not exposed to external MCP tokens',
    required_scope: required,
  });
  return false;
}

function attachMcpIdentity(req: OxyAuthRequest, context: McpRequestContext): void {
  req.user = { id: context.activeUserId } as OxyAuthRequest['user'];
  req.userId = context.activeUserId;
  req.accessToken = undefined;
  (req as OxyAuthRequestWithMcp).mcp = context;
}

/**
 * Resolve optional MCP identity only when the exact public route is covered by
 * the token. An insufficient central token remains anonymous on public reads.
 */
export function createOptionalMcpAuth(): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = extractBearerToken(req.headers);
    if (!token || !tokenKind(token)) return next();
    const outcome = await resolveMcpUser(token);
    if (outcome.status === 'ok' && requestHasMcpScope(req, outcome.context)) {
      attachMcpIdentity(req as OxyAuthRequest, outcome.context);
    }
    next();
  };
}

/** Require either a capability-scoped MCP token or a normal Oxy session. */
export function createRequireMcpOrOxyAuth(oxy: OxyServices): RequestHandler {
  const oxyAuth = oxy.auth();

  return async (req: Request, res: Response, next: NextFunction) => {
    if ((req as OxyAuthRequest).user?.id) {
      const mcp = (req as OxyAuthRequestWithMcp).mcp;
      if (mcp && !enforceMcpRequestScope(req, res, mcp)) return;
      next();
      return;
    }

    const token = extractBearerToken(req.headers);
    if (token && tokenKind(token)) {
      const outcome = await resolveMcpUser(token);
      if (outcome.status === 'ok') {
        if (!enforceMcpRequestScope(req, res, outcome.context)) return;
        attachMcpIdentity(req as OxyAuthRequest, outcome.context);
        next();
        return;
      }
      res.status(401).json({
        error: 'invalid_token',
        message: outcome.status === 'revoked'
          ? 'MCP token has been revoked'
          : 'Invalid MCP token',
      });
      return;
    }

    oxyAuth(req, res, next);
  };
}
