import express from 'express';
import request from 'supertest';
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

const { assetUploadMock, uploadServiceUserMediaMock, importUserMediaMock } = vi.hoisted(() => ({
  assetUploadMock: vi.fn(),
  uploadServiceUserMediaMock: vi.fn(),
  importUserMediaMock: vi.fn(),
}));
vi.mock('@oxy.so/core', async () => {
  const actual = await vi.importActual<typeof import('@oxy.so/core')>('@oxy.so/core');
  return {
    ...actual,
    OxyServices: class MockOxyServices {
      session = { setAccessToken(): void {} };
      assets = { upload: assetUploadMock };
    },
  };
});

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    assets: { metadataByIds: vi.fn().mockResolvedValue([]), importUserMedia: importUserMediaMock },
  }),
  requesterFiles: () => ({ importUserMedia: importUserMediaMock }),
  uploadServiceUserMedia: (...args: unknown[]) => uploadServiceUserMediaMock(...args),
}));

import intentMediaRoutes from '../../routes/intentMedia';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as express.Request & { user?: { id: string }; accessToken?: string }).user = {
    id: 'user-1',
  };
  (req as express.Request & { accessToken?: string }).accessToken = 'test-token';
  next();
});
app.use('/', intentMediaRoutes);

describe('POST /posts/intent-media', () => {
  beforeEach(() => {
    importUserMediaMock.mockReset();
    assetUploadMock.mockReset();
    uploadServiceUserMediaMock.mockReset();
    assetUploadMock.mockResolvedValue({ file: { id: 'oxy-file-1' } });
    uploadServiceUserMediaMock.mockResolvedValue({
      fileId: 'mcp-file-1',
      contentType: 'image/png',
    });
  });

  it('uploads via service path when MCP context is present', async () => {
    const mcpApp = express();
    mcpApp.use(express.json());
    mcpApp.use((req, _res, next) => {
      const r = req as express.Request & { user?: { id: string }; mcp?: { activeUserId: string } };
      r.user = { id: 'user-mcp' };
      r.mcp = { activeUserId: 'user-mcp' } as { activeUserId: string };
      next();
    });
    mcpApp.use('/', intentMediaRoutes);

    const png = Buffer.from('PNG!');
    const res = await request(mcpApp)
      .post('/')
      .send({ base64: png.toString('base64'), mimeType: 'image/png', filename: 'x.png' });

    expect(res.status).toBe(200);
    expect(res.body.fileId).toBe('mcp-file-1');
    expect(uploadServiceUserMediaMock).toHaveBeenCalledTimes(1);
    expect(assetUploadMock).not.toHaveBeenCalled();
  });

  it('uploads via Oxy session when accessToken is present', async () => {
    const png = Buffer.from('PNG!');
    const res = await request(app)
      .post('/')
      .send({ base64: png.toString('base64'), mimeType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.fileId).toBe('oxy-file-1');
    expect(assetUploadMock).toHaveBeenCalledTimes(1);
    expect(uploadServiceUserMediaMock).not.toHaveBeenCalled();
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

  it("has Oxy import a URL into the user's own files, public", async () => {
    importUserMediaMock.mockResolvedValue({
      file: { id: 'imported-1', mime: 'image/jpeg', status: 'active' },
      outcome: 'downloaded',
    });

    const res = await request(app).post('/').send({ url: 'https://example.com/a.jpg' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ fileId: 'imported-1', contentType: 'image/jpeg' });
    expect(importUserMediaMock).toHaveBeenCalledWith('user-1', 'https://example.com/a.jpg', {
      visibility: 'public',
      signal: expect.any(AbortSignal),
    });
    // The bytes never pass through Mention.
    expect(assetUploadMock).not.toHaveBeenCalled();
    expect(uploadServiceUserMediaMock).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'INVALID_SOURCE_URL', 400],
    [422, 'SOURCE_URL_REFUSED', 403],
    [415, 'UNSUPPORTED_MEDIA_TYPE', 415],
    [413, 'PAYLOAD_TOO_LARGE', 413],
    [451, 'CONTENT_BLOCKED', 451],
    [502, 'SOURCE_FETCH_FAILED', 502],
    [504, 'SOURCE_FETCH_TIMEOUT', 502],
    [503, undefined, 502],
  ])('answers Oxy %i (%s) with %i', async (status, code, expected) => {
    importUserMediaMock.mockRejectedValue(Object.assign(new Error('refused'), { status, code }));

    const res = await request(app).post('/').send({ url: 'https://example.com/a.jpg' });

    expect(res.status).toBe(expected);
    expect(typeof res.body.error).toBe('string');
  });

  it('rejects oversized base64 before decode', async () => {
    const huge = 'A'.repeat(60_000_000);
    const res = await request(app).post('/').send({ base64: huge, mimeType: 'image/png' });

    expect(res.status).toBe(413);
    expect(assetUploadMock).not.toHaveBeenCalled();
    expect(uploadServiceUserMediaMock).not.toHaveBeenCalled();
  });

  it('rejects base64 SVG when mimeType has parameters', async () => {
    const svg = Buffer.from('<svg><script>alert(1)</script></svg>');
    const res = await request(app)
      .post('/')
      .send({ base64: svg.toString('base64'), mimeType: 'image/svg+xml;charset=utf-8' });

    expect(res.status).toBe(400);
    expect(assetUploadMock).not.toHaveBeenCalled();
    expect(uploadServiceUserMediaMock).not.toHaveBeenCalled();
  });

  it('canonicalizes base64 mimeType parameters before upload', async () => {
    const png = Buffer.from('PNG!');
    const res = await request(app)
      .post('/')
      .send({ base64: png.toString('base64'), mimeType: 'IMAGE/PNG; charset=binary' });

    expect(res.status).toBe(200);
    expect(res.body.contentType).toBe('image/png');
    expect(assetUploadMock).toHaveBeenCalledTimes(1);
    const uploadedFile = assetUploadMock.mock.calls[0]?.[0] as File | undefined;
    expect(uploadedFile?.type).toBe('image/png');
  });

  it('uploads post media public, because the CDN that renders it 404s a private asset', async () => {
    const res = await request(app)
      .post('/')
      .send({ base64: Buffer.from('PNG!').toString('base64'), mimeType: 'image/png' });

    expect(res.status).toBe(200);
    expect(assetUploadMock).toHaveBeenCalledWith(expect.any(File), { visibility: 'public' });
  });

  it('strips path traversal from filename on base64 upload', async () => {
    const png = Buffer.from('PNG!');
    const res = await request(app)
      .post('/')
      .send({
        base64: png.toString('base64'),
        mimeType: 'image/png',
        filename: '../../etc/passwd',
      });

    expect(res.status).toBe(200);
    expect(uploadServiceUserMediaMock).not.toHaveBeenCalled();
    expect(assetUploadMock).toHaveBeenCalledTimes(1);
    const uploadedFile = assetUploadMock.mock.calls[0]?.[0] as File | undefined;
    expect(uploadedFile?.name).toBe('passwd');
  });
});
