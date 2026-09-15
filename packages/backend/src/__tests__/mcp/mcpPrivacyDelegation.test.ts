import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.MENTION_MCP_JWT_SECRET = 'test-mcp-privacy-secret-that-is-at-least-32-bytes';
process.env.MENTION_MCP_PUBLIC_URL = 'https://mcp.mention.earth';

const mocks = vi.hoisted(() => ({
  makeServiceRequest: vi.fn(),
  setTokens: vi.fn(),
  configureServiceAuth: vi.fn(),
  getUserFollowing: vi.fn(),
  getUserFollowers: vi.fn(),
}));

vi.mock('@oxy.so/core', () => ({
  OxyServices: class {
    setTokens(...args: unknown[]) {
      return mocks.setTokens(...args);
    }

    configureServiceAuth(...args: unknown[]) {
      return mocks.configureServiceAuth(...args);
    }

    makeServiceRequest(...args: unknown[]) {
      return mocks.makeServiceRequest(...args);
    }

    getUserFollowing(...args: unknown[]) {
      return mocks.getUserFollowing(...args);
    }

    getUserFollowers(...args: unknown[]) {
      return mocks.getUserFollowers(...args);
    }
  },
}));

vi.mock('../../mcp/services/mcpRevocationService', () => ({
  isRevoked: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../mcp/services/mcpBundleService', () => ({
  resolveBundleContext: vi.fn().mockResolvedValue({
    bundleId: 'bundle-privacy',
    primaryUserId: 'primary-user',
    activeUserId: 'active-user',
    clientId: 'claude-web',
    jti: 'jti-privacy',
  }),
}));

import {
  createOptionalMcpAuth,
  type OxyAuthRequestWithMcp,
} from '../../mcp/middleware/mcpAuth';
import { signAccessToken } from '../../mcp/services/mcpTokenService';
import { createScopedOxyClient } from '../../utils/oxyHelpers';
import {
  getBlockedUserIds,
  getRestrictedUserIds,
} from '../../utils/privacyHelpers';

const token = signAccessToken({
  oxyUserId: 'primary-user',
  clientId: 'claude-web',
  scopes: ['mcp:read'],
  jti: 'jti-privacy',
});

function buildApp() {
  const app = express();
  app.use(createOptionalMcpAuth());
  app.get('/feed/mtn', async (req, res, next) => {
    try {
      const mcpRequest = req as OxyAuthRequestWithMcp;
      const client = createScopedOxyClient(mcpRequest);
      const [blockedIds, restrictedIds] = await Promise.all([
        getBlockedUserIds(client),
        getRestrictedUserIds(client),
      ]);
      const excluded = new Set([...blockedIds, ...restrictedIds]);
      res.json({
        viewerId: mcpRequest.mcp?.activeUserId,
        visibleAuthorIds: ['blocked-user', 'restricted-user', 'safe-user']
          .filter((id) => !excluded.has(id)),
      });
    } catch (error) {
      next(error);
    }
  });
  app.use((
    error: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    res.status(503).json({ error: error.name });
  });
  return app;
}

describe('MCP feed privacy delegation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // What Oxy ACTUALLY answers a service credential here: the empty graph, 200.
    // It withholds blocks and restrictions from a service token by design (its
    // own route test: "service-token delegation returns the empty graph even
    // when a delegated viewer resolves, because blocks and restrictions are
    // private data"). This stub used to return populated lists — an assumption
    // no one had checked against the provider — which is exactly why the
    // fail-open below went unnoticed.
    mocks.makeServiceRequest.mockImplementation(
      async (_method: string, path: string) => {
        if (path === '/users/me/graph') {
          return {
            data: { followingIds: [], mutualIds: [], blockedIds: [], restrictedIds: [] },
          };
        }
        throw new Error(`Unexpected Oxy path: ${path}`);
      },
    );
  });

  /**
   * The case this file was written to prove — "delegation resolves the viewer's
   * blocks" — is not something Oxy will do for a service credential, so the only
   * honest assertion is the opposite one: a delegated caller is TOLD it cannot
   * resolve the lists. Answering the empty graph as if it were the viewer's own
   * would ship an unfiltered feed to every MCP client.
   */
  it('refuses a delegated privacy read rather than reading the empty graph as the viewer’s', async () => {
    const response = await request(buildApp())
      .get('/feed/mtn')
      .set('Authorization', `Bearer ${token}`)
      .expect(503);

    expect(response.body).toEqual({ error: 'OxyPrivacyUnavailableError' });
    expect(response.body.visibleAuthorIds).toBeUndefined();
    // No graph round trip is made for a read it cannot answer.
    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
    expect(mocks.setTokens).not.toHaveBeenCalled();
  });

  it('refuses the same way when Oxy is unreachable, never with a partial feed', async () => {
    mocks.makeServiceRequest.mockRejectedValue(
      Object.assign(new Error('network unavailable'), { code: 'NETWORK_ERROR' }),
    );

    const response = await request(buildApp())
      .get('/feed/mtn')
      .set('Authorization', `Bearer ${token}`)
      .expect(503);

    expect(response.body).toEqual({ error: 'OxyPrivacyUnavailableError' });
    expect(response.body.visibleAuthorIds).toBeUndefined();
    expect(mocks.setTokens).not.toHaveBeenCalled();
  });
});
