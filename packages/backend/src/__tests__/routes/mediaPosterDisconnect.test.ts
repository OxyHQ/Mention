import express from 'express';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Keep the media cache front inert so the tests hit on-demand extraction. */
vi.mock('../../services/mediaCache/oxyMediaStore', () => ({
  isMediaCacheEnabled: () => false,
  resolveOxyDownloadUrl: vi.fn(),
}));

/** In-process no-op rate limiter store. */
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

const extractPosterFrame = vi.fn();
vi.mock('../../utils/videoPoster', () => ({
  extractPosterFrame: (...args: unknown[]) => extractPosterFrame(...args),
}));

const fetchUpstreamFollowingRedirects = vi.fn();
vi.mock('../../utils/safeUpstreamFetch', async () => {
  const actual = await vi.importActual<typeof import('../../utils/safeUpstreamFetch.js')>(
    '../../utils/safeUpstreamFetch',
  );
  return {
    ...actual,
    fetchUpstreamFollowingRedirects: (...args: unknown[]) => fetchUpstreamFollowingRedirects(...args),
  };
});

import mediaRoutes from '../../routes/media';

const REMOTE = 'https://remote.example/video.mp4';

type FakeVideoResponse = EventEmitter & {
  statusCode: number;
  headers: Record<string, string>;
  destroyed: boolean;
  resume: () => void;
  destroy: () => void;
  setTimeout: () => void;
  /**
   * Resolves once the route has started reading this body — the point from which
   * a client disconnect is supposed to tear the upstream down.
   *
   * `readBoundedPrefix` arms the upstream idle timeout as its very first act, and
   * everything from the upstream fetch resolving through
   * `deadline.setActiveResponse(response)` to that call runs in ONE synchronous
   * continuation. So this firing means the deadline has already been handed the
   * response and can destroy it.
   */
  readingStarted: Promise<void>;
};

function fakeVideoResponse(): FakeVideoResponse {
  let signalReadingStarted: () => void = () => undefined;
  const readingStarted = new Promise<void>((resolve) => {
    signalReadingStarted = resolve;
  });

  const response = new EventEmitter() as FakeVideoResponse;
  response.statusCode = 200;
  response.headers = { 'content-type': 'video/mp4' };
  response.destroyed = false;
  response.resume = vi.fn();
  response.setTimeout = vi.fn(() => signalReadingStarted());
  response.destroy = vi.fn(() => {
    if (response.destroyed) return;
    response.destroyed = true;
    queueMicrotask(() => response.emit('error', new Error('upstream aborted')));
  });
  response.readingStarted = readingStarted;
  return response;
}

describe('GET /media/poster — client disconnect cleanup', () => {
  let server: http.Server | undefined;

  beforeEach(() => {
    fetchUpstreamFollowingRedirects.mockReset();
    extractPosterFrame.mockReset();
  });

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  });

  it('aborts the upstream response and skips ffmpeg when the requester disconnects', async () => {
    const upstreamResponse = fakeVideoResponse();
    let capturedSignal: AbortSignal | undefined;
    fetchUpstreamFollowingRedirects.mockImplementation(
      async (_url: string, _extras: unknown, signal: AbortSignal) => {
        capturedSignal = signal;
        return { response: upstreamResponse, finalUrl: REMOTE };
      },
    );

    const app = express();
    app.use('/media', mediaRoutes);
    server = app.listen(0);
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');

    const req = http.get(
      {
        port: address.port,
        path: `/media/poster?url=${encodeURIComponent(REMOTE)}`,
      },
      (res) => res.resume(),
    );
    req.on('error', () => undefined);

    // Disconnect only once the route is genuinely reading the upstream body.
    // A fixed timer here is a race the test can LOSE PERMANENTLY: on a loaded
    // machine the client can tear the connection down before the server has even
    // routed the request, so the route never runs, `capturedSignal` is never
    // assigned, and no amount of waiting below can recover — the assertion reads
    // `undefined` instead of `true`.
    await upstreamResponse.readingStarted;
    req.destroy();

    await vi.waitFor(() => {
      expect(capturedSignal?.aborted).toBe(true);
      expect(upstreamResponse.destroy).toHaveBeenCalled();
    });
    expect(extractPosterFrame).not.toHaveBeenCalled();
  });
});
