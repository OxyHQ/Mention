/**
 * The network guard installed by `setup.ts` is itself under test: a guard that
 * silently stopped refusing would let the next accidental network dependency
 * back in, and nothing else in the suite would notice until the slow pool did.
 */
import dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { closedLoopbackOrigin, isLoopbackHost, takeRefusals } from './networkGuard';

afterEach(() => {
  // Each case below provokes its refusal on purpose; the per-test check in
  // setup.ts must not see it.
  takeRefusals();
});

describe('the backend test network guard', () => {
  it('refuses a non-loopback fetch at once, as a refused connection', async () => {
    const started = Date.now();
    const error = await fetch('https://guard-probe.example/').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TypeError);
    expect((error as { cause?: { code?: string } }).cause?.code).toBe('ECONNREFUSED');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(takeRefusals()).toEqual(['guard-probe.example:443']);
  });

  it('refuses a raw http.request to a public address', async () => {
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
      http.get('http://169.254.169.254/latest/meta-data/').on('error', resolve);
    });

    expect(error.code).toBe('ECONNREFUSED');
    expect(takeRefusals()).toEqual(['169.254.169.254:80']);
  });

  it('refuses to resolve a public name', async () => {
    await expect(dns.promises.lookup('guard-probe.example')).rejects.toMatchObject({
      code: 'ENOTFOUND',
    });
    const callbackError = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      dns.lookup('guard-probe.example', (error) => resolve(error));
    });
    expect(callbackError?.code).toBe('ENOTFOUND');
    expect(takeRefusals()).toEqual(['dns:guard-probe.example', 'dns:guard-probe.example']);
  });

  it('lets loopback through', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/`);
      expect(await response.text()).toBe('ok');
      expect(takeRefusals()).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('hands out an https origin on loopback, which the guard lets through', async () => {
    const origin = new URL(await closedLoopbackOrigin());

    expect(origin.protocol).toBe('https:');
    expect(isLoopbackHost(origin.hostname)).toBe(true);
    expect(Number(origin.port)).toBeGreaterThan(0);
  });

  it.each([
    ['localhost', true],
    ['api.localhost', true],
    ['127.0.0.1', true],
    ['127.8.9.10', true],
    ['::1', true],
    ['[::1]', true],
    ['::ffff:127.0.0.1', true],
    [undefined, true],
    ['api.oxy.so', false],
    ['169.254.169.254', false],
    ['10.0.0.1', false],
    ['::ffff:8.8.8.8', false],
    ['localhost.example', false],
  ])('treats %s as loopback: %s', (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});
