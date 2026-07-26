import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.MENTION_MCP_JWT_SECRET = 'test-mcp-privacy-secret';
process.env.MENTION_MCP_PUBLIC_URL = 'https://mcp.mention.earth';

const mocks = vi.hoisted(() => ({
  makeServiceRequest: vi.fn(),
  setTokens: vi.fn(),
  configureServiceAuth: vi.fn(),
  getUserFollowing: vi.fn(),
  getUserFollowers: vi.fn(),
}));

vi.mock('@oxyhq/core', () => ({
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
    mocks.makeServiceRequest.mockImplementation(
      async (_method: string, path: string) => {
        if (path === '/users/me/graph') {
          return { data: { blockedIds: ['blocked-user'] } };
        }
        if (path === '/privacy/restricted') {
          return [{ restrictedId: 'restricted-user' }];
        }
        throw new Error(`Unexpected Oxy path: ${path}`);
      },
    );
  });

  it('uses service delegation for the active bundle account and filters both lists', async () => {
    const response = await request(buildApp())
      .get('/feed/mtn')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual({
      viewerId: 'active-user',
      visibleAuthorIds: ['safe-user'],
    });
    expect(mocks.makeServiceRequest).toHaveBeenCalledWith(
      'GET',
      '/users/me/graph',
      undefined,
      'active-user',
    );
    expect(mocks.makeServiceRequest).toHaveBeenCalledWith(
      'GET',
      '/privacy/restricted',
      undefined,
      'active-user',
    );
    expect(mocks.setTokens).not.toHaveBeenCalled();
  });

  it('fails closed instead of returning an unfiltered feed on delegated auth failure', async () => {
    mocks.makeServiceRequest.mockRejectedValue(
      Object.assign(new Error('Forbidden'), { status: 403, code: 'FORBIDDEN' }),
    );

    const response = await request(buildApp())
      .get('/feed/mtn')
      .set('Authorization', `Bearer ${token}`)
      .expect(503);

    expect(response.body).toEqual({ error: 'OxyPrivacyAuthorizationError' });
    expect(response.body.visibleAuthorIds).toBeUndefined();
    expect(mocks.setTokens).not.toHaveBeenCalled();
  });

  it('fails closed instead of returning an unfiltered feed on an Oxy outage', async () => {
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
