import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { resolveMcpAutoAcceptIds } from '../../mcp/utils/resolveMcpAutoAcceptIds';

/** A request served through an MCP connection Oxy says covers these accounts. */
function connectionRequest(accountIds: string[] | undefined): Request {
  return {
    mcp: {
      jti: 'jti-1',
      scope: 'social.posts.publish',
      clientId: 'claude',
      primaryUserId: 'owner',
      activeUserId: accountIds?.[0] ?? 'owner',
      ...(accountIds
        ? {
            connection: {
              connectionId: 'connection-1',
              originAccountId: accountIds[0],
              activeAccountId: accountIds[0],
              accounts: accountIds.map((accountId, index) => ({
                accountId,
                isOrigin: index === 0,
                linkedAt: '2026-01-01T00:00:00.000Z',
              })),
            },
          }
        : {}),
    },
  } as unknown as Request;
}

describe('resolveMcpAutoAcceptIds', () => {
  it('accepts for the invited accounts the connection can already act as', () => {
    const req = connectionRequest(['personal', 'brand']);
    expect(resolveMcpAutoAcceptIds(req, ['brand', 'stranger'])).toEqual(['brand']);
  });

  it('leaves every invitation pending for anyone outside the connection', () => {
    expect(resolveMcpAutoAcceptIds(connectionRequest(['personal', 'brand']), ['stranger'])).toBeUndefined();
    // A connection bound to one account, with no Oxy account set, accepts for nobody.
    expect(resolveMcpAutoAcceptIds(connectionRequest(undefined), ['personal'])).toBeUndefined();
  });

  it('accepts nothing for a request that is not an MCP connection', () => {
    expect(resolveMcpAutoAcceptIds({} as Request, ['brand'])).toBeUndefined();
    expect(resolveMcpAutoAcceptIds(connectionRequest(['personal', 'brand']), undefined)).toBeUndefined();
  });
});
