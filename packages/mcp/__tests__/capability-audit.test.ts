import { afterEach, describe, expect, test, vi } from 'bun:test';
import { OxyServer } from '@oxy.so/core/server';
import { createMentionCapabilityAudit } from '../lib/capability-audit.js';

const originalFetch = globalThis.fetch;

describe('Oxy capability audit failures', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("carry Oxy's own reason, so a missing service scope is not an anonymous outage", async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/capabilities/audit')) {
        return new Response(JSON.stringify({ error: 'insufficient_service_scope' }), {
          status: 403,
        });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const audit = createMentionCapabilityAudit({
      oxyApiUrl: 'https://api.oxy.test',
      oxyServiceApiKey: 'key',
      oxyServiceApiSecret: 'secret',
    });
    // The service token is minted through the same client; stub it out.
    const tokenSpy = vi
      .spyOn(OxyServer.prototype, 'serviceToken')
      .mockResolvedValue('service-token');
    try {
      await expect(
        audit.audit({
          ticket: 'ticket',
          result: { status: 'succeeded' },
          rollbackSupported: false,
        }),
      ).rejects.toThrow(/403: .*insufficient_service_scope/);
    } finally {
      tokenSpy.mockRestore();
    }
  });
});
