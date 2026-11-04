import { createOxySessionAuth } from '../../middleware/oxySessionAuth';
import { mentionCapabilityRequirementsForRequest } from '@mention/shared-types/mcpCapabilities';
import type { OxyAuthRequest, OxyServer } from '@oxy.so/core/server';
import { extractBearerToken, introspectOxyMcpAccessToken } from '@oxy.so/mcp';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import {
  connectionStateFromClaims,
  type McpConnectionState,
} from '../services/mcpConnectionDirectory';

export interface McpRequestContext {
  jti: string;
  scope: string;
  clientId: string;
  primaryUserId: string;
  activeUserId: string;
  /**
   * The account set Oxy says this connection may act as, when it covers more
   * than the account its token was minted for. Central connections only —
   * membership is Oxy's, and it is re-read on every request.
   */
  connection?: McpConnectionState;
}

export type OxyAuthRequestWithMcp = OxyAuthRequest & { mcp?: McpRequestContext };

/**
 * `unavailable` is Oxy's introspection not answering (a network error, a 5xx, a
 * malformed body): the token's state is UNKNOWN, which is neither a valid grant
 * nor an invalid one. It is answered 503, never 401 — an OAuth client drops a
 * grant it is told is `invalid_token`, so a blip at Oxy would disconnect every
 * MCP client that called during it.
 */
type McpAuthOutcome =
  | { status: 'ok'; context: McpRequestContext }
  | { status: 'invalid' }
  | { status: 'revoked' }
  | { status: 'retired' }
  | { status: 'unavailable' };

/** The answer to an MCP token whose state Oxy could not report: try again. */
function sendMcpAuthUnavailable(res: Response): void {
  res.setHeader('Retry-After', '5');
  res.status(503).json({
    error: 'temporarily_unavailable',
    message: 'Could not verify the MCP token right now. Try again shortly.',
  });
}

/**
 * The claims of a JWT, DECODED and not verified: they only select which
 * verifier a bearer goes to, and authorize nothing (the live introspection
 * below verifies the exact binding). `null` for anything that is not a JWT.
 */
function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const encodedClaims = token.split('.')[1];
  if (!encodedClaims) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Classify the MCP family before auth routing, including foreign-tenant tokens. */
export function bearerLooksLikeMcpToken(req: Request): boolean {
  const token = extractBearerToken(req.headers);
  return token ? tokenKind(token) !== null : false;
}

/**
 * Which MCP token family a bearer belongs to. `legacy` is a Mention-issued
 * HS256 token, retired on 2026-10-02: it is still RECOGNISED, so its holder is
 * told to reconnect instead of having it tried as an ordinary Oxy session.
 */
function tokenKind(token: string): 'central' | 'legacy' | null {
  const decoded = decodeJwtClaims(token);
  if (!decoded) return null;
  const audiences = Array.isArray(decoded.aud) ? decoded.aud : [decoded.aud];
  // A foreign tenant's MCP token must be rejected here, never retried as an
  // ordinary Oxy session. Decoded claims only select the verifier; they do not
  // authorize anything (the live introspection below verifies exact binding).
  if (
    audiences.includes(config.deploymentMcp.audience) ||
    audiences.some(
      (audience) =>
        typeof audience === 'string' && /^mention(?:-[a-f0-9-]{36})?-api$/.test(audience),
    ) ||
    (typeof decoded.resource === 'string' && typeof decoded.account_id === 'string')
  )
    return 'central';
  // Mention-issued tokens were minted for the MCP resource itself.
  if (audiences.includes(config.mcp.resourceUrl)) return 'legacy';
  return null;
}

function normalizeScope(value: string | string[]): string {
  const scopes = Array.isArray(value) ? value : value.split(/\s+/);
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort().join(' ');
}

async function resolveCentralMcpUser(token: string): Promise<McpAuthOutcome> {
  const oxyApiUrl = config.oxyApiUrl.replace(/\/+$/, '');
  let claims: Awaited<ReturnType<typeof introspectOxyMcpAccessToken>>;
  try {
    const transport = getServiceOxyClient().createServiceClient({
      baseURL: oxyApiUrl,
      audience: 'oxy-api',
    });
    claims = await introspectOxyMcpAccessToken(token, {
      endpoint: `${oxyApiUrl}/auth/mcp/oauth/introspect`,
      transport,
    }).finally(() => transport.dispose());
  } catch (error) {
    // Introspection answers an inactive token with `{ active: false }` (null
    // here). A THROW is Oxy not answering at all, so the token's state is
    // unknown: never cached, and never reported to the client as invalid.
    logger.warn('[McpAuth] Central token introspection unavailable', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return { status: 'unavailable' };
  }
  if (!claims) return { status: 'revoked' };
  if (
    claims.iss !== oxyApiUrl ||
    claims.aud !== config.deploymentMcp.audience ||
    claims.resource !== config.mcp.resourceUrl
  ) {
    return { status: 'invalid' };
  }
  // Which account to SERVE is the connection's selected member, not the
  // token's own: one connector can hold several accounts, each of which
  // approved its own participation on auth.oxy.so. The token stays bound to
  // the account it was minted for and is never re-issued for the switch.
  const connection = connectionStateFromClaims(claims, claims.account_id);
  return {
    status: 'ok',
    context: {
      jti: claims.jti,
      scope: normalizeScope(claims.scope),
      clientId: claims.client_id,
      primaryUserId: claims.sub,
      activeUserId: connection?.activeAccountId ?? claims.account_id,
      ...(connection ? { connection } : {}),
    },
  };
}

async function resolveMcpUser(token: string): Promise<McpAuthOutcome> {
  return tokenKind(token) === 'central' ? resolveCentralMcpUser(token) : { status: 'retired' };
}

function scopeSet(scope: string): Set<string> {
  return new Set(
    scope
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function requestHasMcpScope(req: Request, context: McpRequestContext): boolean {
  const scopes = scopeSet(context.scope);
  return mentionCapabilityRequirementsForRequest(req.method, req.path).some((requirement) =>
    requirement.requiredCapabilities.every((capability) => scopes.has(capability)),
  );
}

function enforceMcpRequestScope(req: Request, res: Response, context: McpRequestContext): boolean {
  if (requestHasMcpScope(req, context)) return true;

  const requirements = mentionCapabilityRequirementsForRequest(req.method, req.path);
  const required = [
    ...new Set(requirements.flatMap((requirement) => requirement.requiredCapabilities)),
  ].sort();
  res.status(403).json({
    error: 'insufficient_scope',
    message:
      required.length > 0
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
 *
 * An introspection OUTAGE does not: the caller presented a credential, and what
 * it may see (its own private reads, its blocks applied) depends on who it is,
 * so serving it anonymously would answer a different question. It is 503, as on
 * the required mount.
 */
export function createOptionalMcpAuth(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = extractBearerToken(req.headers);
    if (!token || !tokenKind(token)) return next();
    const outcome = await resolveMcpUser(token);
    if (outcome.status === 'unavailable') return sendMcpAuthUnavailable(res);
    if (outcome.status === 'ok' && requestHasMcpScope(req, outcome.context)) {
      attachMcpIdentity(req as OxyAuthRequest, outcome.context);
    }
    next();
  };
}

/** Require either a capability-scoped MCP token or a normal Oxy session. */
export function createRequireMcpOrOxyAuth(oxy: OxyServer): RequestHandler {
  const sessionAuth = createOxySessionAuth(oxy);
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
      if (outcome.status === 'unavailable') return sendMcpAuthUnavailable(res);
      res.status(401).json({
        error: 'invalid_token',
        message:
          outcome.status === 'retired'
            ? 'Mention-issued MCP tokens were retired on 2026-10-02. Reconnect through Oxy.'
            : outcome.status === 'revoked'
              ? 'MCP token has been revoked'
              : 'Invalid MCP token',
      });
      return;
    }

    sessionAuth(req, res, next);
  };
}
