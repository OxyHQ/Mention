import type { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { describe, expect, test } from 'bun:test';
import { fingerprintMcpPrincipal, type AuthenticatedMcpToken } from '../lib/http-security.js';
import { McpSessionRegistry } from '../lib/session-registry.js';

const claims = {
  sub: 'user-1',
  accountId: 'account-1',
  client_id: 'client-1',
  jti: 'token-family-1',
  scope: 'social.read',
  scopes: new Set(['social.read']),
  authMode: 'central',
} as AuthenticatedMcpToken;

describe('Legacy SSE session registry', () => {
  test('keeps transport and principal state in sync', () => {
    const registry = new McpSessionRegistry();
    const transport = fakeTransport();

    registry.register('session-1', transport.value, fingerprintMcpPrincipal(claims));

    expect(registry.size).toBe(1);
    expect(registry.get('session-1')).toBe(transport.value);
    expect(registry.isAuthorized('session-1', claims)).toBe(true);
    expect(
      registry.isAuthorized('session-1', {
        ...claims,
        sub: 'another-user',
      }),
    ).toBe(false);

    registry.delete('session-1');
    expect(registry.size).toBe(0);
    expect(registry.isAuthorized('session-1', claims)).toBe(false);
  });

  test('drains every registered transport during shutdown', async () => {
    const registry = new McpSessionRegistry();
    const first = fakeTransport();
    const second = fakeTransport();
    const fingerprint = fingerprintMcpPrincipal(claims);

    registry.register('first', first.value, fingerprint);
    registry.register('second', second.value, fingerprint);
    await registry.closeAll();

    expect(registry.size).toBe(0);
    expect(first.closed()).toBe(1);
    expect(second.closed()).toBe(1);
  });
});

function fakeTransport(): {
  value: SSEServerTransport;
  closed: () => number;
} {
  let closeCalls = 0;
  return {
    value: {
      close: async () => {
        closeCalls++;
      },
    } as unknown as SSEServerTransport,
    closed: () => closeCalls,
  };
}
