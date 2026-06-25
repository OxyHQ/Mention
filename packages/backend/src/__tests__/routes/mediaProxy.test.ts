import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'node:events';
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

/** Keep the media cache front inert so the tests hit the remote-stream path. */
vi.mock('../../services/mediaCache/oxyMediaStore', () => ({
  isMediaCacheEnabled: () => false,
  resolveOxyDownloadUrl: vi.fn(),
}));

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

const REMOTE = 'https://remote.example/media/cat.jpg';

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
