import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createMcpOAuthRoutes } from '../../mcp/routes/mcpOAuth.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(createMcpOAuthRoutes());
  return app;
}

describe('retired Mention OAuth authorization surface', () => {
  const app = buildApp();

  it.each([
    ['get', '/.well-known/oauth-authorization-server'],
    ['get', '/.well-known/oauth-protected-resource'],
    ['post', '/mcp/oauth/register'],
    ['get', '/mcp/oauth/authorize'],
    ['post', '/mcp/oauth/approve'],
    // Refreshing a Mention-issued token was the last thing this authority did.
    ['post', '/mcp/oauth/token'],
  ] as const)('%s %s points clients to the central Oxy authority', async (method, path) => {
    const response = await request(app)[method](path).send({ grant_type: 'refresh_token' });
    expect(response.status).toBe(410);
    expect(response.body).toEqual({
      error: 'legacy_mcp_oauth_retired',
      error_description:
        'New Mention MCP authorizations use the central Oxy authorization server.',
      authorization_server: 'https://api.oxy.so',
    });
  });
});
