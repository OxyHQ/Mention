import type { OxyServices } from '@oxy.so/core';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createMcpOAuthRoutes } from '../../mcp/routes/mcpOAuth.routes';
import { BEFORE_LEGACY_MCP_CUTOFF_MS } from './legacyMcpClock';

function buildApp(options: { now?: () => number } = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(createMcpOAuthRoutes({} as OxyServices, options));
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
    ['get', '/mcp/bundles/link/preview'],
  ] as const)('%s %s points clients to the central Oxy authority', async (method, path) => {
    const response = await request(app)[method](path);
    expect(response.status).toBe(410);
    expect(response.body).toEqual({
      error: 'legacy_mcp_oauth_retired',
      error_description:
        'New Mention MCP authorizations use the central Oxy authorization server.',
      authorization_server: 'https://api.oxy.so',
    });
  });

  it('retires the token endpoint once the legacy cutoff has passed', async () => {
    const response = await request(app).post('/mcp/oauth/token').send({ grant_type: 'refresh_token' });
    expect(response.status).toBe(410);
    expect(response.body.error).toBe('legacy_mcp_oauth_retired');
  });

  it('did not issue a new legacy authorization-code grant even before the cutoff', async () => {
    const beforeCutoff = buildApp({ now: () => BEFORE_LEGACY_MCP_CUTOFF_MS });
    const response = await request(beforeCutoff).post('/mcp/oauth/token').send({
      grant_type: 'authorization_code',
      code: 'old-code',
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('unsupported_grant_type');
  });
});
