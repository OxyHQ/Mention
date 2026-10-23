import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OxyServer } from '@oxy.so/core/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `deleteFederatedMedia` against a real HTTP server standing in for oxy-api's
 * `POST /assets/service/federation/delete` (OxyHQ/oxy#1441).
 *
 * Media WRITES are switched OFF for this suite on purpose: a deletion is a
 * privacy obligation and must still go out.
 */

vi.mock('../../services/mediaCache/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/mediaCache/constants')>()),
  MEDIA_CACHE_WRITE_ENABLED: false,
}));

const h = vi.hoisted(() => ({
  baseURL: '',
  tokens: [1, 2].map(
    (nonce) =>
      `e30.${Buffer.from(
        JSON.stringify({
          type: 'service',
          authority: 'first_party',
          appId: 'mention',
          credentialId: 'wl_mention',
          ownerAccountId: 'owner',
          environment: 'production',
          aud: 'oxy-api',
          iss: 'oxy-auth',
          nonce,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
      ).toString('base64url')}.fixture`,
  ),
  mint: vi.fn(),
  oxy: null as OxyServer | null,
  handler: (_req: IncomingMessage, _body: string, res: ServerResponse): void => {
    res.end();
  },
  requests: [] as Array<{
    method?: string;
    url?: string;
    auth?: string;
    contentType?: string;
    body: string;
  }>,
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => {
    if (!h.oxy) throw new Error('Workload fixture is not initialized');
    return h.oxy;
  },
}));

import {
  deleteFederatedMedia,
  isMediaCacheEnabled,
  OxyMediaStoreRequestError,
  OxyMediaStoreThrottledError,
  resetWriteBudgetCooldowns,
} from '../../services/mediaCache/oxyMediaStore';

let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (req.url === '/auth/service-token/workload/challenge') {
        json(res, 200, { nonce: 'fixture-nonce' });
        return;
      }
      if (req.url === '/auth/service-token/workload') {
        const claims = JSON.parse(body);
        expect(claims.protocolVersion).toBe(2);
        expect(claims.audience ?? 'oxy-api').toBe('oxy-api');
        expect(claims.scopes).toBeUndefined();
        json(res, 200, { token: h.mint(), expiresIn: 300 });
        return;
      }
      h.requests.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        contentType: req.headers['content-type'],
        body,
      });
      h.handler(req, body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  h.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  h.oxy?.dispose();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  h.requests.length = 0;
  resetWriteBudgetCooldowns();
  let n = 0;
  h.mint.mockReset().mockImplementation(() => h.tokens[Math.min(n++, h.tokens.length - 1)]);
  h.oxy?.dispose();
  h.oxy = new OxyServer({
    baseURL: h.baseURL,
    workloadCredentials: async () => ({
      AccessKeyId: 'ASIA_TEST',
      SecretAccessKey: 'test-only',
      Token: 'temporary-test',
    }),
  });
});

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

describe('deleteFederatedMedia', () => {
  it("POSTs the ids to the batch route with the service token and returns Oxy's answer per id", async () => {
    h.handler = (_req, body, res) => {
      const ids = (JSON.parse(body) as { ids: string[] }).ids;
      json(res, 200, {
        data: { results: ids.map((id, i) => ({ id, result: i === 0 ? 'deleted' : 'not_found' })) },
      });
    };
    expect(isMediaCacheEnabled()).toBe(false);

    const results = await deleteFederatedMedia(['file-a', 'file-b']);

    expect(results).toEqual([
      { id: 'file-a', result: 'deleted' },
      { id: 'file-b', result: 'not_found' },
    ]);
    expect(h.requests).toEqual([
      expect.objectContaining({
        method: 'POST',
        url: '/assets/service/federation/delete',
        auth: `Bearer ${h.tokens[0]}`,
        contentType: 'application/json',
      }),
    ]);
    // Exactly `{ ids }` — the route rejects extra fields.
    expect(JSON.parse(h.requests[0].body)).toEqual({ ids: ['file-a', 'file-b'] });
  });

  it('re-mints the service token once on a 401', async () => {
    h.handler = (req, _body, res) => {
      if (req.headers.authorization === `Bearer ${h.tokens[0]}`)
        return json(res, 401, { error: 'expired' });
      json(res, 200, { data: { results: [{ id: 'file-a', result: 'deleted' }] } });
    };
    await expect(deleteFederatedMedia(['file-a'])).resolves.toEqual([
      { id: 'file-a', result: 'deleted' },
    ]);
    expect(h.mint).toHaveBeenCalledTimes(2);
    expect(h.requests.map((r) => r.auth)).toEqual([
      `Bearer ${h.tokens[0]}`,
      `Bearer ${h.tokens[1]}`,
    ]);
  });

  it('reports 429 as throttled, honouring Retry-After', async () => {
    h.handler = (_req, _body, res) =>
      json(res, 429, { error: 'slow down' }, { 'retry-after': '120' });
    const error = await deleteFederatedMedia(['file-a']).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(OxyMediaStoreThrottledError);
    expect((error as OxyMediaStoreThrottledError).retryAfterMs).toBe(120_000);
  });

  it('reports a MISSING route (older oxy-api, HTTP 404) as a failure, never as "not found"', async () => {
    h.handler = (_req, _body, res) => json(res, 404, { error: 'Cannot POST' });
    const error = await deleteFederatedMedia(['file-a']).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(OxyMediaStoreRequestError);
    expect((error as OxyMediaStoreRequestError).statusCode).toBe(404);
  });

  it('passes in_use through, and leaves an UNKNOWN result unanswered (so it is retried)', async () => {
    h.handler = (_req, _body, res) =>
      json(res, 200, {
        data: {
          results: [
            { id: 'file-a', result: 'in_use' },
            { id: 'file-b', result: 'quarantined' },
          ],
        },
      });
    await expect(deleteFederatedMedia(['file-a', 'file-b'])).resolves.toEqual([
      { id: 'file-a', result: 'in_use' },
    ]);
  });

  it('ignores answers for ids it did not ask about, and refuses more than 50 ids', async () => {
    h.handler = (_req, _body, res) =>
      json(res, 200, {
        data: {
          results: [
            { id: 'someone-else', result: 'deleted' },
            { id: 'file-a', result: 'forbidden' },
          ],
        },
      });
    await expect(deleteFederatedMedia(['file-a'])).resolves.toEqual([
      { id: 'file-a', result: 'forbidden' },
    ]);
    await expect(
      deleteFederatedMedia(Array.from({ length: 21 }, (_, i) => `f${i}`)),
    ).rejects.toThrow(/at most 20/);
    expect(h.requests).toHaveLength(1);
  });
});
