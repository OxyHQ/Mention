/**
 * `/_oxy/mcp` binds to the registration this process obtains from Oxy for the
 * catalogue it serves — never to a binding copied into config, whose absence
 * in production made every Alia call to Mention answer 503.
 */
import { createHash } from 'node:crypto';
import { describe, expect, mock, test } from 'bun:test';
import { canonicalCapabilityJson, type CapabilityCatalogBinding } from '@oxy.so/contracts';
import type { McpHttpConfig } from '../lib/config';
import { createMentionInternalMcpReceiver } from '../lib/internal-capability-mcp';
import { MENTION_CAPABILITY_CATALOG } from '../lib/mention-catalog';

const config: McpHttpConfig = {
  port: 0,
  maxRequestBodyBytes: 4096,
  maxSessions: 1,
  publicUrl: 'https://mcp.mention.test',
  oxyApiUrl: 'https://api.oxy.test',
  allowedOrigins: new Set(),
};

/** The process's one Oxy client, as the receiver sees it: counted, never on the network. */
function fakeOxy() {
  return {
    createServiceClient: mock(() => ({ fetch: globalThis.fetch, dispose() {} })),
    agency: { introspectCapabilityTicket: mock(async () => ({ active: false })) },
  };
}

const oxy = fakeOxy() as never;

const binding: CapabilityCatalogBinding = {
  registrationId: '01a0ed95-305f-7605-8d8b-6c5578e8b60f',
  version: MENTION_CAPABILITY_CATALOG.version,
  digest: createHash('sha256')
    .update(canonicalCapabilityJson(MENTION_CAPABILITY_CATALOG))
    .digest('hex'),
};

describe('createMentionInternalMcpReceiver', () => {
  test('registers once, however many requests arrive together, and keeps the binding', async () => {
    let registrations = 0;
    const receiver = createMentionInternalMcpReceiver(config, oxy, async () => {
      registrations += 1;
      return binding;
    });
    const [first, second] = await Promise.all([receiver.bound(), receiver.bound()]);
    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(await receiver.bound()).toBe(first);
    expect(registrations).toBe(1);
  });

  test('answers unbound while Oxy refuses, and retries after the wait', async () => {
    let clock = 0;
    let refuse = true;
    let registrations = 0;
    const receiver = createMentionInternalMcpReceiver(
      config,
      oxy,
      async () => {
        registrations += 1;
        if (refuse) throw { message: 'HTTP 403', status: 403 };
        return binding;
      },
      () => clock,
    );
    expect(await receiver.bound()).toBeUndefined();
    // Within the wait: no second registration, still unbound.
    clock = 10_000;
    expect(await receiver.bound()).toBeUndefined();
    expect(registrations).toBe(1);
    // After it: Oxy answers, the receiver binds.
    refuse = false;
    clock = 30_001;
    expect(await receiver.bound()).toBeDefined();
    expect(registrations).toBe(2);
  });

  test('stays unbound when the registration is not this catalogue', async () => {
    const receiver = createMentionInternalMcpReceiver(config, oxy, async () => ({
      ...binding,
      digest: 'f'.repeat(64),
    }));
    expect(await receiver.bound()).toBeUndefined();
  });

  test('builds on the ONE Oxy client it is given, never a client of its own', async () => {
    const processOxy = fakeOxy();
    const receiver = createMentionInternalMcpReceiver(config, processOxy as never);
    // The default registration goes through the same client as everything else.
    processOxy.createServiceClient.mockImplementationOnce(() => {
      throw Object.assign(new Error('refused'), { status: 403 });
    });
    expect(await receiver.bound()).toBeUndefined();
    expect(processOxy.createServiceClient).toHaveBeenCalledTimes(1);
    expect(processOxy.createServiceClient).toHaveBeenCalledWith({
      baseURL: config.oxyApiUrl,
      audience: 'oxy-api',
    });
  });
});
