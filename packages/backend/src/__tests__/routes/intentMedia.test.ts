import express from 'express';
import request from 'supertest';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const { assetUploadMock } = vi.hoisted(() => ({
  assetUploadMock: vi.fn(),
}));
vi.mock('@oxyhq/core', async () => {
  const actual = await vi.importActual<typeof import('@oxyhq/core')>('@oxyhq/core');
  return {
    ...actual,
    OxyServices: class MockOxyServices {
      setTokens(): void {}
      assetUpload = assetUploadMock;
    },
  };
});

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getServiceAssetMetadataByIds: vi.fn().mockResolvedValue([]),
  }),
}));

import intentMediaRoutes from '../../routes/intentMedia';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as express.Request & { user?: { id: string }; accessToken?: string }).user = { id: 'user-1' };
  (req as express.Request & { accessToken?: string }).accessToken = 'test-token';
  next();
});
app.use('/', intentMediaRoutes);

function fakeImageResponse(body: Buffer): IncomingMessage {
  const stream = Readable.from([body]) as IncomingMessage;
  stream.statusCode = 200;
  stream.headers = { 'content-type': 'image/jpeg', 'content-length': String(body.length) };
  return stream;
}

describe('POST /posts/intent-media', () => {
  beforeEach(() => {
    fetchUpstreamFollowingRedirects.mockReset();
    assetUploadMock.mockReset();
  });

  it('returns 401 without auth user', async () => {
    const unauthApp = express();
    unauthApp.use(express.json());
    unauthApp.use('/', intentMediaRoutes);
    const res = await request(unauthApp).post('/').send({ url: 'https://example.com/a.jpg' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when url is missing', async () => {
    const res = await request(app).post('/').send({});
    expect(res.status).toBe(400);
  });

  it('rejects non-media content types with 415', async () => {
    const response = fakeImageResponse(Buffer.from('html'));
    response.headers = { 'content-type': 'text/html' };
    fetchUpstreamFollowingRedirects.mockResolvedValue({
      response,
      finalUrl: 'https://example.com/page.html',
    });

    const res = await request(app)
      .post('/')
      .send({ url: 'https://example.com/page.html' });

    expect(res.status).toBe(415);
    expect(assetUploadMock).not.toHaveBeenCalled();
  });
});
