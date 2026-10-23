import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OxyServer } from '@oxy.so/core/server';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Actual workload transport, with fetch responses standing in for Oxy. */
vi.mock('../../services/mediaCache/constants', () => ({ MEDIA_CACHE_WRITE_ENABLED: true }));
const SERVICE_TOKEN = `e30.${Buffer.from(
  JSON.stringify({
    type: 'service',
    authority: 'first_party',
    appId: 'mention',
    credentialId: 'wl_mention',
    ownerAccountId: 'owner',
    environment: 'production',
    aud: 'oxy-api',
    iss: 'oxy-auth',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
  }),
).toString('base64url')}.fixture`;
const OXY_BASE = 'http://oxy.test';
const mint = vi.fn();
const nativeFetch = globalThis.fetch;
let oxy: OxyServer;
vi.mock('../../utils/oxyHelpers', () => ({ getServiceOxyClient: () => oxy }));
interface CapturedRequest {
  options: {
    method: string;
    hostname: string;
    port: string;
    path: string;
    headers: Record<string, string>;
  };
  bodyChunks: Buffer[];
}
const requests: CapturedRequest[] = [];
let respond: (captured: CapturedRequest) => {
  statusCode: number;
  body: string;
  headers?: Record<string, string>;
} = () => ({
  statusCode: 200,
  body: JSON.stringify({ data: { file: { id: 'oxy_file_default' } } }),
});
async function authorityFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname === '/auth/service-token/workload/challenge') {
    return Response.json({ nonce: 'fixture-nonce' });
  }
  if (url.pathname === '/auth/service-token/workload') {
    const body = JSON.parse(String(init?.body));
    expect(body.protocolVersion).toBe(2);
    expect(body.audience ?? 'oxy-api').toBe('oxy-api');
    expect(body.scopes).toBeUndefined();
    return Response.json(await mint());
  }
  expect(init?.redirect).toBe('error');
  expect(init?.credentials).toBe('omit');
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const captured: CapturedRequest = {
    options: {
      method: init?.method ?? 'GET',
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      headers,
    },
    bodyChunks: [],
  };
  requests.push(captured);
  if (init?.body instanceof ReadableStream) {
    const reader = init.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      captured.bodyChunks.push(Buffer.from(value));
    }
    reader.releaseLock();
  } else if (init?.body !== undefined) {
    captured.bodyChunks.push(Buffer.from(String(init.body)));
  }
  const answer = respond(captured);
  return new Response(answer.statusCode === 204 ? null : answer.body, {
    status: answer.statusCode,
    headers: answer.headers,
  });
}

import {
  uploadCachedMedia,
  uploadFederatedMedia,
  deleteCachedMedia,
  isAbsentFromCacheNamespace,
  isMediaStoreThrottled,
  resetWriteBudgetCooldowns,
  OxyMediaOwnedElsewhereError,
  OxyMediaStoreRequestError,
  OxyMediaStoreThrottledError,
} from '../../services/mediaCache/oxyMediaStore';
import { logger } from '../../utils/logger';

let workDir: string;

beforeEach(async () => {
  requests.length = 0;
  mint.mockReset().mockResolvedValue({ token: SERVICE_TOKEN, expiresIn: 300 });
  vi.stubGlobal('fetch', authorityFetch);
  oxy = new OxyServer({
    baseURL: OXY_BASE,
    workloadCredentials: async () => ({
      AccessKeyId: 'ASIA_TEST',
      SecretAccessKey: 'test-only',
      Token: 'temporary-test',
    }),
  });
  respond = () => ({
    statusCode: 200,
    body: JSON.stringify({ data: { file: { id: 'oxy_file_default' } } }),
  });
  resetWriteBudgetCooldowns();
  workDir = await mkdtemp(join(tmpdir(), 'oxy-media-store-test-'));
});

afterEach(async () => {
  oxy.dispose();
  vi.unstubAllGlobals();
  await rm(workDir, { recursive: true, force: true });
});

describe('oxyMediaStore.uploadCachedMedia', () => {
  it('does not mint or open a file for an already cancelled upload', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      uploadCachedMedia({
        filePath: join(workDir, 'does-not-exist'),
        contentType: 'image/png',
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(mint).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it('streams the complete disk file again after one real HTTP 401', async () => {
    vi.stubGlobal('fetch', nativeFetch);
    const payload = Buffer.alloc(2 * 1024 * 1024, 0x61);
    const filePath = join(workDir, 'large.bin');
    await writeFile(filePath, payload);
    const uploads: Buffer[][] = [];
    let cancelUpload: AbortController | undefined;
    let uploadDisconnected: (() => void) | undefined;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        if (req.url === '/assets/service/cache') cancelUpload?.abort();
      });
      req.on('aborted', () => uploadDisconnected?.());
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/auth/service-token/workload/challenge') {
          res.end(JSON.stringify({ nonce: 'real-http-nonce' }));
          return;
        }
        if (req.url === '/auth/service-token/workload') {
          const claims = JSON.parse(Buffer.concat(chunks).toString());
          expect(claims.protocolVersion).toBe(2);
          expect(claims.scopes).toBeUndefined();
          void mint().then((body) => res.end(JSON.stringify(body)));
          return;
        }
        expect(req.url).toBe('/assets/service/cache');
        expect(req.headers.authorization).toBe(`Bearer ${SERVICE_TOKEN}`);
        expect(req.headers['content-type']).toBe('application/octet-stream');
        uploads.push(chunks);
        res.statusCode = uploads.length === 1 ? 401 : 201;
        res.end(JSON.stringify({ data: { file: { id: 'streamed-file' } } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    oxy.dispose();
    oxy = new OxyServer({
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      workloadCredentials: async () => ({
        AccessKeyId: 'ASIA_TEST',
        SecretAccessKey: 'test-only',
        Token: 'temporary-test',
      }),
    });
    try {
      expect(
        await uploadCachedMedia({
          filePath,
          contentType: 'application/octet-stream',
          sizeBytes: payload.length,
        }),
      ).toMatchObject({ oxyFileId: 'streamed-file' });
      expect(mint).toHaveBeenCalledTimes(2);
      expect(uploads).toHaveLength(2);
      for (const chunks of uploads) {
        expect(chunks.length).toBeGreaterThan(1);
        expect(Buffer.concat(chunks).equals(payload)).toBe(true);
      }
      await truncate(filePath, 64 * 1024 * 1024);
      cancelUpload = new AbortController();
      const disconnected = new Promise<void>((resolve) => {
        uploadDisconnected = resolve;
      });
      await expect(
        uploadCachedMedia({
          filePath,
          contentType: 'application/octet-stream',
          sizeBytes: 64 * 1024 * 1024,
          signal: cancelUpload.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError', code: 'CANCELLED' });
      await disconnected;
      expect(mint).toHaveBeenCalledTimes(2);
      expect(uploads).toHaveLength(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('POSTs to /assets/service/cache with the service bearer, headers, and the file body, returning data.file.id', async () => {
    const filePath = join(workDir, 'media.bin');
    const payload = Buffer.from('hello-fediverse-media');
    await writeFile(filePath, payload);

    respond = () => ({
      statusCode: 200,
      body: JSON.stringify({ data: { file: { id: 'oxy_file_123' } } }),
    });

    const result = await uploadCachedMedia({
      filePath,
      contentType: 'image/png',
      originalName: 'avatar.png',
      sizeBytes: payload.byteLength,
    });

    expect(result).toEqual({
      oxyFileId: 'oxy_file_123',
      sizeBytes: payload.byteLength,
      contentType: 'image/png',
    });
    expect(mint).toHaveBeenCalledTimes(1);

    expect(requests).toHaveLength(1);
    const sent = requests[0];
    expect(sent.options.method).toBe('POST');
    expect(sent.options.hostname).toBe('oxy.test');
    expect(sent.options.path).toBe('/assets/service/cache');
    expect(sent.options.headers.authorization).toBe(`Bearer ${SERVICE_TOKEN}`);
    expect(sent.options.headers['content-type']).toBe('image/png');
    expect(sent.options.headers['x-original-name']).toBe('avatar.png');
    expect(sent.options.headers['content-length']).toBe(String(payload.byteLength));

    // The temp file was STREAMED as the raw request body (not JSON-wrapped).
    expect(Buffer.concat(sent.bodyChunks).toString('utf8')).toBe('hello-fediverse-media');
  });

  it('omits x-original-name when no name is provided', async () => {
    const filePath = join(workDir, 'noname.bin');
    await writeFile(filePath, Buffer.from('x'));

    await uploadCachedMedia({ filePath, contentType: 'video/mp4' });

    expect(requests[0].options.headers['x-original-name']).toBeUndefined();
    expect(requests[0].options.headers['content-type']).toBe('video/mp4');
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
        : {
            statusCode: 200,
            body: JSON.stringify({ data: { file: { id: 'oxy_file_after_retry' } } }),
          };

    const result = await uploadCachedMedia({
      filePath,
      contentType: 'image/png',
      originalName: 'avatar.png',
      sizeBytes: payload.byteLength,
    });

    expect(result.oxyFileId).toBe('oxy_file_after_retry');

    // The cached token was dropped exactly once, and a fresh token minted per attempt.
    expect(mint).toHaveBeenCalledTimes(2);

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
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('does NOT invalidate the token on a non-401 upload failure', async () => {
    const filePath = join(workDir, 'server-error.bin');
    await writeFile(filePath, Buffer.from('x'));
    respond = () => ({ statusCode: 500, body: 'boom' });

    await expect(uploadCachedMedia({ filePath, contentType: 'image/png' })).rejects.toBeInstanceOf(
      OxyMediaStoreRequestError,
    );

    expect(requests).toHaveLength(1);
    expect(mint).toHaveBeenCalledTimes(1);
  });
});

describe('oxyMediaStore.uploadFederatedMedia', () => {
  it('POSTs to /assets/service/federation with owner and metadata headers', async () => {
    const filePath = join(workDir, 'fed.bin');
    const payload = Buffer.from('durable-fediverse-media');
    await writeFile(filePath, payload);

    respond = () => ({
      statusCode: 200,
      body: JSON.stringify({ data: { file: { id: 'oxy_file_fed' } } }),
    });

    const result = await uploadFederatedMedia({
      filePath,
      contentType: 'image/jpeg',
      originalName: 'photo.jpg',
      sizeBytes: payload.byteLength,
      ownerUserId: '6a3000000000000000000000',
      metadata: { remoteHost: 'example.social', activityId: 'https://example.social/posts/1' },
    });

    expect(result).toEqual({
      oxyFileId: 'oxy_file_fed',
      sizeBytes: payload.byteLength,
      contentType: 'image/jpeg',
    });
    expect(requests).toHaveLength(1);

    const sent = requests[0];
    expect(sent.options.method).toBe('POST');
    expect(sent.options.hostname).toBe('oxy.test');
    expect(sent.options.path).toBe('/assets/service/federation');
    expect(sent.options.headers.authorization).toBe(`Bearer ${SERVICE_TOKEN}`);
    expect(sent.options.headers['content-type']).toBe('image/jpeg');
    expect(sent.options.headers['x-original-name']).toBe('photo.jpg');
    expect(sent.options.headers['x-owner-user-id']).toBe('6a3000000000000000000000');
    expect(JSON.parse(sent.options.headers['x-media-metadata'])).toEqual({
      remoteHost: 'example.social',
      activityId: 'https://example.social/posts/1',
    });
    expect(Buffer.concat(sent.bodyChunks).toString('utf8')).toBe('durable-fediverse-media');
  });

  it('reports a deduplicated answer (the EXISTING file for the same bytes, owner and app)', async () => {
    const filePath = join(workDir, 'dup.bin');
    await writeFile(filePath, Buffer.from('same-bytes'));
    respond = () => ({
      statusCode: 200,
      body: JSON.stringify({
        data: {
          file: {
            id: 'oxy_existing',
            sha256: 'abc',
            size: 10,
            mime: 'image/jpeg',
            visibility: 'public',
          },
          deduplicated: true,
        },
      }),
    });

    await expect(
      uploadFederatedMedia({ filePath, contentType: 'image/jpeg', ownerUserId: 'owner-1' }),
    ).resolves.toMatchObject({ oxyFileId: 'oxy_existing', deduplicated: true });
  });

  it('raises OxyMediaOwnedElsewhereError for 409 FEDERATED_MEDIA_OWNED_ELSEWHERE — and only for that code', async () => {
    const filePath = join(workDir, 'elsewhere.bin');
    await writeFile(filePath, Buffer.from('someone-elses-bytes'));
    respond = () => ({
      statusCode: 409,
      body: JSON.stringify({
        error: 'FEDERATED_MEDIA_OWNED_ELSEWHERE',
        message: 'owned elsewhere',
      }),
    });
    await expect(
      uploadFederatedMedia({ filePath, contentType: 'image/jpeg', ownerUserId: 'owner-1' }),
    ).rejects.toBeInstanceOf(OxyMediaOwnedElsewhereError);

    respond = () => ({ statusCode: 409, body: JSON.stringify({ error: 'SOMETHING_ELSE' }) });
    await expect(
      uploadFederatedMedia({ filePath, contentType: 'image/jpeg', ownerUserId: 'owner-1' }),
    ).rejects.toBeInstanceOf(OxyMediaStoreRequestError);
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
    expect(sent.options.headers.authorization).toBe(`Bearer ${SERVICE_TOKEN}`);
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

  it('tells an id the cache namespace does not hold from a refused credential', async () => {
    const refusal = (message: string) => () => ({
      statusCode: 403,
      body: JSON.stringify({ error: 'FORBIDDEN', message }),
    });
    respond = refusal('Asset is not a federation media-cache object');
    const notCacheObject = await deleteCachedMedia('durable').catch((error: unknown) => error);
    expect(isAbsentFromCacheNamespace(notCacheObject)).toBe(true);

    respond = refusal('Missing required scope: federation:write');
    const scopeRefused = await deleteCachedMedia('cached').catch((error: unknown) => error);
    expect(scopeRefused).toBeInstanceOf(OxyMediaStoreRequestError);
    expect(isAbsentFromCacheNamespace(scopeRefused)).toBe(false);
  });

  it('recovers from a 401 by invalidating the service token and retrying the DELETE once', async () => {
    respond = () =>
      requests.length === 1
        ? { statusCode: 401, body: 'token rejected' }
        : { statusCode: 204, body: '' };

    await deleteCachedMedia('oxy_file_to_delete');

    expect(mint).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(2);
    expect(requests[1].options.method).toBe('DELETE');
    expect(requests[1].options.path).toBe('/assets/service/cache/oxy_file_to_delete');
    expect(requests[1].options.headers.authorization).toBe(`Bearer ${SERVICE_TOKEN}`);
  });

  it('throws when the delete retry also returns 401', async () => {
    respond = () => ({ statusCode: 401, body: 'still unauthorized' });

    await expect(deleteCachedMedia('missing')).rejects.toBeInstanceOf(OxyMediaStoreRequestError);

    expect(requests).toHaveLength(2);
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('does NOT invalidate the token on a non-401 delete failure', async () => {
    respond = () => ({ statusCode: 404, body: 'not found' });

    await expect(deleteCachedMedia('missing')).rejects.toBeInstanceOf(OxyMediaStoreRequestError);

    expect(requests).toHaveLength(1);
    expect(mint).toHaveBeenCalledTimes(1);
  });
});

/**
 * Oxy caps media-cache writes per application (30 uploads/min) and answers 429
 * when the window's budget is spent — a statement about the WINDOW, not the
 * object. Nothing here noticed, so the worker kept firing its whole batch and
 * the eviction sweep its whole page: 54 upload 429s in two minutes for ~32
 * queued entries, and 50 eviction deletes failing per sweep, every sweep.
 *
 * These pin the local brake: the first 429 opens a cooldown, later calls fail
 * without touching the network, and nothing else is affected.
 */
describe('oxyMediaStore write-budget cooldown', () => {
  async function mediaFile(name = 'media.bin'): Promise<string> {
    const filePath = join(workDir, name);
    await writeFile(filePath, Buffer.from('bytes'));
    return filePath;
  }

  it('refuses the next upload locally instead of spending another request', async () => {
    respond = () => ({ statusCode: 429, body: 'Too many media cache uploads. Please slow down.' });
    const filePath = await mediaFile();

    await expect(uploadCachedMedia({ filePath, contentType: 'image/png' })).rejects.toBeInstanceOf(
      OxyMediaStoreThrottledError,
    );
    expect(requests).toHaveLength(1);

    await expect(uploadCachedMedia({ filePath, contentType: 'image/png' })).rejects.toBeInstanceOf(
      OxyMediaStoreThrottledError,
    );
    // No second request: the refusal is local, so it costs no socket, no service
    // token and no file stream.
    expect(requests).toHaveLength(1);
  });

  it('sizes the cooldown from Retry-After and resumes once it passes', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-16T05:00:00.000Z'));
      respond = () => ({ statusCode: 429, body: 'slow down', headers: { 'retry-after': '2' } });
      const filePath = await mediaFile();

      const throttled = await uploadCachedMedia({ filePath, contentType: 'image/png' }).catch(
        (error: unknown) => error,
      );
      expect(isMediaStoreThrottled(throttled)).toBe(true);
      expect((throttled as OxyMediaStoreThrottledError).retryAfterMs).toBe(2000);

      vi.setSystemTime(Date.now() + 1_000);
      await expect(
        uploadCachedMedia({ filePath, contentType: 'image/png' }),
      ).rejects.toBeInstanceOf(OxyMediaStoreThrottledError);
      expect(requests).toHaveLength(1);

      vi.setSystemTime(Date.now() + 1_500);
      respond = () => ({
        statusCode: 200,
        body: JSON.stringify({ data: { file: { id: 'oxy_after_cooldown' } } }),
      });
      await expect(
        uploadCachedMedia({ filePath, contentType: 'image/png' }),
      ).resolves.toMatchObject({
        oxyFileId: 'oxy_after_cooldown',
      });
      expect(requests).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the budget window when Retry-After is absent or nonsense', async () => {
    respond = () => ({ statusCode: 429, body: 'slow down', headers: { 'retry-after': 'soon' } });
    const filePath = await mediaFile();

    const throttled = (await uploadCachedMedia({ filePath, contentType: 'image/png' }).catch(
      (error: unknown) => error,
    )) as OxyMediaStoreThrottledError;

    expect(throttled.retryAfterMs).toBe(60_000);
  });

  it('pauses only the operation that was refused', async () => {
    respond = (captured) =>
      captured.options.method === 'DELETE'
        ? { statusCode: 429, body: 'slow down' }
        : { statusCode: 200, body: JSON.stringify({ data: { file: { id: 'oxy_upload_ok' } } }) };
    const filePath = await mediaFile();

    await expect(deleteCachedMedia('oxy_file_1')).rejects.toBeInstanceOf(
      OxyMediaStoreThrottledError,
    );
    // Uploads still go out: the two operations have separate budgets upstream.
    await expect(uploadCachedMedia({ filePath, contentType: 'image/png' })).resolves.toMatchObject({
      oxyFileId: 'oxy_upload_ok',
    });
    await expect(deleteCachedMedia('oxy_file_2')).rejects.toBeInstanceOf(
      OxyMediaStoreThrottledError,
    );
    expect(requests.filter((r) => r.options.method === 'DELETE')).toHaveLength(1);
  });

  it('leaves an ordinary failure alone — only 429 opens a cooldown', async () => {
    respond = () => ({ statusCode: 500, body: 'boom' });
    const filePath = await mediaFile();

    await expect(uploadCachedMedia({ filePath, contentType: 'image/png' })).rejects.toBeInstanceOf(
      OxyMediaStoreRequestError,
    );
    await expect(uploadCachedMedia({ filePath, contentType: 'image/png' })).rejects.toBeInstanceOf(
      OxyMediaStoreRequestError,
    );

    // Both reached the network: a 500 says nothing about the budget.
    expect(requests).toHaveLength(2);
  });

  it('announces the pause once per window, not once per refusal', async () => {
    respond = () => ({ statusCode: 429, body: 'slow down' });
    const warn = vi.spyOn(logger, 'warn');
    const filePath = await mediaFile();

    const [first, second] = await Promise.all([
      uploadCachedMedia({ filePath, contentType: 'image/png' }).catch((error: unknown) => error),
      uploadCachedMedia({ filePath, contentType: 'image/png' }).catch((error: unknown) => error),
    ]);
    await uploadCachedMedia({ filePath, contentType: 'image/png' }).catch(() => undefined);

    expect(isMediaStoreThrottled(first)).toBe(true);
    expect(isMediaStoreThrottled(second)).toBe(true);
    expect(
      warn.mock.calls.filter(
        ([message]) =>
          message === '[MediaCache] Oxy media-write budget spent; pausing this operation',
      ),
    ).toHaveLength(1);
  });

  it('refuses a federated upload on the same budget as a cache upload', async () => {
    respond = () => ({ statusCode: 429, body: 'slow down' });
    const filePath = await mediaFile();

    await expect(uploadCachedMedia({ filePath, contentType: 'image/png' })).rejects.toBeInstanceOf(
      OxyMediaStoreThrottledError,
    );
    await expect(
      uploadFederatedMedia({ filePath, contentType: 'image/png', ownerUserId: 'owner-1' }),
    ).rejects.toBeInstanceOf(OxyMediaStoreThrottledError);

    expect(requests).toHaveLength(1);
  });
});
