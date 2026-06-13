import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';

/**
 * Stub the Redis-backed rate limiter store so the limiter is an in-process
 * no-op (these tests exercise the SSRF guard + content-type gate, not limits).
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
 * Hard-stub the ffmpeg-driven extractor. If the SSRF guard is working, the
 * private-URL test rejects with 403 BEFORE any upstream fetch — so this stub
 * must never be reached for that case. Asserting it is never called proves the
 * request was rejected at the guard, not after touching the network/ffmpeg.
 */
const extractPosterFrame = vi.fn();
vi.mock('../../utils/videoPoster', () => ({
  extractPosterFrame: (...args: unknown[]) => extractPosterFrame(...args),
}));

import mediaRoutes from '../../routes/media';

const app = express();
app.use('/media', mediaRoutes);

describe('GET /media/poster — SSRF guard', () => {
  it('rejects a private/loopback target with 403 and never fetches or runs ffmpeg', async () => {
    extractPosterFrame.mockClear();
    const res = await request(app)
      .get('/media/poster')
      .query({ url: 'http://127.0.0.1/secret.mp4' });

    expect(res.status).toBe(403);
    expect(extractPosterFrame).not.toHaveBeenCalled();
  });

  it('rejects the cloud-metadata IP with 403', async () => {
    extractPosterFrame.mockClear();
    const res = await request(app)
      .get('/media/poster')
      .query({ url: 'http://169.254.169.254/latest/meta-data/' });

    expect(res.status).toBe(403);
    expect(extractPosterFrame).not.toHaveBeenCalled();
  });

  it('rejects a non-http(s) protocol (e.g. file://) with 403', async () => {
    extractPosterFrame.mockClear();
    const res = await request(app)
      .get('/media/poster')
      .query({ url: 'file:///etc/passwd' });

    expect(res.status).toBe(403);
    expect(extractPosterFrame).not.toHaveBeenCalled();
  });

  it('returns 400 when the url query parameter is missing', async () => {
    const res = await request(app).get('/media/poster');
    expect(res.status).toBe(400);
  });
});
