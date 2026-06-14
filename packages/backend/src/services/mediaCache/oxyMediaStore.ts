import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { createReadStream } from 'node:fs';
import { URL } from 'node:url';

import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { logger } from '../../utils/logger';
import { MEDIA_CACHE_WRITE_ENABLED } from './constants';

/**
 * Thin boundary over the Oxy asset operations the media cache needs from the
 * BACKEND SERVICE CLIENT (no end-user in the request). Isolating them here keeps
 * the upstream-capability dependency in ONE place.
 *
 * CAPABILITY STATUS:
 *  - DOWNLOAD-URL resolution: `getFileDownloadUrlAsync` returns a signed CDN URL
 *    the proxy can 302-redirect to.
 *  - UPLOAD + DELETE: served by the oxy-api service-token cache endpoints
 *    (`POST /assets/service/cache`, `DELETE /assets/service/cache/:id`), which are
 *    gated by `serviceAuthMiddleware`. We authenticate with the SAME service token
 *    the SDK already manages via {@link getServiceOxyClient} — `getServiceToken()`
 *    auto-acquires and refreshes a short-lived (1h) JWT per configured credential
 *    pair. Because the SDK's generic request transport (`makeServiceRequest` →
 *    `HttpService`) only serializes JSON bodies (or multipart `FormData`) and
 *    cannot stream a raw request body with an arbitrary `Content-Type`, the upload
 *    path performs a native streaming HTTP request and attaches the SDK-managed
 *    service token as the bearer. No token is hand-minted: token lifecycle stays
 *    owned by the SDK.
 *
 * Both write operations are gated behind {@link isMediaStoreWriteEnabled}: when the
 * write side is disabled they throw {@link MediaStoreUnavailableError}, and the
 * worker/eviction jobs short-circuit on the same flag so no write traffic is
 * generated while the feature is off.
 */

/** Raised when an Oxy write capability the cache needs is not available. */
export class MediaStoreUnavailableError extends Error {
  constructor(operation: 'upload' | 'delete') {
    super(
      `Oxy media store ${operation} is unavailable: the federated media cache write side ` +
        `is disabled (FEDERATION_MEDIA_CACHE_WRITE_ENABLED is not 'true').`,
    );
    this.name = 'MediaStoreUnavailableError';
  }
}

/** Raised when an Oxy asset write request fails at the HTTP layer. */
export class OxyMediaStoreRequestError extends Error {
  readonly statusCode: number;
  constructor(operation: 'upload' | 'delete', statusCode: number, detail: string) {
    super(`Oxy media store ${operation} failed (HTTP ${statusCode}): ${detail}`);
    this.name = 'OxyMediaStoreRequestError';
    this.statusCode = statusCode;
  }
}

export interface UploadedAsset {
  oxyFileId: string;
  sizeBytes?: number;
  contentType?: string;
}

/** A media payload on local disk to stream to Oxy (never buffered in memory). */
export interface CachedMediaSource {
  /** Absolute path to the temp file holding the media bytes. */
  filePath: string;
  /** MIME type sent as the request `Content-Type`. */
  contentType: string;
  /** Optional original/derived filename sent as `x-original-name`. */
  originalName?: string;
  /** Optional known byte length, sent as `Content-Length` when present. */
  sizeBytes?: number;
}

/** Path of the oxy-api service-token asset cache endpoint (relative to the API base). */
const OXY_ASSET_CACHE_PATH = '/assets/service/cache';

/** Successful upload status returned by the oxy-api cache endpoint. */
const HTTP_OK = 200;
const HTTP_CREATED = 201;
/** A successful delete may answer 200 or 204 (no content). */
const HTTP_NO_CONTENT = 204;
/** Idle socket timeout while streaming a body to / reading a response from oxy-api. */
const OXY_REQUEST_TIMEOUT_MS = 60_000;
/** Cap on the error-body snippet captured for diagnostics (avoid unbounded logs). */
const ERROR_BODY_SNIPPET_BYTES = 1024;

/** Shape of the oxy-api cache-upload success response we depend on. */
interface OxyCacheUploadResponse {
  data?: { file?: { id?: unknown } };
}

/** True when the backend can actually upload/delete cached media in Oxy. */
export function isMediaStoreWriteEnabled(): boolean {
  return MEDIA_CACHE_WRITE_ENABLED;
}

/**
 * Master predicate for whether the federated media cache participates in the
 * proxy read-path AT ALL. When this is false the cache is COMPLETELY INERT: the
 * proxy/poster routes must perform ZERO `FederatedMediaCache` reads or writes (no
 * lookups, no access bumps, no enqueues) and behave exactly like the pre-cache
 * passthrough (stream from remote / on-demand ffmpeg poster).
 *
 * Today the cache is only ever consistent end-to-end when the write side is
 * enabled — reading/recording with a disabled worker just accumulates dead
 * `pending` rows that nothing drains — so this currently equals
 * {@link isMediaStoreWriteEnabled}. It is a distinct, named predicate so the
 * read-path gating reads intentionally and can diverge from the write gate later.
 */
export function isMediaCacheEnabled(): boolean {
  return MEDIA_CACHE_WRITE_ENABLED;
}

/**
 * Resolve a public, servable URL for a cached Oxy file so the proxy can redirect
 * to it (CDN serves the bytes). Works today via the assets URL endpoint.
 */
export async function resolveOxyDownloadUrl(oxyFileId: string): Promise<string> {
  const client = getServiceOxyClient();
  return client.getFileDownloadUrlAsync(oxyFileId);
}

/**
 * Resolve the absolute oxy-api base URL from the configured service client. The
 * SDK owns this value (set from `OXY_API_URL`), so we never hardcode a host here.
 */
function getOxyApiBaseUrl(): string {
  return getServiceOxyClient().getBaseURL().replace(/\/+$/, '');
}

/**
 * Obtain the SDK-managed service token. `getServiceToken()` returns a cached JWT
 * until 60s before expiry and transparently refreshes it otherwise, so the token
 * lifecycle stays owned by the SDK — we never mint one ourselves.
 */
async function getServiceBearerToken(): Promise<string> {
  return getServiceOxyClient().getServiceToken();
}

/** Read up to {@link ERROR_BODY_SNIPPET_BYTES} of a response body for diagnostics. */
async function readErrorSnippet(response: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    response.on('data', (chunk: Buffer) => {
      if (total >= ERROR_BODY_SNIPPET_BYTES) return;
      total += chunk.length;
      chunks.push(chunk);
    });
    response.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8').slice(0, ERROR_BODY_SNIPPET_BYTES));
    });
    response.on('error', () => resolve(''));
  });
}

/** Read a full JSON response body and parse it (bounded by the upstream contract). */
async function readJsonResponse(response: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length === 0) return undefined;
  return JSON.parse(raw);
}

/**
 * Upload a media payload to Oxy from the backend service client by STREAMING the
 * temp file directly as the raw request body (never buffering it in memory). The
 * payload's MIME type is sent verbatim as `Content-Type`; the derived name (when
 * provided) is sent as `x-original-name`. Returns the new Oxy file id.
 *
 * Gated behind {@link isMediaStoreWriteEnabled}; throws
 * {@link MediaStoreUnavailableError} when the write side is disabled and
 * {@link OxyMediaStoreRequestError} on a non-2xx oxy-api response.
 */
export async function uploadCachedMedia(source: CachedMediaSource): Promise<UploadedAsset> {
  if (!isMediaStoreWriteEnabled()) {
    throw new MediaStoreUnavailableError('upload');
  }

  const token = await getServiceBearerToken();
  const target = new URL(`${getOxyApiBaseUrl()}${OXY_ASSET_CACHE_PATH}`);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': source.contentType,
    Accept: 'application/json',
  };
  if (source.originalName) {
    headers['x-original-name'] = source.originalName;
  }
  if (typeof source.sizeBytes === 'number' && Number.isFinite(source.sizeBytes)) {
    headers['Content-Length'] = String(source.sizeBytes);
  }

  const response = await streamRequest('POST', target, headers, source.filePath);
  const status = response.statusCode ?? 0;

  if (status !== HTTP_OK && status !== HTTP_CREATED) {
    const detail = await readErrorSnippet(response);
    throw new OxyMediaStoreRequestError('upload', status, detail || 'no response body');
  }

  const body = (await readJsonResponse(response)) as OxyCacheUploadResponse | undefined;
  const fileId = body?.data?.file?.id;
  if (typeof fileId !== 'string' || fileId.length === 0) {
    throw new OxyMediaStoreRequestError('upload', status, 'response missing data.file.id');
  }

  logger.debug('[MediaCache] Uploaded cached media to Oxy', {
    oxyFileId: fileId,
    contentType: source.contentType,
    sizeBytes: source.sizeBytes,
  });

  return { oxyFileId: fileId, sizeBytes: source.sizeBytes, contentType: source.contentType };
}

/**
 * Delete a previously-cached Oxy file (used by the eviction job and orphan
 * cleanup). Gated behind {@link isMediaStoreWriteEnabled}; throws
 * {@link MediaStoreUnavailableError} when disabled and
 * {@link OxyMediaStoreRequestError} on a non-2xx oxy-api response.
 */
export async function deleteCachedMedia(oxyFileId: string): Promise<void> {
  if (!isMediaStoreWriteEnabled()) {
    throw new MediaStoreUnavailableError('delete');
  }

  const token = await getServiceBearerToken();
  const target = new URL(`${getOxyApiBaseUrl()}${OXY_ASSET_CACHE_PATH}/${encodeURIComponent(oxyFileId)}`);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };

  const response = await streamRequest('DELETE', target, headers);
  const status = response.statusCode ?? 0;

  if (status !== HTTP_OK && status !== HTTP_NO_CONTENT) {
    const detail = await readErrorSnippet(response);
    throw new OxyMediaStoreRequestError('delete', status, detail || 'no response body');
  }

  // Drain any success body so the socket can be released back to the pool.
  response.resume();
  logger.debug('[MediaCache] Deleted cached media from Oxy', { oxyFileId });
}

/**
 * Perform a single native HTTP/HTTPS request to oxy-api, optionally streaming a
 * local file as the request body. Returns the response message; the caller owns
 * consuming/draining it. Used instead of the SDK's JSON-only transport because
 * the cache endpoint takes the media as the raw request body.
 */
function streamRequest(
  method: 'POST' | 'DELETE',
  target: URL,
  headers: Record<string, string>,
  filePath?: string,
): Promise<IncomingMessage> {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const isHttps = target.protocol === 'https:';
    const transport = isHttps ? https : http;

    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers,
      },
      (response) => resolve(response),
    );

    request.setTimeout(OXY_REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error('oxy-api request timeout'));
    });
    request.on('error', (error) => reject(error));

    if (filePath) {
      const fileStream = createReadStream(filePath);
      fileStream.on('error', (error) => {
        request.destroy(error);
        reject(error);
      });
      fileStream.pipe(request);
    } else {
      request.end();
    }
  });
}
