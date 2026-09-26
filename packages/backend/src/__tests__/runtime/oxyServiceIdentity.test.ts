/**
 * Mention's server-side Oxy clients identify as Mention on reads that have no
 * user behind them (#1173).
 *
 * Without `serviceIdentity: 'when-anonymous'` those reads — web-shell profile
 * pages, `getUserById` fallbacks, `from:`/`to:` operators — went out anonymous,
 * were charged to the cluster's single NAT address, and past 100 anonymous
 * requests per 15 minutes each paid oxy-api's +500 ms `slowDown`. What is
 * asserted is the `Authorization` header that reaches the network, which is the
 * only thing oxy-api's limiter reads.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearRuntimeOxyClient, getRuntimeOxyClient } from '../../runtime/oxyClient';
import { getServiceOxyClient } from '../../utils/oxyHelpers';

function authorizationOf(init: RequestInit | undefined): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.Authorization ?? headers?.authorization;
}

describe('server-side Oxy clients carry the service token on session-less reads', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearRuntimeOxyClient();
    vi.restoreAllMocks();
  });

  it.each([
    ['the runtime client', () => getRuntimeOxyClient()],
    ['the service client', () => getServiceOxyClient()],
  ])('%s sends a public profile read with the service bearer', async (_label, getClient) => {
    const seen: Array<string | undefined> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(authorizationOf(init));
      return new Response(JSON.stringify({ data: { id: 'u1', username: 'alice', name: {} } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const client = getClient();
    vi.spyOn(client, '_canUseWorkloadIdentity').mockResolvedValue(true);
    vi.spyOn(client, 'getServiceToken').mockResolvedValue('mention-service-token');

    await client.getProfileByUsername(`alice-${Math.random().toString(36).slice(2)}`, { cache: false });

    expect(seen).toEqual(['Bearer mention-service-token']);
  });
});
