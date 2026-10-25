import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { clearRuntimeOxyClient, getRuntimeOxyClient } from '../../runtime/oxyClient';
import { getServiceOxyClient } from '../../utils/oxyHelpers';

const originalFetch = globalThis.fetch;
const SERVICE_TOKEN = `e30.${Buffer.from(JSON.stringify({ type: 'service', authority: 'first_party', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`;
const names = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_CREDENTIAL_EXPIRATION',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
];
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
beforeEach(() => {
  clearRuntimeOxyClient();
  process.env.AWS_ACCESS_KEY_ID = 'ASIA_MENTION_TEST';
  process.env.AWS_SECRET_ACCESS_KEY = 'test-only-workload-secret';
  process.env.AWS_SESSION_TOKEN = 'test-temporary-session';
  process.env.AWS_CREDENTIAL_EXPIRATION = new Date(Date.now() + 3600_000).toISOString();
  delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearRuntimeOxyClient();
  jest.restoreAllMocks();
  for (const name of names) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
});
describe('process workload identity', () => {
  it('shares the provider-backed client and attests without an ECS environment gate', async () => {
    const requests: Array<{ path: string; headers: Headers; body: unknown }> = [];
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({
        path,
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      if (path.endsWith('/workload/challenge')) return Response.json({ nonce: 'fixture' });
      if (path.endsWith('/workload'))
        return Response.json({ token: SERVICE_TOKEN, expiresIn: 300 });
      return Response.json({ data: { id: 'u1', username: 'alice', name: {} } });
    }) as typeof fetch;
    const client = getRuntimeOxyClient();
    expect(getServiceOxyClient()).toBe(client);
    await client.users.byUsername('alice', { cache: false });
    expect(requests.some((request) => request.path === '/auth/service-token')).toBe(false);
    const exchange = requests.find((request) => request.path.endsWith('/workload'));
    expect(exchange?.body).toMatchObject({ provider: 'aws-iam', protocolVersion: 2 });
    expect(JSON.stringify(exchange?.body)).not.toContain('test-only-workload-secret');
    expect(requests.at(-1)?.headers.get('authorization')).toBe(`Bearer ${SERVICE_TOKEN}`);
  });
  it('does not dispatch a user read when workload attestation is refused', async () => {
    const paths: string[] = [];
    globalThis.fetch = (async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      return path.endsWith('/challenge')
        ? Response.json({ nonce: 'fixture' })
        : Response.json({}, { status: 403 });
    }) as typeof fetch;
    await expect(
      getServiceOxyClient().users.byUsername('private-target', { cache: false }),
    ).rejects.toThrow();
    expect(paths.some((path) => path.includes('/users/'))).toBe(false);
  });
});
