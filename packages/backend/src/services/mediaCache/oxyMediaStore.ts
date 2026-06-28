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
 * Both write operations are gated behind {@link isMediaCacheEnabled}: when the
 * cache is disabled they throw {@link MediaStoreUnavailableError}, and the
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
/** Path of the oxy-api durable federated-media upload endpoint. */
const OXY_ASSET_FEDERATION_PATH = '/assets/service/federation';

/** Successful upload status returned by the oxy-api cache endpoint. */
const HTTP_OK = 200;
const HTTP_CREATED = 201;
/** A successful delete may answer 200 or 204 (no content). */
const HTTP_NO_CONTENT = 204;
/**
 * Unauthorized — the SDK-managed service token was rejected (e.g. revoked,
 * rotated, or expired right at the clock-drift boundary). We recover ONCE by
 * dropping the cached token and re-minting (see {@link withServiceTokenRetry}).
 */
const HTTP_UNAUTHORIZED = 401;
/** Idle socket timeout while streaming a body to / reading a response from oxy-api. */
const OXY_REQUEST_TIMEOUT_MS = 60_000;
/** Cap on the error-body snippet captured for diagnostics (avoid unbounded logs). */
const ERROR_BODY_SNIPPET_BYTES = 1024;

/** Shape of the oxy-api cache-upload success response we depend on. */
interface OxyCacheUploadResponse {
  data?: { file?: { id?: unknown } };
}

/**
 * Master predicate for whether the federated media cache is active.
 *
 * When this is false the cache is COMPLETELY INERT: the proxy/poster routes must
 * perform ZERO `FederatedMediaCache` reads or writes (no lookups, no access
 * bumps, no enqueues) and behave exactly like the pre-cache passthrough (stream
 * from remote / on-demand ffmpeg poster); the worker/eviction jobs short-circuit
 * on the same flag so no write traffic (Oxy upload/delete) is generated either.
 *
 * The cache is only ever consistent end-to-end when this is enabled — reading or
 * recording with a disabled worker just accumulates dead `pending` rows that
 * nothing drains — so a single flag governs both the read-path hooks and the
 * write side together.
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

/**
 * Run an oxy-api request and recover from a single `401 Unauthorized` caused by a
 * stale SDK-managed service token (revoked/rotated, or refreshed right at the
 * clock-drift boundary). On a 401 we drop the cached token via the core client's
 * synchronous {@link OxyServices.invalidateServiceToken} so the NEXT
 * `getServiceToken()` re-mints a fresh JWT, then re-run `doRequest` exactly ONCE.
 *
 * `doRequest` MUST acquire the bearer token and (for the upload) open its file
 * stream INTERNALLY on each call, because the retry re-invokes it: a consumed
 * read stream cannot be re-sent, and the retry needs the freshly-minted token.
 * The first attempt's 401 response is drained so its socket returns to the pool.
 * Non-401 responses are returned verbatim for the caller to status-check.
 */
async function withServiceTokenRetry(
  doRequest: () => Promise<IncomingMessage>,
): Promise<IncomingMessage> {
  const first = await doRequest();
  if (first.statusCode !== HTTP_UNAUTHORIZED) {
    return first;
  }

  // Discard the rejected token and release the dead socket before retrying.
  getServiceOxyClient().invalidateServiceToken();
  first.resume();
  logger.warn('[MediaCache] Oxy service token rejected (401); re-minting and retrying once');

  return doRequest();
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
 * Gated behind {@link isMediaCacheEnabled}; throws
 * {@link MediaStoreUnavailableError} when the cache is disabled and
 * {@link OxyMediaStoreRequestError} on a non-2xx oxy-api response.
 */
export async function uploadCachedMedia(source: CachedMediaSource): Promise<UploadedAsset> {
  if (!isMediaCacheEnabled()) {
    throw new MediaStoreUnavailableError('upload');
  }

  return uploadMediaToOxy(OXY_ASSET_CACHE_PATH, source);
}

/**
 * Upload an OWNED GIF-library media object (full mp4 or small mp4 preview) to Oxy
 * via the SAME service-token streaming upload path the federated media cache uses
 * (`POST /assets/service/cache`). Reuses the exact streaming + 401-retry transport
 * of {@link uploadCachedMedia} — it does NOT invent a second S3 write path.
 *
 * Two deliberate differences from {@link uploadCachedMedia}:
 *  - It is gated by the GIF library's own `GIF_LIBRARY_WRITE_ENABLED` switch
 *    (checked by the caller in `services/gifLibrary`), NOT by the federated
 *    media-cache `isMediaCacheEnabled()` flag, so GIF imports stay on even when
 *    the federated media cache is off (the GIF library defaults ON).
 *  - The GIF library OWNS these objects: it never calls the cache eviction
 *    DELETE (`/assets/service/cache/:id`) on a GIF file id, and GIF files are not
 *    tracked in `FederatedMediaCache`, so the activity-based eviction job never
 *    enumerates them. They are therefore durable despite sharing the reserved
 *    cache namespace, which is exactly what `Gif` rows (referenced by persisted
 *    posts) require.
 */
export async function uploadGifLibraryMedia(source: CachedMediaSource): Promise<UploadedAsset> {
  return uploadMediaToOxy(OXY_ASSET_CACHE_PATH, source);
}

export interface FederatedMediaSource extends CachedMediaSource {
  ownerUserId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Upload durable federated media to Oxy as a normal public asset owned by the
 * resolved federated Oxy user. This is used when Mention persists post media
 * references directly to file ids, so the file must not be in the cache eviction
 * namespace.
 */
export async function uploadFederatedMedia(source: FederatedMediaSource): Promise<UploadedAsset> {
  if (!isMediaCacheEnabled()) {
    throw new MediaStoreUnavailableError('upload');
  }

  const metadata = source.metadata ? JSON.stringify(source.metadata).slice(0, 4096) : undefined;
  return uploadMediaToOxy(OXY_ASSET_FEDERATION_PATH, source, {
    'x-owner-user-id': source.ownerUserId,
    ...(metadata ? { 'x-media-metadata': metadata } : {}),
  });
}

async function uploadMediaToOxy(
  path: string,
  source: CachedMediaSource,
  extraHeaders: Record<string, string> = {},
): Promise<UploadedAsset> {
  const target = new URL(`${getOxyApiBaseUrl()}${path}`);

  // The token is acquired and the file stream re-opened INSIDE the closure so a
  // 401 retry re-mints the bearer and pipes a fresh stream (a consumed stream
  // cannot be re-sent).
  const response = await withServiceTokenRetry(async () => {
    const token = await getServiceBearerToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': source.contentType,
      Accept: 'application/json',
      ...extraHeaders,
    };
    if (source.originalName) {
      headers['x-original-name'] = source.originalName;
    }
    if (typeof source.sizeBytes === 'number' && Number.isFinite(source.sizeBytes)) {
      headers['Content-Length'] = String(source.sizeBytes);
    }
    return streamRequest('POST', target, headers, source.filePath);
  });
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
 * cleanup). Gated behind {@link isMediaCacheEnabled}; throws
 * {@link MediaStoreUnavailableError} when disabled and
 * {@link OxyMediaStoreRequestError} on a non-2xx oxy-api response.
 */
export async function deleteCachedMedia(oxyFileId: string): Promise<void> {
  if (!isMediaCacheEnabled()) {
    throw new MediaStoreUnavailableError('delete');
  }

  const target = new URL(`${getOxyApiBaseUrl()}${OXY_ASSET_CACHE_PATH}/${encodeURIComponent(oxyFileId)}`);

  // Token acquired inside the closure so a 401 retry mints a fresh bearer. The
  // delete carries no body, so the retry is a plain re-issue.
  const response = await withServiceTokenRetry(async () => {
    const token = await getServiceBearerToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    return streamRequest('DELETE', target, headers);
  });
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
