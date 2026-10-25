import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resetCrowdSourceForOxyService } from '@crowdsource.you/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The CrowdSource client must authenticate through the `@oxy.so/core` this
 * backend actually installs.
 *
 * The product factory receives Mention's OxyServer and infrastructure credential
 * provider. This catches a missing provider as well as SDK/core contract drift:
 * public notes must use workload v2 with the receiver's canonical audience,
 * never the retired customer-key mint endpoint.
 * Real loopback HTTP for both Oxy and CrowdSource; only the responses are fixtures.
 */

const settings = vi.hoisted(() => ({
  oxyApiUrl: '',
  oxy: { requestMetricsEnabled: false },
  crowdSource: { baseUrl: undefined as string | undefined },
}));
vi.mock('../../../config', () => ({ config: settings }));

import {
  getCrowdSourceClient,
  resetCrowdSourceClient,
} from '../../../services/moderation/crowdSourceClient';
import { getRuntimeOxyClient, clearRuntimeOxyClient } from '../../../runtime/oxyClient';

const SERVICE_AUDIENCE = 'oxy-service:6a6947b30fe72510b411252f';
const SERVICE_TOKEN = `e30.${Buffer.from(JSON.stringify({ type: 'service', authority: 'first_party', aud: SERVICE_AUDIENCE, exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')}.fixture`;
const requests: Array<{ path: string; authorization?: string; body?: Record<string, unknown> }> =
  [];
let server: http.Server;
const savedEnv: Record<string, string | undefined> = {};
const ENV = [
  'OXY_API_URL',
  'OXY_SERVICE_API_KEY',
  'OXY_SERVICE_API_SECRET',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_CREDENTIAL_EXPIRATION',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
] as const;

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    requests.push({ path: req.url ?? '', authorization: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/auth/service-token/workload/challenge') {
      res.end(JSON.stringify({ nonce: 'fixture' }));
    } else if (req.url === '/auth/service-token/workload') {
      res.end(JSON.stringify({ token: SERVICE_TOKEN, expiresIn: 300 }));
    } else if (req.url?.startsWith('/v1/community-notes/shown')) {
      res.end(JSON.stringify({ notes: [] }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // Loopback uses the same shared workload transport without external credentials.
  const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

  for (const name of ENV) savedEnv[name] = process.env[name];
  process.env.OXY_API_URL = origin;
  delete process.env.OXY_SERVICE_API_KEY;
  delete process.env.OXY_SERVICE_API_SECRET;
  delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  process.env.AWS_ACCESS_KEY_ID = 'ASIA_MENTION_TEST';
  process.env.AWS_SECRET_ACCESS_KEY = 'temporary-test-only';
  process.env.AWS_SESSION_TOKEN = 'temporary-session';
  process.env.AWS_CREDENTIAL_EXPIRATION = new Date(Date.now() + 300000).toISOString();
  settings.oxyApiUrl = origin;
  clearRuntimeOxyClient();
  settings.crowdSource.baseUrl = origin;
  resetCrowdSourceForOxyService();
});

afterAll(async () => {
  resetCrowdSourceClient();
  getRuntimeOxyClient().dispose();
  clearRuntimeOxyClient();
  for (const name of ENV) {
    if (savedEnv[name] === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = savedEnv[name];
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('CrowdSource client on the installed Oxy SDK', () => {
  it('mints an Oxy service token and presents it to CrowdSource', async () => {
    const client = getCrowdSourceClient();
    expect(client).toBeDefined();

    expect(getCrowdSourceClient()).toBe(client);
    await expect(client?.communityNotes.shown(['post_1', 'post_2'])).resolves.toEqual([]);

    expect(requests.some((request) => request.path === '/auth/service-token')).toBe(false);
    const mint = requests.find((request) => request.path === '/auth/service-token/workload');
    expect(mint?.body).toMatchObject({
      provider: 'aws-iam',
      protocolVersion: 2,
      audience: SERVICE_AUDIENCE,
    });
    expect(mint?.body).not.toHaveProperty('scopes');
    const lookup = requests.find((request) => request.path.startsWith('/v1/community-notes/shown'));
    expect(lookup?.path).toBe('/v1/community-notes/shown?subjects=post_1,post_2');
    expect(lookup?.authorization).toBe(`Bearer ${SERVICE_TOKEN}`);
  });
  it('disposes the owned transport on reset and creates a fresh service client', async () => {
    const previous = getCrowdSourceClient();
    resetCrowdSourceClient();
    const lookupCount = () =>
      requests.filter((request) => request.path.startsWith('/v1/community-notes/shown')).length;
    const countBefore = lookupCount();
    await expect(previous?.communityNotes.shown(['post_1'])).rejects.toThrow();
    expect(lookupCount()).toBe(countBefore);
    const next = getCrowdSourceClient();
    expect(next).not.toBe(previous);
    expect(getCrowdSourceClient()).toBe(next);
    await expect(next?.communityNotes.shown(['post_1'])).resolves.toEqual([]);
  });
});
