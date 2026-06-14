import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Verifies the federated media-cache → Oxy write boundary:
 *  - `uploadCachedMedia` POSTs to `/assets/service/cache`, attaches the
 *    SDK-managed service token as a bearer, sends `Content-Type`/`x-original-name`,
 *    STREAMS the temp file as the raw request body (no in-memory buffering), and
 *    returns `data.file.id` from the response.
 *  - `deleteCachedMedia` issues a DELETE to `/assets/service/cache/:id` with the
 *    service bearer.
 *
 * The oxy-api base URL is taken from the service client's `getBaseURL()` — never
 * hardcoded — and the service token from the client's `getServiceToken()`.
 */

// --- Force the write side ON for this suite (gated OFF by default in prod). ---
vi.mock('../../services/mediaCache/constants', () => ({
  MEDIA_CACHE_WRITE_ENABLED: true,
}));

const SERVICE_TOKEN = 'svc-token-xyz';
const OXY_BASE = 'http://oxy.test';
const getServiceToken = vi.fn<() => Promise<string>>().mockResolvedValue(SERVICE_TOKEN);
const getBaseURL = vi.fn<() => string>().mockReturnValue(OXY_BASE);
const invalidateServiceToken = vi.fn<() => void>();

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ getServiceToken, getBaseURL, invalidateServiceToken }),
}));

// --- Capture native HTTP requests + their streamed bodies. ---
interface CapturedRequest {
  options: {
    method: string;
    hostname: string;
    port: number | string;
    path: string;
    headers: Record<string, string>;
  };
  bodyChunks: Buffer[];
}

const requests: CapturedRequest[] = [];
let respond: (captured: CapturedRequest) => { statusCode: number; body: string } = () => ({
  statusCode: 200,
  body: JSON.stringify({ data: { file: { id: 'oxy_file_default' } } }),
});

/** A writable client request that records everything piped into it. */
class FakeClientRequest extends PassThrough {
  constructor(private readonly captured: CapturedRequest, private readonly onResponse: (res: Readable & { statusCode: number }) => void) {
    super();
    this.on('data', (chunk: Buffer) => this.captured.bodyChunks.push(chunk));
    this.on('finish', () => this.flushResponse());
  }
  setTimeout(): this {
    return this;
  }
  private flushResponse(): void {
    const { statusCode, body } = respond(this.captured);
    const res = new PassThrough() as PassThrough & { statusCode: number };
    res.statusCode = statusCode;
    this.onResponse(res);
    res.end(Buffer.from(body, 'utf8'));
  }
}

/** DELETE has no streamed body — `request.end()` triggers the response. */
class FakeBodylessRequest extends EventEmitter {
  constructor(private readonly captured: CapturedRequest, private readonly onResponse: (res: Readable & { statusCode: number }) => void) {
    super();
  }
  setTimeout(): this {
    return this;
  }
  destroy(): void {
    /* no-op for tests */
  }
  end(): void {
    const { statusCode, body } = respond(this.captured);
    const res = new PassThrough() as PassThrough & { statusCode: number };
    res.statusCode = statusCode;
    this.onResponse(res);
    res.end(Buffer.from(body, 'utf8'));
  }
}

function fakeRequest(
  options: CapturedRequest['options'],
  callback: (res: Readable & { statusCode: number }) => void,
): PassThrough | EventEmitter {
  const captured: CapturedRequest = { options, bodyChunks: [] };
  requests.push(captured);
  return options.method === 'DELETE'
    ? new FakeBodylessRequest(captured, callback)
    : new FakeClientRequest(captured, callback);
}

vi.mock('node:http', () => ({
  default: { request: (options: CapturedRequest['options'], cb: (res: Readable & { statusCode: number }) => void) => fakeRequest(options, cb) },
  request: (options: CapturedRequest['options'], cb: (res: Readable & { statusCode: number }) => void) => fakeRequest(options, cb),
}));
vi.mock('node:https', () => ({
  default: { request: (options: CapturedRequest['options'], cb: (res: Readable & { statusCode: number }) => void) => fakeRequest(options, cb) },
  request: (options: CapturedRequest['options'], cb: (res: Readable & { statusCode: number }) => void) => fakeRequest(options, cb),
}));

import { uploadCachedMedia, deleteCachedMedia, OxyMediaStoreRequestError } from '../../services/mediaCache/oxyMediaStore';

let workDir: string;

beforeEach(async () => {
  requests.length = 0;
  getServiceToken.mockClear();
  getBaseURL.mockClear();
  invalidateServiceToken.mockClear();
  respond = () => ({ statusCode: 200, body: JSON.stringify({ data: { file: { id: 'oxy_file_default' } } }) });
  workDir = await mkdtemp(join(tmpdir(), 'oxy-media-store-test-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('oxyMediaStore.uploadCachedMedia', () => {
  it('POSTs to /assets/service/cache with the service bearer, headers, and the file body, returning data.file.id', async () => {
    const filePath = join(workDir, 'media.bin');
    const payload = Buffer.from('hello-fediverse-media');
    await writeFile(filePath, payload);

    respond = () => ({ statusCode: 200, body: JSON.stringify({ data: { file: { id: 'oxy_file_123' } } }) });

    const result = await uploadCachedMedia({
      filePath,
      contentType: 'image/png',
      originalName: 'avatar.png',
      sizeBytes: payload.byteLength,
    });

    expect(result).toEqual({ oxyFileId: 'oxy_file_123', sizeBytes: payload.byteLength, contentType: 'image/png' });
    expect(getServiceToken).toHaveBeenCalledTimes(1);

    expect(requests).toHaveLength(1);
    const sent = requests[0];
    expect(sent.options.method).toBe('POST');
    expect(sent.options.hostname).toBe('oxy.test');
    expect(sent.options.path).toBe('/assets/service/cache');
    expect(sent.options.headers.Authorization).toBe(`Bearer ${SERVICE_TOKEN}`);
    expect(sent.options.headers['Content-Type']).toBe('image/png');
    expect(sent.options.headers['x-original-name']).toBe('avatar.png');
    expect(sent.options.headers['Content-Length']).toBe(String(payload.byteLength));

    // The temp file was STREAMED as the raw request body (not JSON-wrapped).
    expect(Buffer.concat(sent.bodyChunks).toString('utf8')).toBe('hello-fediverse-media');
  });

  it('omits x-original-name when no name is provided', async () => {
    const filePath = join(workDir, 'noname.bin');
    await writeFile(filePath, Buffer.from('x'));

    await uploadCachedMedia({ filePath, contentType: 'video/mp4' });

    expect(requests[0].options.headers['x-original-name']).toBeUndefined();
    expect(requests[0].options.headers['Content-Type']).toBe('video/mp4');
  });

  it('throws OxyMediaStoreRequestError on a non-2xx upload response', async () => {
    const filePath = join(workDir, 'fail.bin');
    await writeFile(filePath, Buffer.from('x'));
    respond = () => ({ statusCode: 500, body: 'upstream boom' });

    await expect(uploadCachedMedia({ filePath, contentType: 'image/png' })).rejects.toBeInstanceOf(
      OxyMediaStoreRequestError,
    );
  });

  it('throws when the response is missing data.file.id', async () => {
    const filePath = join(workDir, 'badbody.bin');
    await writeFile(filePath, Buffer.from('x'));
    respond = () => ({ statusCode: 200, body: JSON.stringify({ data: {} }) });

    await expect(uploadCachedMedia({ filePath, contentType: 'image/png' })).rejects.toBeInstanceOf(
      OxyMediaStoreRequestError,
    );
  });

  it('recovers from a 401 by invalidating the service token and retrying ONCE with a fresh stream', async () => {
    const filePath = join(workDir, 'retry.bin');
    const payload = Buffer.from('stream-must-be-reopened');
    await writeFile(filePath, payload);

    // First attempt 401 (stale token), second attempt 200 (re-minted token).
    respond = () =>
      requests.length === 1
        ? { statusCode: 401, body: 'token rejected' }
        : { statusCode: 200, body: JSON.stringify({ data: { file: { id: 'oxy_file_after_retry' } } }) };

    const result = await uploadCachedMedia({
      filePath,
      contentType: 'image/png',
      originalName: 'avatar.png',
      sizeBytes: payload.byteLength,
    });

    expect(result.oxyFileId).toBe('oxy_file_after_retry');

    // The cached token was dropped exactly once, and a fresh token minted per attempt.
    expect(invalidateServiceToken).toHaveBeenCalledTimes(1);
    expect(getServiceToken).toHaveBeenCalledTimes(2);

    // Two POSTs were issued; the retry re-opened the file and streamed the FULL body.
    expect(requests).toHaveLength(2);
    expect(requests[0].options.method).toBe('POST');
    expect(requests[1].options.method).toBe('POST');
    expect(Buffer.concat(requests[1].bodyChunks).toString('utf8')).toBe('stream-must-be-reopened');
  });

  it('throws OxyMediaStoreRequestError when the upload retry also returns 401', async () => {
    const filePath = join(workDir, 'retry-fail.bin');
    await writeFile(filePath, Buffer.from('x'));
    respond = () => ({ statusCode: 401, body: 'still unauthorized' });

    await expect(uploadCachedMedia({ filePath, contentType: 'image/png' })).rejects.toBeInstanceOf(
      OxyMediaStoreRequestError,
    );

    // Recovered exactly once: 2 requests, 1 invalidation, no infinite retry loop.
    expect(requests).toHaveLength(2);
    expect(invalidateServiceToken).toHaveBeenCalledTimes(1);
  });

  it('does NOT invalidate the token on a non-401 upload failure', async () => {
    const filePath = join(workDir, 'server-error.bin');
    await writeFile(filePath, Buffer.from('x'));
    respond = () => ({ statusCode: 500, body: 'boom' });

    await expect(uploadCachedMedia({ filePath, contentType: 'image/png' })).rejects.toBeInstanceOf(
      OxyMediaStoreRequestError,
    );

    expect(requests).toHaveLength(1);
    expect(invalidateServiceToken).not.toHaveBeenCalled();
  });
});

describe('oxyMediaStore.deleteCachedMedia', () => {
  it('issues a DELETE to /assets/service/cache/:id with the service bearer', async () => {
    respond = () => ({ statusCode: 204, body: '' });

    await deleteCachedMedia('oxy_file_to_delete');

    expect(requests).toHaveLength(1);
    const sent = requests[0];
    expect(sent.options.method).toBe('DELETE');
    expect(sent.options.path).toBe('/assets/service/cache/oxy_file_to_delete');
    expect(sent.options.headers.Authorization).toBe(`Bearer ${SERVICE_TOKEN}`);
    // No body is streamed on delete.
    expect(sent.bodyChunks).toHaveLength(0);
  });

  it('url-encodes the file id in the delete path', async () => {
    respond = () => ({ statusCode: 200, body: '' });

    await deleteCachedMedia('weird/id with space');

    expect(requests[0].options.path).toBe('/assets/service/cache/weird%2Fid%20with%20space');
  });

  it('throws OxyMediaStoreRequestError on a non-2xx delete response', async () => {
    respond = () => ({ statusCode: 404, body: 'not found' });

    await expect(deleteCachedMedia('missing')).rejects.toBeInstanceOf(OxyMediaStoreRequestError);
  });

  it('recovers from a 401 by invalidating the service token and retrying the DELETE once', async () => {
    respond = () =>
      requests.length === 1 ? { statusCode: 401, body: 'token rejected' } : { statusCode: 204, body: '' };

    await deleteCachedMedia('oxy_file_to_delete');

    expect(invalidateServiceToken).toHaveBeenCalledTimes(1);
    expect(getServiceToken).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(2);
    expect(requests[1].options.method).toBe('DELETE');
    expect(requests[1].options.path).toBe('/assets/service/cache/oxy_file_to_delete');
    expect(requests[1].options.headers.Authorization).toBe(`Bearer ${SERVICE_TOKEN}`);
  });

  it('throws when the delete retry also returns 401', async () => {
    respond = () => ({ statusCode: 401, body: 'still unauthorized' });

    await expect(deleteCachedMedia('missing')).rejects.toBeInstanceOf(OxyMediaStoreRequestError);

    expect(requests).toHaveLength(2);
    expect(invalidateServiceToken).toHaveBeenCalledTimes(1);
  });

  it('does NOT invalidate the token on a non-401 delete failure', async () => {
    respond = () => ({ statusCode: 404, body: 'not found' });

    await expect(deleteCachedMedia('missing')).rejects.toBeInstanceOf(OxyMediaStoreRequestError);

    expect(requests).toHaveLength(1);
    expect(invalidateServiceToken).not.toHaveBeenCalled();
  });
});
