import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import type { OxyServices } from '@oxyhq/core';

process.env.MENTION_MCP_JWT_SECRET = 'test-mcp-secret-that-is-at-least-32-bytes';
process.env.MENTION_PUBLIC_API_URL = 'https://api.mention.earth';
process.env.MENTION_MCP_PUBLIC_URL = 'https://mcp.mention.earth';

/**
 * RFC 7591 dynamic client registration, against real `mcp_registered_clients`
 * rows.
 *
 * The registration and the authorize check are two halves of ONE guarantee — a
 * client Claude registered must be the client whose `redirect_uri` allowlist
 * authorize then enforces — and a mocked model could satisfy each half
 * separately without them ever meeting. Here the row written by `POST /register`
 * is the row `GET /authorize` reads back.
 */

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { mcpRegisteredClients } from '../../db/schema/mcp';
import { createRegisteredClient } from '../../db/mcp/mcpRegisteredClientRepository';
import { createMcpOAuthRoutes } from '../../mcp/routes/mcpOAuth.routes';
import { MCP_RESOURCE_URL, MCP_TOKEN_AUDIENCE, MCP_ISSUER } from '../../mcp/config/constants';

/** Per-file namespace — vitest runs files in parallel against one database. */
const SCOPE = 'mcpreg';

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

/**
 * `POST /register` mints its own `mcp-dcr-<uuid>` id, so a row it wrote cannot
 * be namespaced ahead of time. Collect what the endpoint returned and delete
 * exactly those, plus this file's seeded ids — never every DCR row, which would
 * take another parallel file's with it.
 */
const writtenClientIds: string[] = [];

beforeAll(async () => {
  await connectPostgres();
}, 60_000);

afterAll(async () => {
  const db = getDb();
  for (const clientId of writtenClientIds) {
    await db.delete(mcpRegisteredClients).where(eq(mcpRegisteredClients.clientId, clientId));
  }
  await db.delete(mcpRegisteredClients).where(like(mcpRegisteredClients.clientId, `${SCOPE}-%`));
  await closePostgres();
});

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

  /** How many DCR rows exist right now, so a refusal can be shown to write none. */
  async function dcrRowCount(): Promise<number> {
    const rows = await getDb()
      .select({ clientId: mcpRegisteredClients.clientId })
      .from(mcpRegisteredClients)
      .where(like(mcpRegisteredClients.clientId, 'mcp-dcr-%'));
    return rows.length;
  }

  it('registers a public client with HTTPS redirect_uris and returns a client_id', async () => {
    const redirectUris = ['https://claude.ai/api/mcp/auth_callback'];
    const res = await request(app)
      .post('/mcp/oauth/register')
      .send({ redirect_uris: redirectUris, client_name: 'Claude' });

    expect(res.status).toBe(201);
    expect(res.body.client_id).toBeTruthy();
    expect(res.body.client_id).toMatch(/^mcp-dcr-/);
    writtenClientIds.push(res.body.client_id);
    expect(res.body.token_endpoint_auth_method).toBe('none');
    expect(res.body.redirect_uris).toEqual(redirectUris);
    expect(res.body.client_name).toBe('Claude');

    const [stored] = await getDb()
      .select()
      .from(mcpRegisteredClients)
      .where(eq(mcpRegisteredClients.clientId, res.body.client_id));
    expect(stored.redirectUris).toEqual(redirectUris);
    expect(stored.label).toBe('Claude');
  });

  it('rejects a registration with no redirect_uris', async () => {
    const before = await dcrRowCount();
    const res = await request(app).post('/mcp/oauth/register').send({ client_name: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_redirect_uri');
    expect(await dcrRowCount()).toBe(before);
  });

  it('rejects a registration with a non-HTTPS redirect_uri', async () => {
    const before = await dcrRowCount();
    const res = await request(app)
      .post('/mcp/oauth/register')
      .send({ redirect_uris: ['http://insecure.example/cb'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_redirect_uri');
    expect(await dcrRowCount()).toBe(before);
  });
});

describe('authorize honours a dynamically-registered client', () => {
  const app = buildApp();
  const clientId = `${SCOPE}-dcr-abc`;
  const dynamicRedirect = 'https://claude.ai/api/mcp/auth_callback';

  beforeEach(async () => {
    await getDb().delete(mcpRegisteredClients).where(eq(mcpRegisteredClients.clientId, clientId));
    await createRegisteredClient({
      clientId,
      label: 'Claude',
      redirectUris: [dynamicRedirect],
    });
  });

  it('redirects to consent when the client + redirect_uri come from the registry', async () => {
    const res = await request(app).get('/mcp/oauth/authorize').query({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: dynamicRedirect,
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      scope: 'mcp:read',
      state: 'xyz',
    });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/oauth/mcp/authorize');
    expect(res.headers.location).toContain(`client_id=${clientId}`);
  });

  it('refuses a redirect_uri the registered client did not declare', async () => {
    // The other half of the same guarantee: registration is what makes a
    // callback allowed, so a client that exists must NOT make an unlisted
    // callback allowed too.
    const res = await request(app).get('/mcp/oauth/authorize').query({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://evil.example/callback',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      scope: 'mcp:read',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });
});
