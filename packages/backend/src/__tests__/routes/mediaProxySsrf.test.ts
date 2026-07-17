import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Route-level regression proof for `/media/proxy` AFTER the Phase 1 SSRF
 * convergence onto `@oxyhq/core/server`. The transport's SSRF blocking (private
 * IP / redirect-to-internal) is proven against the REAL core guard in
 * `utils/safeUpstreamFetchSsrf.test.ts`; here we prove the Mention-ONLY
 * protections that live in the route (NOT in core's safeFetch) still hold:
 *
 *  - the content-type allowlist rejects a non-media type,
 *  - SVG is rejected specifically (XML that can embed scripts),
 *  - a real image is still served with byte-range support.
 *
 * Transport is mocked (established `mediaProxy.test.ts` pattern) so we can inject
 * a controlled upstream content-type/body without a real socket — and so
 * supertest's own http client is not hijacked.
 */

vi.mock('../../middleware/rateLimitStore', () => ({
  RedisStore: class {
    init(): void {}
    async increment(): Promise<{ totalHits: number; resetTime: undefined }> {
      return { totalHits: 1, resetTime: undefined };
    }
    async decrement(): Promise<void> {}
    async resetKey(): Promise<void> {}
    async get(): Promise<undefined> {
      return undefined;
    }
  },
}));

/** Keep the media cache front inert so requests hit the remote-stream path. */
vi.mock('../../services/mediaCache/oxyMediaStore', () => ({
  isMediaCacheEnabled: () => false,
  resolveOxyDownloadUrl: vi.fn(),
}));

const fetchUpstreamFollowingRedirects = vi.fn();
vi.mock('../../utils/safeUpstreamFetch', async () => {
  const actual = await vi.importActual<typeof import('../../utils/safeUpstreamFetch')>(
    '../../utils/safeUpstreamFetch',
  );
  return {
    ...actual,
    fetchUpstreamFollowingRedirects: (...args: unknown[]) => fetchUpstreamFollowingRedirects(...args),
  };
});

const isNegativelyCached = vi.fn().mockResolvedValue(false);
const markNegativelyCached = vi.fn().mockResolvedValue(undefined);
vi.mock('../../services/mediaCache/negativeCache', () => ({
  isNegativelyCached: (...args: unknown[]) => isNegativelyCached(...args),
  markNegativelyCached: (...args: unknown[]) => markNegativelyCached(...args),
}));

import mediaRoutes from '../../routes/media';

const app = express();
app.use('/media', mediaRoutes);

const REMOTE = 'https://remote.example/media/asset';

/** A non-streaming fake upstream response (used for reject-before-stream cases). */
function fakeResponse(statusCode: number, headers: Record<string, string> = {}) {
  const response = new EventEmitter() as EventEmitter & {
    statusCode: number;
    headers: Record<string, string>;
    destroyed: boolean;
    resume: () => void;
    destroy: () => void;
    setTimeout: () => void;
    pipe: () => void;
  };
  response.statusCode = statusCode;
  response.headers = headers;
  response.destroyed = false;
  response.resume = vi.fn();
  response.destroy = vi.fn(() => {
    response.destroyed = true;
  });
  response.setTimeout = vi.fn();
  response.pipe = vi.fn();
  return response;
}

/** A REAL streaming upstream response so `response.pipe(res)` flows actual bytes. */
function streamingResponse(statusCode: number, headers: Record<string, string>, body: Buffer) {
  const stream = Readable.from([body]) as Readable & {
    statusCode: number;
    headers: Record<string, string>;
    setTimeout: () => void;
  };
  stream.statusCode = statusCode;
  stream.headers = headers;
  stream.setTimeout = (): void => {};
  return stream;
}

beforeEach(() => {
  fetchUpstreamFollowingRedirects.mockReset();
  isNegativelyCached.mockReset().mockResolvedValue(false);
  markNegativelyCached.mockReset().mockResolvedValue(undefined);
});

describe('GET /media/proxy — content-type allowlist (Mention-only protection)', () => {
  it('rejects an SVG upstream with 415 and destroys the stream', async () => {
    const upstream = fakeResponse(200, { 'content-type': 'image/svg+xml' });
    fetchUpstreamFollowingRedirects.mockResolvedValue({ response: upstream, finalUrl: REMOTE });

    const res = await request(app).get('/media/proxy').query({ url: REMOTE });

    expect(res.status).toBe(415);
    expect(upstream.destroyed).toBe(true);
  });

  it('rejects a non-media (text/html) upstream with 415', async () => {
    const upstream = fakeResponse(200, { 'content-type': 'text/html; charset=utf-8' });
    fetchUpstreamFollowingRedirects.mockResolvedValue({ response: upstream, finalUrl: REMOTE });

    const res = await request(app).get('/media/proxy').query({ url: REMOTE });

    expect(res.status).toBe(415);
    expect(upstream.destroyed).toBe(true);
  });

  it('rejects an application/octet-stream (unknown) upstream with 415', async () => {
    const upstream = fakeResponse(200, { 'content-type': 'application/octet-stream' });
    fetchUpstreamFollowingRedirects.mockResolvedValue({ response: upstream, finalUrl: REMOTE });

    const res = await request(app).get('/media/proxy').query({ url: REMOTE });

    expect(res.status).toBe(415);
  });
});

describe('GET /media/proxy — serves a real image with range support', () => {
  it('relays a 206 partial image body with range headers for a Range request', async () => {
    const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG SOI marker prefix
    const upstream = streamingResponse(
      206,
      {
        'content-type': 'image/jpeg',
        'content-range': 'bytes 0-3/10',
        'content-length': '4',
        'accept-ranges': 'bytes',
      },
      imageBytes,
    );
    fetchUpstreamFollowingRedirects.mockResolvedValue({ response: upstream, finalUrl: REMOTE });

    const res = await request(app)
      .get('/media/proxy')
      .set('Range', 'bytes=0-3')
      .query({ url: REMOTE })
      .buffer(true)
      .parse((response, cb) => {
        const chunks: Buffer[] = [];
        response.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        response.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(206);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['content-range']).toBe('bytes 0-3/10');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // The real image bytes were streamed through the proxy unchanged.
    expect(Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body)).toEqual(imageBytes);
    // The Range header was forwarded to the upstream.
    const [, extras] = fetchUpstreamFollowingRedirects.mock.calls[0];
    expect(extras).toMatchObject({ range: 'bytes=0-3' });
  });

  it('serves a full (200) image body and advertises Accept-Ranges', async () => {
    const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]);
    const upstream = streamingResponse(
      200,
      { 'content-type': 'image/jpeg', 'content-length': String(imageBytes.length) },
      imageBytes,
    );
    fetchUpstreamFollowingRedirects.mockResolvedValue({ response: upstream, finalUrl: REMOTE });

    const res = await request(app)
      .get('/media/proxy')
      .query({ url: REMOTE })
      .buffer(true)
      .parse((response, cb) => {
        const chunks: Buffer[] = [];
        response.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        response.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body)).toEqual(imageBytes);
  });
});
