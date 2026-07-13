import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import https from 'https';
import { Readable } from 'stream';

import { apexFrontendProxy, isApexHost } from '../middleware/apexFrontendProxy';

/** SPA shell the mocked frontend CDN returns for any proxied request. */
const SPA_SHELL =
  '<!DOCTYPE html><html lang="en"><head><title>Mention</title></head>' +
  '<body><div id="root"></div><script src="/_expo/static/js/web/entry.js" defer></script></body></html>';

/**
 * Build an app that mirrors server.ts's relevant mount order: the host-gated root
 * welcome route, then the apex proxy, then stub API routes. The stub API routes let
 * us prove that on the apex host a colliding path (`/feed`) is proxied to the SPA
 * rather than hitting the API, while on the API host it hits the API.
 */
function makeApp() {
  const app = express();
  app.set('trust proxy', 1);

  // Root welcome, host-gated exactly like server.ts.
  app.get('', (req, res, next) => {
    if (isApexHost(req)) return next();
    res.json({ who: 'api-welcome' });
  });

  app.use(apexFrontendProxy);

  // Stub API routes (only reached by the API host after the proxy no-ops).
  app.get('/feed', (_req, res) => res.json({ who: 'api-feed' }));
  app.get('/feed/item/:id', (req, res) => res.json({ who: 'api-feed-item', id: req.params.id }));

  return app;
}

/**
 * Stub the raw `http`/`https` client the proxy uses (NOT `fetch` — the proxy uses
 * Node's http client so the CDN's compressed bytes pass through undecoded). Returns
 * the request mock so tests can assert on the target URL / call count.
 */
function stubCdn(overrides?: { status?: number; cacheControl?: string; contentType?: string; fail?: boolean }) {
  const requestMock = vi.fn(
    (url: string | URL, _options: unknown, callback: (res: Readable & { statusCode?: number; headers?: Record<string, string> }) => void) => {
      const handlers: Record<string, (arg?: unknown) => void> = {};
      const clientReq = {
        on(event: string, handler: (arg?: unknown) => void) {
          handlers[event] = handler;
          return clientReq;
        },
        setTimeout() {
          return clientReq;
        },
        end() {
          if (overrides?.fail) {
            queueMicrotask(() => handlers.error?.(new Error('CDN unreachable')));
            return;
          }
          const incoming = new Readable({ read() {} }) as Readable & {
            statusCode?: number;
            headers?: Record<string, string>;
          };
          incoming.statusCode = overrides?.status ?? 200;
          incoming.headers = {
            'content-type': overrides?.contentType ?? 'text/html; charset=utf-8',
            'cache-control': overrides?.cacheControl ?? 'public, max-age=0, must-revalidate',
          };
          queueMicrotask(() => {
            callback(incoming);
            incoming.push(Buffer.from(SPA_SHELL));
            incoming.push(null);
          });
        },
        destroy() {
          return clientReq;
        },
      };
      return clientReq;
    },
  );
  // Only `https` is stubbed: the CDN origin is https, while supertest itself uses
  // `http.request` to reach the local Express app — mocking that would break it.
  vi.spyOn(https, 'request').mockImplementation(requestMock as unknown as typeof https.request);
  return requestMock;
}

const APEX = 'mention.earth';
const API = 'api.mention.earth';

describe('apexFrontendProxy (host-aware reverse-proxy)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('proxies apex `/` to the frontend CDN (SPA homepage, not the API welcome)', async () => {
    const fetchMock = stubCdn();

    const res = await request(makeApp()).get('/').set('X-Forwarded-Host', APEX);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('id="root"');
    expect(res.body.who).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://mention-frontend.pages.dev/');
  });

  it('proxies an apex SPA route (`/explore`) to the CDN, preserving path + query', async () => {
    const fetchMock = stubCdn();

    const res = await request(makeApp()).get('/explore?tab=news').set('X-Forwarded-Host', APEX);

    expect(res.status).toBe(200);
    expect(res.text).toContain('id="root"');
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://mention-frontend.pages.dev/explore?tab=news');
  });

  it('proxies apex `/feed` to the SPA instead of hitting the API feed route', async () => {
    const fetchMock = stubCdn();

    const res = await request(makeApp()).get('/feed').set('X-Forwarded-Host', APEX);

    expect(res.status).toBe(200);
    expect(res.text).toContain('id="root"');
    expect(res.body.who).toBeUndefined(); // NOT { who: 'api-feed' }
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://mention-frontend.pages.dev/feed');
  });

  it('passes the CDN content-type and cache-control through (so CF can edge-cache)', async () => {
    stubCdn({ contentType: 'application/javascript', cacheControl: 'public, max-age=31536000, immutable' });

    const res = await request(makeApp())
      .get('/_expo/static/js/web/entry-abc123.js')
      .set('X-Forwarded-Host', APEX);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/javascript');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('does NOT proxy the API host — `/feed/item/:id` still hits the API', async () => {
    const fetchMock = stubCdn();

    const res = await request(makeApp()).get('/feed/item/507f1f77bcf86cd799439011').set('X-Forwarded-Host', API);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ who: 'api-feed-item', id: '507f1f77bcf86cd799439011' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does NOT proxy the API host root — `/` returns the API welcome', async () => {
    const fetchMock = stubCdn();

    const res = await request(makeApp()).get('/').set('X-Forwarded-Host', API);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ who: 'api-welcome' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does NOT proxy when there is no apex host at all (bare/unknown host)', async () => {
    const fetchMock = stubCdn();

    const res = await request(makeApp()).get('/feed'); // no X-Forwarded-Host → 127.0.0.1

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ who: 'api-feed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 405 for a non-GET/HEAD method on the apex host without proxying', async () => {
    const fetchMock = stubCdn();

    const res = await request(makeApp()).post('/feed').set('X-Forwarded-Host', APEX);

    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('GET, HEAD');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails soft with a 502 bootable shell when the CDN is unreachable', async () => {
    stubCdn({ fail: true });

    const res = await request(makeApp()).get('/explore').set('X-Forwarded-Host', APEX);

    expect(res.status).toBe(502);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('id="root"');
  });

  describe('isApexHost', () => {
    it('matches the apex via the first X-Forwarded-Host token', () => {
      const req = { headers: { 'x-forwarded-host': 'mention.earth, other.internal' }, hostname: '' } as unknown as express.Request;
      expect(isApexHost(req)).toBe(true);
    });

    it('does not match the API host', () => {
      const req = { headers: { 'x-forwarded-host': 'api.mention.earth' }, hostname: 'api.mention.earth' } as unknown as express.Request;
      expect(isApexHost(req)).toBe(false);
    });

    it('ignores a :port suffix when matching', () => {
      const req = { headers: { 'x-forwarded-host': 'mention.earth:443' }, hostname: '' } as unknown as express.Request;
      expect(isApexHost(req)).toBe(true);
    });
  });
});
