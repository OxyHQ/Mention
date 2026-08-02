import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

/**
 * The connection-management API, against REAL `mcp_connections` rows.
 *
 * Two properties are checked here and neither survives a mocked model:
 *
 *  - **A degraded identity never becomes a handle.** Oxy is still mocked — it is
 *    the thing being made to fail — but the ROWS are real, so the assertion
 *    observes the DTO built from a connection that exists rather than one a stub
 *    described.
 *  - **Revocation is ownership-scoped and irreversible.** `revoked_at IS NULL`
 *    is a permission gate: its false answer decides whether a revoked
 *    connection keeps authenticating. That can only be observed by revoking a
 *    real row and asking the list endpoint again.
 */

const mocks = vi.hoisted(() => ({
  getUsersByIds: vi.fn(),
  revokeJti: vi.fn(),
}));

vi.mock('../../mcp/services/mcpRevocationService', () => ({
  revokeJti: mocks.revokeJti,
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUsersByIds: mocks.getUsersByIds,
  }),
}));

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { mcpConnections } from '../../db/schema/mcp';
import { createConnection } from '../../db/mcp/mcpConnectionRepository';
import mcpConnectionsRoutes from '../../mcp/routes/mcpConnections.routes';

/** Per-file namespace — vitest runs files in parallel against one database. */
const SCOPE = 'mcpconn';
const OWNER = `${SCOPE}-oxy-user-1`;
const BUNDLE = `${SCOPE}-bundle-1`;

/** Every row this file writes, so cleanup never says "delete all connections". */
const OWNED_USER_IDS = [OWNER];

let connectionId = '';

function makeApp() {
  const app = express();
  app.use((req, _res, next) => {
    (req as typeof req & { user: { id: string } }).user = { id: OWNER };
    next();
  });
  app.use('/mcp/connections', mcpConnectionsRoutes);
  return app;
}

beforeAll(async () => {
  await connectPostgres();
}, 60_000);

afterAll(async () => {
  await getDb().delete(mcpConnections).where(inArray(mcpConnections.oxyUserId, OWNED_USER_IDS));
  await closePostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.revokeJti.mockResolvedValue(undefined);

  await getDb().delete(mcpConnections).where(inArray(mcpConnections.oxyUserId, OWNED_USER_IDS));
  const row = await createConnection({
    oxyUserId: OWNER,
    clientId: 'claude-web',
    clientLabel: 'Claude',
    scopes: ['mcp:read'],
    bundleId: BUNDLE,
    isBundlePrimary: true,
    activeOxyUserId: OWNER,
    refreshTokenHash: `${SCOPE}-refresh-hash`,
    jti: `${SCOPE}-jti`,
    lastUsedAt: new Date('2026-01-02T00:00:00.000Z'),
  });
  connectionId = row.id;
});

describe('MCP connections degraded identity', () => {
  it('does not expose raw Oxy ids as handles when the bulk lookup misses', async () => {
    mocks.getUsersByIds.mockResolvedValue([]);

    const response = await request(makeApp()).get('/mcp/connections').expect(200);
    const [result] = response.body.connections;

    expect(result.handle).toBe('');
    expect(result.displayName).toBe('Unknown user');
    expect(result.bundleHandles).toEqual([]);
  });

  it('does not expose raw Oxy ids as handles when Oxy is unavailable', async () => {
    mocks.getUsersByIds.mockRejectedValue(new Error('oxy unavailable'));

    const response = await request(makeApp()).get('/mcp/connections').expect(200);
    const [result] = response.body.connections;

    expect(result.handle).toBe('');
    expect(result.displayName).toBe('Unknown user');
    expect(result.bundleHandles).toEqual([]);
  });
});

describe('MCP connections listing', () => {
  it('never ships the credential columns, whatever the identity lookup returns', async () => {
    mocks.getUsersByIds.mockResolvedValue([
      { id: OWNER, username: 'alice', name: { displayName: 'Alice' } },
    ]);

    const response = await request(makeApp()).get('/mcp/connections').expect(200);
    const [result] = response.body.connections;

    expect(result.id).toBe(connectionId);
    expect(result.handle).toBe('alice');
    // The refresh-token hash and the token-family id are what a stolen response
    // would need; neither is selected by the repository, so neither can appear.
    expect(JSON.stringify(response.body)).not.toContain(`${SCOPE}-refresh-hash`);
    expect(JSON.stringify(response.body)).not.toContain(`${SCOPE}-jti`);
  });
});

describe('DELETE /mcp/connections/:id', () => {
  beforeEach(() => {
    mocks.getUsersByIds.mockResolvedValue([]);
  });

  it('revokes the caller\'s own connection and drops it from the list', async () => {
    const app = makeApp();

    await request(app).delete(`/mcp/connections/${connectionId}`).expect(200);

    // The row is still there — revocation is history, not deletion — but the
    // live-connection predicate no longer matches it.
    const [row] = await getDb()
      .select()
      .from(mcpConnections)
      .where(eq(mcpConnections.id, connectionId));
    expect(row.revokedAt).not.toBeNull();

    const listed = await request(app).get('/mcp/connections').expect(200);
    expect(listed.body.connections).toEqual([]);
    expect(mocks.revokeJti).toHaveBeenCalledWith(`${SCOPE}-jti`);
  });

  it('refuses to revoke a connection belonging to another user', async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as typeof req & { user: { id: string } }).user = { id: `${SCOPE}-someone-else` };
      next();
    });
    app.use('/mcp/connections', mcpConnectionsRoutes);

    await request(app).delete(`/mcp/connections/${connectionId}`).expect(404);

    const [row] = await getDb()
      .select()
      .from(mcpConnections)
      .where(eq(mcpConnections.id, connectionId));
    expect(row.revokedAt).toBeNull();
    expect(mocks.revokeJti).not.toHaveBeenCalled();
  });

  it('answers 404 a second time rather than re-revoking', async () => {
    const app = makeApp();
    await request(app).delete(`/mcp/connections/${connectionId}`).expect(200);
    await request(app).delete(`/mcp/connections/${connectionId}`).expect(404);
    expect(mocks.revokeJti).toHaveBeenCalledTimes(1);
  });
});
