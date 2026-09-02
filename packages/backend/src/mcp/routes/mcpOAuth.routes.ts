import { MENTION_LEGACY_MCP_AUTH_CUTOFF_MS } from '@mention/shared-types/mcpCapabilities';
import type { OxyServices } from '@oxyhq/core';
import type { Request, Response } from 'express';
import { Router } from 'express';
import {
  findConnectionByRefreshTokenHash,
  rotateRefreshTokenFamily,
} from '../../db/mcp/mcpConnectionRepository';
import { logger } from '../../utils/logger';
import { getMcpClientAsync } from '../config/mcpClients';
import { MCP_ACCESS_TOKEN_TTL_SECONDS } from '../config/constants';
import { revokeJti } from '../services/mcpRevocationService';
import {
  generateJti,
  generateRefreshToken,
  hashToken,
  signAccessToken,
} from '../services/mcpTokenService';

const CENTRAL_AUTHORIZATION_SERVER = 'https://api.oxy.so';

function singleString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function legacyRetired(res: Response): Response {
  return res.status(410).json({
    error: 'legacy_mcp_oauth_retired',
    error_description:
      'New Mention MCP authorizations use the central Oxy authorization server.',
    authorization_server: CENTRAL_AUTHORIZATION_SERVER,
  });
}

/**
 * Transitional endpoints for connectors created by Mention's former OAuth
 * authority. New registration, consent and account linking are closed. Only a
 * live pre-migration refresh family can rotate until the fixed cutoff.
 */
export function createMcpOAuthRoutes(
  _oxy: OxyServices,
  options: { now?: () => number } = {},
): Router {
  const router = Router();
  const now = options.now ?? Date.now;

  router.get('/.well-known/oauth-authorization-server', (_req, res) =>
    legacyRetired(res));
  router.get('/.well-known/oauth-protected-resource', (_req, res) =>
    legacyRetired(res));
  router.post('/mcp/oauth/register', (_req, res) => legacyRetired(res));
  router.get('/mcp/oauth/authorize', (_req, res) => legacyRetired(res));
  router.post('/mcp/oauth/approve', (_req, res) => legacyRetired(res));
  router.get('/mcp/bundles/link/preview', (_req, res) => legacyRetired(res));

  router.post('/mcp/oauth/token', async (req: Request, res: Response) => {
    try {
      if (now() >= MENTION_LEGACY_MCP_AUTH_CUTOFF_MS) {
        return legacyRetired(res);
      }
      if (singleString(req.body?.grant_type) !== 'refresh_token') {
        return res.status(400).json({
          error: 'unsupported_grant_type',
          error_description:
            'Mention no longer issues legacy authorization-code grants; reconnect through Oxy.',
        });
      }
      return await handleRefreshTokenGrant(req, res);
    } catch (error) {
      logger.error('[McpOAuth] legacy refresh failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return res.status(500).json({ error: 'server_error' });
    }
  });

  return router;
}

async function handleRefreshTokenGrant(req: Request, res: Response): Promise<Response> {
  const refreshToken = singleString(req.body?.refresh_token);
  const clientId = singleString(req.body?.client_id);

  if (!refreshToken || !clientId) {
    return res.status(400).json({
      error: 'invalid_request',
      message: 'Missing required parameters',
    });
  }
  if (!(await getMcpClientAsync(clientId))) {
    return res.status(400).json({ error: 'invalid_client' });
  }

  const presentedHash = hashToken(refreshToken);
  const connection = await findConnectionByRefreshTokenHash(presentedHash);
  if (!connection || connection.revokedAt || connection.clientId !== clientId) {
    return res.status(400).json({
      error: 'invalid_grant',
      message: 'Refresh token is invalid or revoked',
    });
  }

  const newJti = generateJti();
  const newRefresh = generateRefreshToken();
  const rotated = await rotateRefreshTokenFamily(connection.id, presentedHash, {
    jti: newJti,
    refreshTokenHash: newRefresh.hash,
  });
  if (!rotated) {
    return res.status(400).json({
      error: 'invalid_grant',
      message: 'Refresh token is invalid or revoked',
    });
  }
  await revokeJti(connection.jti);

  const accessToken = signAccessToken({
    oxyUserId: connection.oxyUserId,
    clientId,
    scopes: connection.scopes,
    jti: newJti,
  });

  return res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: MCP_ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: newRefresh.token,
    scope: connection.scopes.join(' '),
  });
}

export default createMcpOAuthRoutes;
