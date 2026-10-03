import type { Response } from 'express';
import { Router } from 'express';

const CENTRAL_AUTHORIZATION_SERVER = 'https://api.oxy.so';

function legacyRetired(res: Response): Response {
  return res.status(410).json({
    error: 'legacy_mcp_oauth_retired',
    error_description:
      'New Mention MCP authorizations use the central Oxy authorization server.',
    authorization_server: CENTRAL_AUTHORIZATION_SERVER,
  });
}

/**
 * The OAuth authority Mention used to run for MCP connectors, retired on
 * 2026-10-02 in favour of central Oxy authorization. A connector configured
 * against it still calls these paths, so each answers `410 Gone` naming the
 * authority to use instead, rather than a 404 that says nothing.
 */
export function createMcpOAuthRoutes(): Router {
  const router = Router();

  router.get('/.well-known/oauth-authorization-server', (_req, res) => legacyRetired(res));
  router.get('/.well-known/oauth-protected-resource', (_req, res) => legacyRetired(res));
  router.post('/mcp/oauth/register', (_req, res) => legacyRetired(res));
  router.get('/mcp/oauth/authorize', (_req, res) => legacyRetired(res));
  router.post('/mcp/oauth/approve', (_req, res) => legacyRetired(res));
  router.post('/mcp/oauth/token', (_req, res) => legacyRetired(res));

  return router;
}

export default createMcpOAuthRoutes;
