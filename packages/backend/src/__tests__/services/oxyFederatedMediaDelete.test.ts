import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  tokens: ['token-1', 'token-2'],
  serviceToken: vi.fn(),
  invalidateServiceToken: vi.fn(),
  handler: (_req: IncomingMessage, _body: string, res: ServerResponse): void => { res.end(); },
  requests: [] as Array<{ method?: string; url?: string; auth?: string; contentType?: string; body: string }>,
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    baseURL: h.baseURL,
    serviceToken: h.serviceToken,
    invalidateServiceToken: h.invalidateServiceToken,
  }),
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
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      h.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, contentType: req.headers['content-type'], body });
      h.handler(req, body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  h.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  h.requests.length = 0;
  resetWriteBudgetCooldowns();
  let n = 0;
  h.serviceToken.mockReset().mockImplementation(async () => h.tokens[Math.min(n++, h.tokens.length - 1)]);
  h.invalidateServiceToken.mockReset();
});

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

describe('deleteFederatedMedia', () => {
  it('POSTs the ids to the batch route with the service token and returns Oxy\'s answer per id', async () => {
    h.handler = (_req, body, res) => {
      const ids = (JSON.parse(body) as { ids: string[] }).ids;
      json(res, 200, { data: { results: ids.map((id, i) => ({ id, result: i === 0 ? 'deleted' : 'not_found' })) } });
    };
    expect(isMediaCacheEnabled()).toBe(false);

    const results = await deleteFederatedMedia(['file-a', 'file-b']);

    expect(results).toEqual([{ id: 'file-a', result: 'deleted' }, { id: 'file-b', result: 'not_found' }]);
    expect(h.requests).toEqual([expect.objectContaining({
      method: 'POST',
      url: '/assets/service/federation/delete',
      auth: 'Bearer token-1',
      contentType: 'application/json',
    })]);
    // Exactly `{ ids }` — the route rejects extra fields.
    expect(JSON.parse(h.requests[0].body)).toEqual({ ids: ['file-a', 'file-b'] });
  });

  it('re-mints the service token once on a 401', async () => {
    h.handler = (req, _body, res) => {
      if (req.headers.authorization === 'Bearer token-1') return json(res, 401, { error: 'expired' });
      json(res, 200, { data: { results: [{ id: 'file-a', result: 'deleted' }] } });
    };
    await expect(deleteFederatedMedia(['file-a'])).resolves.toEqual([{ id: 'file-a', result: 'deleted' }]);
    expect(h.invalidateServiceToken).toHaveBeenCalledTimes(1);
    expect(h.requests.map((r) => r.auth)).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  it('reports 429 as throttled, honouring Retry-After', async () => {
    h.handler = (_req, _body, res) => json(res, 429, { error: 'slow down' }, { 'retry-after': '120' });
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

  it('ignores answers for ids it did not ask about, and refuses more than 50 ids', async () => {
    h.handler = (_req, _body, res) => json(res, 200, { data: { results: [{ id: 'someone-else', result: 'deleted' }, { id: 'file-a', result: 'forbidden' }] } });
    await expect(deleteFederatedMedia(['file-a'])).resolves.toEqual([{ id: 'file-a', result: 'forbidden' }]);
    await expect(deleteFederatedMedia(Array.from({ length: 51 }, (_, i) => `f${i}`))).rejects.toThrow(/at most 50/);
  });
});
