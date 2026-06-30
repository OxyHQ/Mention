import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Phase C4 — Relay registration client. Relay crawl is an EXTERNAL ACTIVATION
 * step: it is gated behind the bridge being enabled AND a configured Relay host,
 * and must NEVER reach the network in the default (disabled) config. The test
 * asserts the inert path with the upstream fetch MOCKED — the suite never hits a
 * real Relay.
 */

const mockFetch = vi.fn();

vi.mock('../../../../utils/safeUpstreamFetch', () => ({
  fetchUpstreamSingleHop: (...a: unknown[]) => mockFetch(...a),
}));

import { requestRelayCrawl } from '../../../../connectors/atproto/bridge/relayClient';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requestRelayCrawl', () => {
  it('is inert (no network) when the bridge is disabled by default', async () => {
    // The default test env has ATPROTO_BRIDGE_ENABLED unset → the bridge is off.
    const result = await requestRelayCrawl();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bridge_disabled');
    // CRITICAL: the activation step never touched the network in the default config.
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
