import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connectionFind: vi.fn(),
  getUsersByIds: vi.fn(),
}));

vi.mock('../../mcp/models/McpConnection', () => ({
  McpConnection: {
    find: mocks.connectionFind,
    findOneAndUpdate: vi.fn(),
  },
}));

vi.mock('../../mcp/services/mcpRevocationService', () => ({
  revokeJti: vi.fn(),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUsersByIds: mocks.getUsersByIds,
  }),
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import mcpConnectionsRoutes from '../../mcp/routes/mcpConnections.routes';

const connection = {
  _id: 'connection-1',
  oxyUserId: 'oxy-user-1',
  clientId: 'claude-web',
  clientLabel: 'Claude',
  scopes: ['mcp:read'],
  bundleId: 'bundle-1',
  isBundlePrimary: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  lastUsedAt: new Date('2026-01-02T00:00:00.000Z'),
};

function mockConnectionQueries() {
  mocks.connectionFind
    .mockReturnValueOnce({
      sort: () => ({
        lean: () => Promise.resolve([connection]),
      }),
    })
    .mockReturnValueOnce({
      lean: () => Promise.resolve([connection]),
    });
}

function makeApp() {
  const app = express();
  app.use((req, _res, next) => {
    (req as typeof req & { user: { id: string } }).user = { id: 'oxy-user-1' };
    next();
  });
  app.use('/mcp/connections', mcpConnectionsRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConnectionQueries();
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
