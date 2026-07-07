import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OxyServices } from '@oxyhq/core';

process.env.MENTION_MCP_JWT_SECRET = 'test-mcp-secret';
process.env.MENTION_PUBLIC_API_URL = 'https://api.mention.earth';
process.env.MENTION_MCP_PUBLIC_URL = 'https://mcp.mention.earth';

const mocks = vi.hoisted(() => ({
  registeredClientFindOne: vi.fn(),
  registeredClientCreate: vi.fn(),
}));

vi.mock('../../mcp/models/McpAuthCode', () => ({
  McpAuthCode: { findOne: vi.fn(), findOneAndUpdate: vi.fn(), create: vi.fn() },
}));

vi.mock('../../mcp/models/McpConnection', () => ({
  McpConnection: { create: vi.fn(), findOne: vi.fn() },
}));

vi.mock('../../mcp/models/McpRegisteredClient', () => ({
  McpRegisteredClient: {
    findOne: mocks.registeredClientFindOne,
    create: mocks.registeredClientCreate,
  },
}));

import { createMcpOAuthRoutes } from '../../mcp/routes/mcpOAuth.routes';
import { MCP_RESOURCE_URL, MCP_TOKEN_AUDIENCE, MCP_ISSUER } from '../../mcp/config/constants';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  const fakeOxy = {
    auth: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  } as unknown as OxyServices;
  app.use(createMcpOAuthRoutes(fakeOxy));
  return app;
}

describe('MCP OAuth discovery', () => {
  const app = buildApp();

  it('protected-resource metadata `resource` has no trailing slash and equals the audience', async () => {
    const res = await request(app).get('/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    expect(res.body.resource).toBe(MCP_RESOURCE_URL);
    expect(res.body.resource).toBe('https://mcp.mention.earth');
    expect(res.body.resource.endsWith('/')).toBe(false);
    // The advertised resource is the JWT audience — they must line up.
    expect(res.body.resource).toBe(MCP_TOKEN_AUDIENCE);
    expect(res.body.authorization_servers).toContain(MCP_ISSUER);
  });

  it('authorization-server metadata advertises a registration_endpoint', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.body.registration_endpoint).toBe(`${MCP_ISSUER}/mcp/oauth/register`);
    expect(res.body.token_endpoint_auth_methods_supported).toContain('none');
  });
});

describe('POST /mcp/oauth/register (RFC 7591 DCR)', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.registeredClientCreate.mockResolvedValue({});
  });

  it('registers a public client with HTTPS redirect_uris and returns a client_id', async () => {
    const redirectUris = ['https://claude.ai/api/mcp/auth_callback'];
    const res = await request(app)
      .post('/mcp/oauth/register')
      .send({ redirect_uris: redirectUris, client_name: 'Claude' });

    expect(res.status).toBe(201);
    expect(res.body.client_id).toBeTruthy();
    expect(res.body.client_id).toMatch(/^mcp-dcr-/);
    expect(res.body.token_endpoint_auth_method).toBe('none');
    expect(res.body.redirect_uris).toEqual(redirectUris);
    expect(res.body.client_name).toBe('Claude');

    expect(mocks.registeredClientCreate).toHaveBeenCalledTimes(1);
    const created = mocks.registeredClientCreate.mock.calls[0][0];
    expect(created.clientId).toBe(res.body.client_id);
    expect(created.redirectUris).toEqual(redirectUris);
  });

  it('rejects a registration with no redirect_uris', async () => {
    const res = await request(app).post('/mcp/oauth/register').send({ client_name: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_redirect_uri');
    expect(mocks.registeredClientCreate).not.toHaveBeenCalled();
  });

  it('rejects a registration with a non-HTTPS redirect_uri', async () => {
    const res = await request(app)
      .post('/mcp/oauth/register')
      .send({ redirect_uris: ['http://insecure.example/cb'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_redirect_uri');
    expect(mocks.registeredClientCreate).not.toHaveBeenCalled();
  });
});

describe('authorize honours a dynamically-registered client', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redirects to consent when the client + redirect_uri come from Mongo', async () => {
    const dynamicRedirect = 'https://claude.ai/api/mcp/auth_callback';
    mocks.registeredClientFindOne.mockReturnValue({
      lean: () => Promise.resolve({
        clientId: 'mcp-dcr-abc',
        label: 'Claude',
        redirectUris: [dynamicRedirect],
      }),
    });

    const res = await request(app).get('/mcp/oauth/authorize').query({
      response_type: 'code',
      client_id: 'mcp-dcr-abc',
      redirect_uri: dynamicRedirect,
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      scope: 'mcp:read',
      state: 'xyz',
    });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/oauth/mcp/authorize');
    expect(res.headers.location).toContain('client_id=mcp-dcr-abc');
  });
});
