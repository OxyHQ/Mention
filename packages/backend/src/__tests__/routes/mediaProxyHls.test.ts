import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `/media/proxy` serving an HLS playlist.
 *
 * Two things are load-bearing and both are asserted through the real route:
 * that a playlist content type is ACCEPTED at all (it used to 415, which is what
 * made every federated Bluesky video unplayable), and that what comes back is
 * REWRITTEN — a 200 carrying a playlist whose segments still point at the remote
 * CDN is not a fix, it just moves the failure into the player.
 */

/**
 * The playlist-component signature derives its key from the Oxy service secret,
 * which config reads at import time — so it has to be in place before any module
 * under test loads. `vi.hoisted` is the only hook that runs that early. The two
 * credentials must be set together or config rejects them.
 */
vi.hoisted(() => {
  process.env.OXY_SERVICE_API_KEY = 'test-service-key';
  process.env.OXY_SERVICE_API_SECRET = 'test-service-secret';
});

/** In-process no-op rate limiter store (rate limiting is not under test). */
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

/** Keep the media cache front inert so the tests hit the remote-fetch path. */
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

vi.mock('../../services/mediaCache/negativeCache', () => ({
  isNegativelyCached: vi.fn().mockResolvedValue(false),
  markNegativelyCached: vi.fn().mockResolvedValue(undefined),
}));

import mediaRoutes from '../../routes/media';
import { signHlsComponentUrl } from '../../utils/hlsSignature';

const app = express();
app.use('/media', mediaRoutes);

/**
 * A fake upstream response that actually delivers a body.
 *
 * The route attaches its `data`/`end` handlers immediately after calling
 * `setTimeout` on the response, so emitting from there (on the next macrotask)
 * reproduces the real ordering: bytes arrive once a consumer is listening.
 */
function fakeBodyResponse(statusCode: number, headers: Record<string, string>, body: string | Buffer) {
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
  // What `IncomingMessage.pipe` does: forward the body events to the response.
  response.pipe = vi.fn((destination: { write: (chunk: Buffer) => void; end: () => void }) => {
    response.on('data', (chunk: Buffer) => destination.write(chunk));
    response.on('end', () => destination.end());
  });
  response.setTimeout = vi.fn(() => {
    setImmediate(() => {
      if (response.destroyed) return;
      response.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'));
      response.emit('end');
    });
  });
  return response;
}

const HLS_CONTENT_TYPE = 'application/vnd.apple.mpegurl';
const PLAYLIST_URL = 'https://video.bsky.app/watch/did%3Aplc%3Aabc/cid/playlist.m3u8';

const MASTER_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-STREAM-INF:BANDWIDTH=987125,CODECS="avc1.4d401e,mp4a.40.2",RESOLUTION=360x640',
  '360p/video.m3u8?session_id=abc',
  '',
].join('\n');

const MEDIA_PLAYLIST = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXTINF:6.000,', 'video0.ts?session_id=abc', ''].join(
  '\n',
);

/**
 * The response body as text. Supertest only fills `.text` for content types it
 * recognises as textual, and the `audio/…`/`video/…` playlist spellings are not
 * among them — those arrive as a Buffer in `.body`.
 */
function bodyText(res: { text?: string; body: unknown }): string {
  if (typeof res.text === 'string') return res.text;
  return Buffer.isBuffer(res.body) ? res.body.toString('utf8') : '';
}

/** Every url the returned playlist would have a player fetch. */
function playableUris(res: { text?: string; body: unknown }): string[] {
  return bodyText(res)
    .split('\n')
    .filter((line) => line.trim().length > 0 && !line.startsWith('#'));
}

/** The upstream url behind each of those, with the proxy wrapper unwrapped. */
function proxiedTargets(res: { text?: string; body: unknown }): string[] {
  return playableUris(res).map((uri) => new URLSearchParams(uri.split('?')[1] ?? '').get('url') ?? '');
}

describe('GET /media/proxy — HLS playlists', () => {
  beforeEach(() => {
    fetchUpstreamFollowingRedirects.mockReset();
  });

  it('accepts an application/vnd.apple.mpegurl playlist instead of rejecting it as 415', async () => {
    fetchUpstreamFollowingRedirects.mockResolvedValue({
      response: fakeBodyResponse(200, { 'content-type': HLS_CONTENT_TYPE }, MEDIA_PLAYLIST),
      finalUrl: PLAYLIST_URL,
    });

    const res = await request(app).get('/media/proxy').query({ url: PLAYLIST_URL });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain(HLS_CONTENT_TYPE);
  });

  it.each([
    'application/x-mpegURL',
    'application/mpegurl',
    'audio/mpegurl',
    'audio/x-mpegurl',
    'video/x-mpegurl',
    'application/vnd.apple.mpegURL; charset=utf-8',
  ])('accepts and rewrites the %s spelling', async (contentType) => {
    fetchUpstreamFollowingRedirects.mockResolvedValue({
      response: fakeBodyResponse(200, { 'content-type': contentType }, MEDIA_PLAYLIST),
      finalUrl: PLAYLIST_URL,
    });

    const res = await request(app).get('/media/proxy').query({ url: PLAYLIST_URL });

    expect(res.status).toBe(200);
    expect(proxiedTargets(res)).toEqual([
      'https://video.bsky.app/watch/did%3Aplc%3Aabc/cid/video0.ts?session_id=abc',
    ]);
  });

  it('rewrites every segment url back through the proxy', async () => {
    fetchUpstreamFollowingRedirects.mockResolvedValue({
      response: fakeBodyResponse(200, { 'content-type': HLS_CONTENT_TYPE }, MEDIA_PLAYLIST),
      finalUrl: PLAYLIST_URL,
    });

    const res = await request(app).get('/media/proxy').query({ url: PLAYLIST_URL });

    const uris = playableUris(res);
    expect(uris).not.toHaveLength(0);
    for (const uri of uris) {
      expect(uri.startsWith('/media/proxy?url=')).toBe(true);
    }
    expect(bodyText(res)).not.toContain('video0.ts?session_id=abc\n');
  });

  it('rewrites the nested variant playlists of a master playlist', async () => {
    fetchUpstreamFollowingRedirects.mockResolvedValue({
      response: fakeBodyResponse(200, { 'content-type': HLS_CONTENT_TYPE }, MASTER_PLAYLIST),
      finalUrl: PLAYLIST_URL,
    });

    const res = await request(app).get('/media/proxy').query({ url: PLAYLIST_URL });

    expect(proxiedTargets(res)).toEqual([
      'https://video.bsky.app/watch/did%3Aplc%3Aabc/cid/360p/video.m3u8?session_id=abc',
    ]);
  });

  it('resolves relative URIs against the POST-REDIRECT url, not the requested one', async () => {
    fetchUpstreamFollowingRedirects.mockResolvedValue({
      response: fakeBodyResponse(200, { 'content-type': HLS_CONTENT_TYPE }, MEDIA_PLAYLIST),
      finalUrl: 'https://edge.bsky.app/redirected/cid/playlist.m3u8',
    });

    const res = await request(app).get('/media/proxy').query({ url: PLAYLIST_URL });

    expect(proxiedTargets(res)).toEqual(['https://edge.bsky.app/redirected/cid/video0.ts?session_id=abc']);
  });

  it('does not advertise range support on a body it generated', async () => {
    fetchUpstreamFollowingRedirects.mockResolvedValue({
      response: fakeBodyResponse(200, { 'content-type': HLS_CONTENT_TYPE, etag: '"upstream"' }, MEDIA_PLAYLIST),
      finalUrl: PLAYLIST_URL,
    });

    const res = await request(app).get('/media/proxy').query({ url: PLAYLIST_URL });

    expect(res.headers['accept-ranges']).toBe('none');
    // The upstream validator describes the ORIGINAL bytes; relaying it would let
    // a client revalidate a body we no longer serve.
    expect(res.headers.etag).not.toBe('"upstream"');
  });

  it('refetches the whole playlist when the upstream honoured a client Range', async () => {
    fetchUpstreamFollowingRedirects
      .mockResolvedValueOnce({
        response: fakeBodyResponse(206, { 'content-type': HLS_CONTENT_TYPE }, '#EXTM3U\n#EXTINF:6.0,\nvid'),
        finalUrl: PLAYLIST_URL,
      })
      .mockResolvedValueOnce({
        response: fakeBodyResponse(200, { 'content-type': HLS_CONTENT_TYPE }, MEDIA_PLAYLIST),
        finalUrl: PLAYLIST_URL,
      });

    const res = await request(app).get('/media/proxy').set('Range', 'bytes=0-20').query({ url: PLAYLIST_URL });

    expect(res.status).toBe(200);
    expect(fetchUpstreamFollowingRedirects).toHaveBeenCalledTimes(2);
    expect(proxiedTargets(res)).toEqual([
      'https://video.bsky.app/watch/did%3Aplc%3Aabc/cid/video0.ts?session_id=abc',
    ]);
  });

  it('rejects a body that is not a playlist despite the playlist content type', async () => {
    fetchUpstreamFollowingRedirects.mockResolvedValue({
      response: fakeBodyResponse(200, { 'content-type': HLS_CONTENT_TYPE }, '<!doctype html><html>nope</html>'),
      finalUrl: PLAYLIST_URL,
    });

    const res = await request(app).get('/media/proxy').query({ url: PLAYLIST_URL });

    expect(res.status).toBe(415);
  });

  it('signs the urls it emits, so segments can prove where they came from', async () => {
    fetchUpstreamFollowingRedirects.mockResolvedValue({
      response: fakeBodyResponse(200, { 'content-type': HLS_CONTENT_TYPE }, MEDIA_PLAYLIST),
      finalUrl: PLAYLIST_URL,
    });

    const res = await request(app).get('/media/proxy').query({ url: PLAYLIST_URL });

    const emitted = new URLSearchParams(playableUris(res)[0]?.split('?')[1] ?? '');
    const segment = emitted.get('url') ?? '';
    expect(segment).toContain('video0.ts');
    expect(emitted.get('hls')).toBe(signHlsComponentUrl(segment));
  });

  it('rejects an oversized playlist with 413 rather than buffering it', async () => {
    const oversized = Buffer.concat([Buffer.from('#EXTM3U\n'), Buffer.alloc(9 * 1024 * 1024, 0x61)]);
    fetchUpstreamFollowingRedirects.mockResolvedValue({
      response: fakeBodyResponse(200, { 'content-type': HLS_CONTENT_TYPE }, oversized),
      finalUrl: PLAYLIST_URL,
    });

    const res = await request(app).get('/media/proxy').query({ url: PLAYLIST_URL });

    expect(res.status).toBe(413);
  });
});

describe('GET /media/proxy — HLS segments served as application/octet-stream', () => {
  const SEGMENT_URL = 'https://video.cdn.bsky.app/hls/did:plc:abc/cid/720p/video0.ts';
  const SEGMENT_BYTES = Buffer.from('\x47segment-bytes', 'binary');

  beforeEach(() => {
    fetchUpstreamFollowingRedirects.mockReset();
    fetchUpstreamFollowingRedirects.mockResolvedValue({
      response: fakeBodyResponse(200, { 'content-type': 'application/octet-stream' }, SEGMENT_BYTES),
      finalUrl: SEGMENT_URL,
    });
  });

  it('relays the segment when the request carries a valid playlist-component signature', async () => {
    const res = await request(app)
      .get('/media/proxy')
      .query({ url: SEGMENT_URL, hls: signHlsComponentUrl(SEGMENT_URL) });

    expect(res.status).toBe(200);
  });

  it('still rejects an UNSIGNED octet-stream request — the proxy is not a binary relay', async () => {
    const res = await request(app).get('/media/proxy').query({ url: SEGMENT_URL });

    expect(res.status).toBe(415);
  });

  it('rejects a signature minted for a DIFFERENT url', async () => {
    const res = await request(app)
      .get('/media/proxy')
      .query({ url: SEGMENT_URL, hls: signHlsComponentUrl('https://elsewhere.example/other.ts') });

    expect(res.status).toBe(415);
  });

  it('does not let a signature widen the gate to active content types', async () => {
    fetchUpstreamFollowingRedirects.mockResolvedValue({
      response: fakeBodyResponse(200, { 'content-type': 'text/html' }, '<html>x</html>'),
      finalUrl: SEGMENT_URL,
    });

    const res = await request(app)
      .get('/media/proxy')
      .query({ url: SEGMENT_URL, hls: signHlsComponentUrl(SEGMENT_URL) });

    expect(res.status).toBe(415);
  });
});
