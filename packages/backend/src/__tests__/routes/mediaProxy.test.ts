import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * In-process no-op rate limiter store (these tests exercise status mapping and
 * the negative-cache short-circuit, not rate limiting).
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

/**
 * The route validates the caller-supplied URL with the real core SSRF guard
 * before touching cache state, which would resolve DNS for the fake test hosts.
 * Stub only `assertSafePublicUrl`; everything else in the module stays real.
 */
const assertSafePublicUrl = vi.fn();
vi.mock('@oxyhq/core/server', async () => {
  const actual = await vi.importActual<typeof import('@oxyhq/core/server')>('@oxyhq/core/server');
  return {
    ...actual,
    assertSafePublicUrl: (...args: unknown[]) => assertSafePublicUrl(...args),
  };
});

const cacheStore = vi.hoisted(() => ({
  lookupCacheRow: vi.fn(),
  bumpAccess: vi.fn(),
  recordAccessAndMaybeEnqueue: vi.fn(),
}));
vi.mock('../../services/mediaCache/cacheStore', () => ({
  lookupCacheRow: (...args: unknown[]) => cacheStore.lookupCacheRow(...args),
  bumpAccess: (...args: unknown[]) => cacheStore.bumpAccess(...args),
  recordAccessAndMaybeEnqueue: (...args: unknown[]) => cacheStore.recordAccessAndMaybeEnqueue(...args),
}));

/**
 * The service client, built from the REAL SDK.
 *
 * The URL a cached object is served from is not this suite's invention: it is
 * whatever `OxyServices.getFileDownloadUrl` produces. Stubbing that with a
 * hand-written string is how the previous version of these tests asserted a
 * redirect production never once performed — the resolver they stood in for
 * failed 481 times out of 481 against the live API.
 */
vi.mock('../../utils/oxyHelpers', async () => {
  const { OxyServices } = await vi.importActual<typeof import('@oxyhq/core')>('@oxyhq/core');
  const client = new OxyServices({ baseURL: 'http://oxy.test' });
  return { getServiceOxyClient: () => client };
});

/**
 * Cache front inert by default so most tests hit the remote-stream path. Only
 * the enablement flag is stubbed; the URL builder stays real.
 */
const mediaCacheEnabled = vi.hoisted(() => ({ value: false }));
vi.mock('../../services/mediaCache/oxyMediaStore', async () => {
  const actual = await vi.importActual<typeof import('../../services/mediaCache/oxyMediaStore')>(
    '../../services/mediaCache/oxyMediaStore',
  );
  return { ...actual, isMediaCacheEnabled: () => mediaCacheEnabled.value };
});

/**
 * Control the upstream response. Each test sets `nextStatus`; the mock returns a
 * minimal IncomingMessage-like EventEmitter with that status code.
 */
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

/** Control the negative cache (defaults: miss + no-op write). */
const isNegativelyCached = vi.fn().mockResolvedValue(false);
const markNegativelyCached = vi.fn().mockResolvedValue(undefined);
vi.mock('../../services/mediaCache/negativeCache', () => ({
  isNegativelyCached: (...args: unknown[]) => isNegativelyCached(...args),
  markNegativelyCached: (...args: unknown[]) => markNegativelyCached(...args),
}));

import mediaRoutes from '../../routes/media';
import { logger } from '../../utils/logger';

const app = express();
app.use('/media', mediaRoutes);

/** Build a fake non-redirect upstream response with the given status/headers. */
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

/**
 * A REAL streaming upstream response, needed whenever a test lets the route reach
 * `response.pipe(res)` — the `fakeResponse` above never emits `end`, so piping it
 * would hang the request.
 */
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

const REMOTE = 'https://remote.example/media/cat.jpg';

/** What the (mocked) Oxy store resolves a cached object to. */
const OXY_CDN_URL = 'https://cloud.oxy.so/oxyfile123';

/** What the stubbed core guard returns for an allowed URL. */
const ALLOWED_GUARD = { ok: true, ip: '203.0.113.10', family: 4 } as const;

beforeEach(() => {
  mediaCacheEnabled.value = false;
  assertSafePublicUrl.mockReset().mockResolvedValue(ALLOWED_GUARD);
  cacheStore.lookupCacheRow.mockReset().mockResolvedValue(undefined);
  cacheStore.bumpAccess.mockReset().mockResolvedValue(undefined);
  cacheStore.recordAccessAndMaybeEnqueue.mockReset().mockResolvedValue(true);
});

describe('GET /media/proxy — upstream status mapping', () => {
  beforeEach(() => {
    fetchUpstreamFollowingRedirects.mockReset();
    isNegativelyCached.mockReset().mockResolvedValue(false);
    markNegativelyCached.mockReset().mockResolvedValue(undefined);
  });

  it('maps an upstream 403 to our 404 (not 502) and negative-caches it', async () => {
    fetchUpstreamFollowingRedirects.mockResolvedValue({ response: fakeResponse(403), finalUrl: REMOTE });

    const res = await request(app).get('/media/proxy').query({ url: REMOTE });

    expect(res.status).toBe(404);
    expect(markNegativelyCached).toHaveBeenCalledWith(REMOTE, 'client-error');
  });

  it('maps an upstream 404 to our 404 and negative-caches it', async () => {
    fetchUpstreamFollowingRedirects.mockResolvedValue({ response: fakeResponse(404), finalUrl: REMOTE });

    const res = await request(app).get('/media/proxy').query({ url: REMOTE });

    expect(res.status).toBe(404);
    expect(markNegativelyCached).toHaveBeenCalledWith(REMOTE, 'client-error');
  });

  it('maps an upstream 410 (gone) to our 404', async () => {
    fetchUpstreamFollowingRedirects.mockResolvedValue({ response: fakeResponse(410), finalUrl: REMOTE });

    const res = await request(app).get('/media/proxy').query({ url: REMOTE });

    expect(res.status).toBe(404);
    expect(markNegativelyCached).toHaveBeenCalledWith(REMOTE, 'client-error');
  });

  it('maps a genuine upstream 500 to 502 and does NOT negative-cache it', async () => {
    fetchUpstreamFollowingRedirects.mockResolvedValue({ response: fakeResponse(500), finalUrl: REMOTE });

    const res = await request(app).get('/media/proxy').query({ url: REMOTE });

    expect(res.status).toBe(502);
    expect(markNegativelyCached).not.toHaveBeenCalled();
  });

  it('maps a genuine upstream 503 to 502 and does NOT negative-cache it', async () => {
    fetchUpstreamFollowingRedirects.mockResolvedValue({ response: fakeResponse(503), finalUrl: REMOTE });

    const res = await request(app).get('/media/proxy').query({ url: REMOTE });

    expect(res.status).toBe(502);
    expect(markNegativelyCached).not.toHaveBeenCalled();
  });

  it('short-circuits to 404 from the negative cache without fetching upstream', async () => {
    isNegativelyCached.mockResolvedValue(true);

    const res = await request(app).get('/media/proxy').query({ url: REMOTE });

    expect(res.status).toBe(404);
    expect(fetchUpstreamFollowingRedirects).not.toHaveBeenCalled();
  });

  it('negative-caches a connection failure as connection-error and returns 502', async () => {
    fetchUpstreamFollowingRedirects.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await request(app).get('/media/proxy').query({ url: REMOTE });

    expect(res.status).toBe(502);
    expect(markNegativelyCached).toHaveBeenCalledWith(REMOTE, 'connection-error');
  });

  it('rejects an over-large declared body with 413 (not 502)', async () => {
    const huge = String(512 * 1024 * 1024);
    fetchUpstreamFollowingRedirects.mockResolvedValue({
      response: fakeResponse(200, { 'content-type': 'image/jpeg', 'content-length': huge }),
      finalUrl: REMOTE,
    });

    const res = await request(app).get('/media/proxy').query({ url: REMOTE });

    expect(res.status).toBe(413);
  });

  it('does NOT negative-cache request-specific 400 responses', async () => {
    fetchUpstreamFollowingRedirects.mockResolvedValue({ response: fakeResponse(400), finalUrl: REMOTE });

    const res = await request(app).get('/media/proxy').set('Range', 'bytes=not-a-range').query({ url: REMOTE });

    expect(res.status).toBe(404);
    expect(markNegativelyCached).not.toHaveBeenCalled();
  });

  it('does NOT negative-cache transient upstream 429 responses', async () => {
    fetchUpstreamFollowingRedirects.mockResolvedValue({ response: fakeResponse(429), finalUrl: REMOTE });

    const res = await request(app).get('/media/proxy').query({ url: REMOTE });

    expect(res.status).toBe(404);
    expect(markNegativelyCached).not.toHaveBeenCalled();
  });

  it('does NOT negative-cache 4xx responses to ranged requests', async () => {
    fetchUpstreamFollowingRedirects.mockResolvedValue({ response: fakeResponse(403), finalUrl: REMOTE });

    const res = await request(app).get('/media/proxy').set('Range', 'bytes=0-1').query({ url: REMOTE });

    expect(res.status).toBe(404);
    expect(markNegativelyCached).not.toHaveBeenCalled();
  });

  it('does NOT negative-cache 4xx responses to conditional requests', async () => {
    fetchUpstreamFollowingRedirects.mockResolvedValue({ response: fakeResponse(404), finalUrl: REMOTE });

    const res = await request(app).get('/media/proxy').set('If-None-Match', '"stale"').query({ url: REMOTE });

    expect(res.status).toBe(404);
    expect(markNegativelyCached).not.toHaveBeenCalled();
  });

  it('does NOT use the URL-only negative cache for ranged requests', async () => {
    isNegativelyCached.mockResolvedValue(true);
    fetchUpstreamFollowingRedirects.mockResolvedValue({ response: fakeResponse(416), finalUrl: REMOTE });

    const res = await request(app).get('/media/proxy').set('Range', 'bytes=999-1000').query({ url: REMOTE });

    expect(res.status).toBe(416);
    expect(isNegativelyCached).not.toHaveBeenCalled();
    expect(fetchUpstreamFollowingRedirects).toHaveBeenCalled();
  });

  it('relays a 416 range-not-satisfiable as 416', async () => {
    fetchUpstreamFollowingRedirects.mockResolvedValue({
      response: fakeResponse(416, { 'content-range': 'bytes */1024' }),
      finalUrl: REMOTE,
    });

    const res = await request(app).get('/media/proxy').query({ url: REMOTE });

    expect(res.status).toBe(416);
    expect(markNegativelyCached).not.toHaveBeenCalled();
  });
});

/**
 * The cache front keys `FederatedMediaCache` rows on the caller-supplied string
 * and UPSERTS a `pending` row for any URL it has not seen. Nothing in the media
 * cache ever deletes a row (eviction drops the S3 object and keeps the row), so
 * an unauthenticated caller reaching the cache store with an arbitrary string is
 * a durable write primitive — and each junk row also consumes worker slots and
 * four backoff-spaced fetch attempts, starving genuine federated media.
 *
 * These assert the guard runs BEFORE any of that, with the cache ENABLED (the
 * only configuration in which the cache front is reachable — it is production's,
 * via `FEDERATION_MEDIA_CACHE_WRITE_ENABLED`).
 */
describe('GET /media/proxy — URL validated before any cache write', () => {
  beforeEach(() => {
    mediaCacheEnabled.value = true;
    fetchUpstreamFollowingRedirects.mockReset();
    isNegativelyCached.mockReset().mockResolvedValue(false);
    markNegativelyCached.mockReset().mockResolvedValue(undefined);
  });

  it('rejects a blocked URL with 403 without reaching the cache store', async () => {
    assertSafePublicUrl.mockResolvedValue({ ok: false, reason: 'blocked private address' });

    const res = await request(app).get('/media/proxy').query({ url: 'http://127.0.0.1/internal' });

    expect(res.status).toBe(403);
    expect(cacheStore.recordAccessAndMaybeEnqueue).not.toHaveBeenCalled();
    expect(cacheStore.lookupCacheRow).not.toHaveBeenCalled();
    expect(cacheStore.bumpAccess).not.toHaveBeenCalled();
    expect(fetchUpstreamFollowingRedirects).not.toHaveBeenCalled();
  });

  it('rejects a non-URL garbage string without reaching the cache store', async () => {
    assertSafePublicUrl.mockResolvedValue({ ok: false, reason: 'invalid url' });

    const res = await request(app).get('/media/proxy').query({ url: 'not-a-url-@@@' });

    expect(res.status).toBe(403);
    expect(cacheStore.recordAccessAndMaybeEnqueue).not.toHaveBeenCalled();
    expect(cacheStore.lookupCacheRow).not.toHaveBeenCalled();
  });

  it('rejects a blocked URL on a RANGED request too (the ranged branch also enqueues)', async () => {
    assertSafePublicUrl.mockResolvedValue({ ok: false, reason: 'blocked private address' });

    const res = await request(app)
      .get('/media/proxy')
      .set('Range', 'bytes=0-1')
      .query({ url: 'http://169.254.169.254/latest/meta-data' });

    expect(res.status).toBe(403);
    expect(cacheStore.recordAccessAndMaybeEnqueue).not.toHaveBeenCalled();
  });

  it('still records access and streams for an allowed URL', async () => {
    const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    fetchUpstreamFollowingRedirects.mockResolvedValue({
      response: streamingResponse(200, { 'content-type': 'image/jpeg' }, imageBytes),
      finalUrl: REMOTE,
    });

    const res = await request(app).get('/media/proxy').query({ url: REMOTE });

    expect(res.status).toBe(200);
    expect(cacheStore.recordAccessAndMaybeEnqueue).toHaveBeenCalledWith(REMOTE);
  });

  it('resolves DNS exactly ONCE per request by handing hop 0 the validated guard', async () => {
    fetchUpstreamFollowingRedirects.mockResolvedValue({
      response: streamingResponse(200, { 'content-type': 'image/jpeg' }, Buffer.from([0xff, 0xd8])),
      finalUrl: REMOTE,
    });

    await request(app).get('/media/proxy').query({ url: REMOTE });

    // The route validated once...
    expect(assertSafePublicUrl).toHaveBeenCalledTimes(1);
    // ...and passed that exact result through so the transport skips hop 0's
    // resolution instead of dialling DNS a second time on a 240 req/min endpoint.
    expect(fetchUpstreamFollowingRedirects).toHaveBeenCalledWith(
      REMOTE,
      expect.anything(),
      expect.anything(),
      ALLOWED_GUARD,
    );
  });
});

/**
 * `?variant=` lets a caller ask for a SIZED render of a remote image, which is
 * what stops a feed card from downloading a multi-megabyte original to fill a
 * ≤320px box (`mediaResolver` emits it on `thumbUrl`/`fullUrl` for federated
 * media). The route never resizes anything itself — the resize belongs to Oxy's
 * existing image pipeline — so the parameter is honoured by appending it to the
 * `cloud.oxy.so` redirect once the bytes are mirrored, and ignored until then.
 */
describe('GET /media/proxy — sized variants', () => {
  beforeEach(() => {
    mediaCacheEnabled.value = true;
    fetchUpstreamFollowingRedirects.mockReset();
    isNegativelyCached.mockReset().mockResolvedValue(false);
    markNegativelyCached.mockReset().mockResolvedValue(undefined);
  });

  it('redirects a cached image to the SIZED Oxy render when a variant is asked for', async () => {
    cacheStore.lookupCacheRow.mockResolvedValue({
      state: 'cached',
      oxyFileId: 'oxyfile123',
      contentType: 'image/png',
    });

    const res = await request(app).get('/media/proxy').query({ url: REMOTE, variant: 'w320' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${OXY_CDN_URL}?variant=w320`);
    expect(fetchUpstreamFollowingRedirects).not.toHaveBeenCalled();
  });

  /**
   * The redirect must cost NO call to oxy-api.
   *
   * This is the whole defect. Serving a mirrored object used to ask
   * `GET /assets/:id/url` for its URL, and that route is behind oxy-api's
   * `authMiddleware`, which rejects any token without a `sessionId` claim — which
   * a service token has never had. Six hours of production traffic: 481 cache
   * fronts, 481 failed Oxy calls, ~4ms each. Every one of them fell through to
   * streaming the bytes from the third-party host, and the ones whose host was
   * already known-dead were answered 404: "Video unavailable" for media we hold.
   *
   * A public asset needs no permission to be named, so nothing is asked.
   */
  it('serves the mirrored copy without calling oxy-api at all', async () => {
    cacheStore.lookupCacheRow.mockResolvedValue({
      state: 'cached',
      oxyFileId: 'oxyfile123',
      contentType: 'video/mp4',
    });
    const warn = vi.spyOn(logger, 'warn');

    const res = await request(app).get('/media/proxy').query({ url: REMOTE });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(OXY_CDN_URL);
    // No upstream stream, and no cache-front failure: the fallback never ran.
    expect(fetchUpstreamFollowingRedirects).not.toHaveBeenCalled();
    expect(
      warn.mock.calls.some(([message]) => String(message).includes('[MediaProxy] Cache front failed')),
    ).toBe(false);
    warn.mockRestore();
  });

  it('redirects to the un-sized original when no variant is asked for', async () => {
    cacheStore.lookupCacheRow.mockResolvedValue({
      state: 'cached',
      oxyFileId: 'oxyfile123',
      contentType: 'image/png',
    });

    const res = await request(app).get('/media/proxy').query({ url: REMOTE });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(OXY_CDN_URL);
  });

  it('ignores a variant on cached NON-image media', async () => {
    // Oxy's variant taxonomy is an image one; `w320` of an mp4 is meaningless.
    // `resolveMediaRef` cannot make this call (it resolves a bare reference with
    // no type beside it), so the guard has to live where the type is known.
    cacheStore.lookupCacheRow.mockResolvedValue({
      state: 'cached',
      oxyFileId: 'oxyfile123',
      contentType: 'video/mp4',
    });

    const res = await request(app).get('/media/proxy').query({ url: REMOTE, variant: 'w320' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(OXY_CDN_URL);
  });

  it('never forwards an unrecognised variant to our CDN', async () => {
    // The value is appended to a cloud.oxy.so URL, so an unvalidated one would
    // let any caller mint arbitrary query strings against our own CDN.
    cacheStore.lookupCacheRow.mockResolvedValue({
      state: 'cached',
      oxyFileId: 'oxyfile123',
      contentType: 'image/png',
    });

    for (const variant of ['../../etc', 'w9999', 'hls_master', '', 'w320&x=1']) {
      const res = await request(app).get('/media/proxy').query({ url: REMOTE, variant });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(OXY_CDN_URL);
    }
  });

  it('streams the original but only BRIEFLY caches it when a variant cannot be served', async () => {
    // Cache miss: we cannot produce the sized render, so the original is served
    // in its place. That response must expire quickly — caching it for a day
    // under a `variant` URL would pin the client to the full-size bytes long
    // after the mirror landed, turning a temporary miss into a permanent one.
    cacheStore.lookupCacheRow.mockResolvedValue(undefined);
    fetchUpstreamFollowingRedirects.mockResolvedValue({
      response: streamingResponse(200, { 'content-type': 'image/jpeg' }, Buffer.from([0xff, 0xd8])),
      finalUrl: REMOTE,
    });

    const res = await request(app).get('/media/proxy').query({ url: REMOTE, variant: 'w320' });

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.headers['cache-control']).not.toContain('immutable');
    // ...and the miss still enqueues the mirror that will satisfy the next one.
    expect(cacheStore.recordAccessAndMaybeEnqueue).toHaveBeenCalledWith(REMOTE);
  });

  it('keeps the long immutable cache directive for a plain (variant-less) stream', async () => {
    cacheStore.lookupCacheRow.mockResolvedValue(undefined);
    fetchUpstreamFollowingRedirects.mockResolvedValue({
      response: streamingResponse(200, { 'content-type': 'image/jpeg' }, Buffer.from([0xff, 0xd8])),
      finalUrl: REMOTE,
    });

    const res = await request(app).get('/media/proxy').query({ url: REMOTE });

    expect(res.headers['cache-control']).toBe('public, max-age=86400, immutable');
  });
});
