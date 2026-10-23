import { afterEach, describe, expect, test, vi } from 'bun:test';
import { OxyServer } from '@oxy.so/core/server';
import { createMentionCapabilityAudit } from '../lib/capability-audit.js';

const originalFetch = globalThis.fetch;

describe('Oxy capability audit failures', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('surfaces the shared authority refusal without another delivery attempt', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/capabilities/audit')) {
        return new Response(JSON.stringify({ error: 'insufficient_service_scope' }), {
          status: 403,
        });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const tokenSpy = vi.spyOn(OxyServer.prototype, 'createServiceClient').mockReturnValue({
      fetch: globalThis.fetch,
      dispose() {},
    });
    const audit = createMentionCapabilityAudit({ oxyApiUrl: 'https://api.oxy.test' });
    try {
      await expect(
        audit.audit({
          ticket: 'ticket',
          result: { status: 'succeeded' },
          rollbackSupported: false,
        }),
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      tokenSpy.mockRestore();
    }
  });
});
