import type { IncomingHttpHeaders } from 'node:http';
import { Readable } from 'node:stream';
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
 *  - DOWNLOAD URL: none is resolved. Everything this store uploads is public, so
 *    the proxy 302s to the deterministic by-id CDN form built synchronously by
 *    the SDK (see {@link cachedMediaCdnUrl}). Asking the API for it needed a
 *    session token this client will never hold, and failed 100% of the time.
 *  - UPLOAD + DELETE: the shared workload transport owns authentication,
 *    destination binding, redirects and one safe 401 replay. Upload bodies are
 *    reopened from disk through fetchReplayable; they are never fully buffered.
 *    The store retains its domain cooldowns and 60-second inactivity timeout.
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

/** The message oxy-api answers for {@link OxyMediaNotCacheObjectError}. */
const NOT_CACHE_OBJECT_MESSAGE = 'Asset is not a federation media-cache object';
const HTTP_FORBIDDEN = 403;

/**
 * oxy-api refused a cache-route delete because the file is not in the cache
 * namespace (403 `Asset is not a federation media-cache object`). Before Oxy
 * kept one row per owner per content hash (oxy#1444, 2026-09-30), a cache
 * upload of bytes someone already held came back as THAT durable file's id, and
 * the cache row recorded it. PERMANENT: the file is not the cache's to delete.
 */
export class OxyMediaNotCacheObjectError extends OxyMediaStoreRequestError {
  constructor(detail: string) {
    super('delete', HTTP_FORBIDDEN, detail);
    this.name = 'OxyMediaNotCacheObjectError';
  }
}

/**
 * oxy-api refused a durable federated upload because these BYTES already belong
 * to another owner or were uploaded by another application (409
 * `FEDERATED_MEDIA_OWNED_ELSEWHERE`): Oxy keeps one live file per content hash
 * and never hands it across owners. PERMANENT for this media item — the same
 * bytes get the same answer on every retry.
 */
export class OxyMediaOwnedElsewhereError extends Error {
  constructor() {
    super('Oxy refused the upload: these bytes belong to another owner or application');
    this.name = 'OxyMediaOwnedElsewhereError';
  }
}

/** The 409 error code oxy-api answers for {@link OxyMediaOwnedElsewhereError}. */
const OWNED_ELSEWHERE_CODE = 'FEDERATED_MEDIA_OWNED_ELSEWHERE';
const HTTP_CONFLICT = 409;

/**
 * Raised INSTEAD of issuing a request when this app's Oxy media-write budget for
 * the current window is known to be spent.
 *
 * Oxy caps media-cache writes per application (30 uploads/min). When the cap is
 * reached it answers 429 — a statement about the WINDOW, not about the object —
 * and nothing here noticed: the worker kept firing its whole batch and the
 * eviction sweep its whole page, so one exhausted budget became dozens of 429s
 * and dozens of warn lines. Measured in production: 54 upload 429s in two
 * minutes for ~32 queued entries, plus 50 eviction deletes failing per sweep,
 * every sweep.
 *
 * So the first 429 opens a cooldown and every later call in that window fails
 * FAST and locally. Nothing is lost: both callers already treat a failed write as
 * non-permanent — the entry stays `pending`, the row stays `cached` — so the work
 * happens in the next window instead of being spent on refusals.
 */
export class OxyMediaStoreThrottledError extends Error {
  readonly operation: 'upload' | 'delete';
  readonly retryAfterMs: number;

  constructor(operation: 'upload' | 'delete', retryAfterMs: number) {
    super(
      `Oxy media store ${operation} budget is spent for this window; ` +
        `retrying in ${Math.ceil(retryAfterMs / 1000)}s`,
    );
    this.name = 'OxyMediaStoreThrottledError';
    this.operation = operation;
    this.retryAfterMs = retryAfterMs;
  }
}

/** True when `error` is the local refusal above (never a remote failure). */
export function isMediaStoreThrottled(error: unknown): error is OxyMediaStoreThrottledError {
  return error instanceof OxyMediaStoreThrottledError;
}

/** The budget window Oxy's media-write limiter uses, and this cooldown's default. */
const WRITE_BUDGET_WINDOW_MS = 60 * 1000;
/** Bounds on a server-supplied `Retry-After`, so a bad header cannot park writes for hours. */
const MIN_COOLDOWN_MS = 1_000;
const MAX_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Per-operation cooldown deadlines, in this process.
 *
 * Deliberately NOT shared through Redis: each task learns the budget is spent
 * from its own first 429, which costs one refused request per task per window
 * and keeps the store client free of a dependency it would otherwise need only
 * for this. The cap it protects is per APPLICATION, so a shared deadline would
 * be more precise but not more correct.
 */
const writeBudgetCooldownUntil: Record<'upload' | 'delete', number> = { upload: 0, delete: 0 };

/** Read `Retry-After` (delta-seconds or HTTP date), bounded; else the budget window. */
function cooldownFromRetryAfter(header: string | string[] | undefined): number {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const seconds = Number(raw.trim());
    const ms = Number.isFinite(seconds) ? seconds * 1000 : new Date(raw).getTime() - Date.now();
    if (Number.isFinite(ms) && ms > 0) {
      return Math.min(Math.max(ms, MIN_COOLDOWN_MS), MAX_COOLDOWN_MS);
    }
  }
  return WRITE_BUDGET_WINDOW_MS;
}

/**
 * Refuse locally while the cooldown holds. Called before the request is built,
 * so a refused write costs no socket, no service token and no stream.
 */
function assertWriteBudget(operation: 'upload' | 'delete'): void {
  const remaining = writeBudgetCooldownUntil[operation] - Date.now();
  if (remaining > 0) {
    throw new OxyMediaStoreThrottledError(operation, remaining);
  }
}

/** Open (or extend) the cooldown after Oxy reported the budget spent. */
function beginWriteBudgetCooldown(
  operation: 'upload' | 'delete',
  retryAfter: string | string[] | undefined,
): OxyMediaStoreThrottledError {
  const cooldownMs = cooldownFromRetryAfter(retryAfter);
  const now = Date.now();
  const until = now + cooldownMs;
  // ONE line per window, not one per refused write — the flood this replaces was
  // itself part of the problem. Gated on whether a cooldown was ALREADY open, not
  // on whether this response's deadline is later than the stored one: two writes
  // refused concurrently both compute `until` from a still-zero deadline, and the
  // second call's `until` is later than the first call's just because it read the
  // clock a moment after — comparing deadlines logged both.
  const wasAlreadyCoolingDown = writeBudgetCooldownUntil[operation] > now;
  if (until > writeBudgetCooldownUntil[operation]) {
    writeBudgetCooldownUntil[operation] = until;
  }
  if (!wasAlreadyCoolingDown) {
    logger.warn('[MediaCache] Oxy media-write budget spent; pausing this operation', {
      operation,
      cooldownSeconds: Math.ceil(cooldownMs / 1000),
    });
  }
  return new OxyMediaStoreThrottledError(operation, cooldownMs);
}

/** Test seam: forget the cooldowns so a case starts from an unspent budget. */
export function resetWriteBudgetCooldowns(): void {
  writeBudgetCooldownUntil.upload = 0;
  writeBudgetCooldownUntil.delete = 0;
}

export interface UploadedAsset {
  oxyFileId: string;
  sizeBytes?: number;
  contentType?: string;
  /**
   * The durable federation route answered with an EXISTING file for the same
   * bytes, owner and application (possibly reactivating a trashed one). The id
   * may therefore be shared, or be one this app earlier asked Oxy to delete.
   */
  deduplicated?: boolean;
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
  /** Cancel the upload, including workload preparation and any safe replay. */
  signal?: AbortSignal;
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
/** The file is not there (any more). */
const HTTP_NOT_FOUND = 404;
/** Oxy's answer when this app's media-write budget for the window is spent. */
const HTTP_TOO_MANY_REQUESTS = 429;
/** Idle socket timeout while streaming a body to / reading a response from oxy-api. */
const OXY_REQUEST_TIMEOUT_MS = 60_000;
/** Cap on the error-body snippet captured for diagnostics (avoid unbounded logs). */
const ERROR_BODY_SNIPPET_BYTES = 1024;

/** Shape of the oxy-api cache-upload success response we depend on. */
interface OxyCacheUploadResponse {
  data?: { file?: { id?: unknown }; deduplicated?: unknown };
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
 * Build the public, servable URL for a cached Oxy file so the proxy can redirect
 * to it and the CDN serves the bytes.
 *
 * SYNCHRONOUS, and deliberately so. Every asset this store creates is public by
 * construction — `POST /assets/service/cache` and `POST /assets/service/federation`
 * both hardcode `visibility: 'public'` precisely so "the existing public download
 * routes can serve cached media without auth" — and a public asset's URL is the
 * deterministic by-id CDN form `https://cloud.oxy.so/<id>`, which `cloud.oxy.so`
 * resolves to the content-addressed object itself. There is nothing to ask.
 *
 * ## Why this used to be a round trip, and why that round trip could never work
 *
 * It called `getFileDownloadUrlAsync`, which asks `GET /assets/:id/url`. That
 * route is behind oxy-api's `authMiddleware`, which accepts only SESSION-based
 * tokens (`if (!decoded.sessionId) return 401`). The media cache holds a SERVICE
 * token, which carries no `sessionId` — so the request was rejected 401 before
 * it ever reached the asset, on every call, and the cache front silently fell
 * back to streaming from the remote host.
 *
 * That is not a hypothesis: six hours of production `/media/proxy` traffic
 * counted 481 cache fronts and 481 failed Oxy calls, ~4ms apiece — the shape of
 * an auth rejection, not of a lookup (the per-status breakdown is on #955). So
 * the read half of this cache has been completely inert: we mirror the bytes
 * into Oxy and then serve every federated image and video by streaming it from
 * the third-party host through our own origin, and when that host is gone the
 * viewer is told the media is unavailable for something we hold.
 *
 * The variant belongs in the builder, not appended afterwards: `cloud.oxy.so`
 * honours `?variant=` on the BY-ID form (its resolver reads it and redirects to
 * the sized render), while a key-form URL goes straight to the S3 origin, where
 * a query string means nothing.
 *
 * `getFileDownloadUrlAsync` remains the right call for an asset whose visibility
 * is unknown or private; the SDK says as much. This store knows.
 */
export function cachedMediaCdnUrl(oxyFileId: string, variant?: string): string {
  return getServiceOxyClient().assets.publicUrl(oxyFileId, variant);
}

/**
 * Resolve the absolute oxy-api base URL from the configured service client. The
 * SDK owns this value (set from `OXY_API_URL`), so we never hardcode a host here.
 */
function getOxyApiBaseUrl(): string {
  return getServiceOxyClient().baseURL.replace(/\/+$/, '');
}

type OxyMediaResponse = Readable & {
  statusCode: number;
  headers: IncomingHttpHeaders;
};

type WorkloadClient = ReturnType<ReturnType<typeof getServiceOxyClient>['createServiceClient']>;
let mediaTransport:
  | { owner: ReturnType<typeof getServiceOxyClient>; client: WorkloadClient }
  | undefined;

function getMediaTransport(): WorkloadClient {
  const owner = getServiceOxyClient();
  if (mediaTransport?.owner !== owner) {
    mediaTransport?.client.dispose();
    mediaTransport = {
      owner,
      client: owner.createServiceClient({ baseURL: owner.baseURL, audience: 'oxy-api' }),
    };
  }
  return mediaTransport.client;
}

/** Read up to {@link ERROR_BODY_SNIPPET_BYTES} of a response body for diagnostics. */
async function readErrorSnippet(response: OxyMediaResponse): Promise<string> {
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    response.on('data', (chunk: Buffer) => {
      if (total >= ERROR_BODY_SNIPPET_BYTES) return;
      const captured = chunk.subarray(0, ERROR_BODY_SNIPPET_BYTES - total);
      total += captured.length;
      chunks.push(captured);
    });
    response.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8').slice(0, ERROR_BODY_SNIPPET_BYTES));
    });
    response.on('error', () => resolve(''));
  });
}

/** Read a full JSON response body and parse it (bounded by the upstream contract). */
async function readJsonResponse(response: OxyMediaResponse): Promise<unknown> {
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
  assertWriteBudget('upload');

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

  assertWriteBudget('upload');

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

  const headers: Record<string, string> = {
    'Content-Type': source.contentType,
    Accept: 'application/json',
    ...extraHeaders,
  };
  if (source.originalName) headers['x-original-name'] = source.originalName;
  if (typeof source.sizeBytes === 'number' && Number.isFinite(source.sizeBytes)) {
    headers['Content-Length'] = String(source.sizeBytes);
  }
  const response = await streamRequest(
    'POST',
    target,
    headers,
    source.filePath,
    undefined,
    source.signal,
  );
  const status = response.statusCode ?? 0;

  if (status === HTTP_TOO_MANY_REQUESTS) {
    response.resume();
    throw beginWriteBudgetCooldown('upload', response.headers['retry-after']);
  }

  if (status !== HTTP_OK && status !== HTTP_CREATED) {
    const detail = await readErrorSnippet(response);
    if (status === HTTP_CONFLICT && errorCodeOf(detail) === OWNED_ELSEWHERE_CODE) {
      throw new OxyMediaOwnedElsewhereError();
    }
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

  return {
    oxyFileId: fileId,
    sizeBytes: source.sizeBytes,
    contentType: source.contentType,
    ...(body?.data?.deduplicated === true ? { deduplicated: true } : {}),
  };
}

/** oxy-api's error code (`{ "error": "<CODE>", "message": … }`), when the body is that shape. */
function errorCodeOf(body: string): string | undefined {
  return errorFieldOf(body, 'error');
}

function errorFieldOf(body: string, field: 'error' | 'message'): string | undefined {
  try {
    const value = (JSON.parse(body) as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The cache namespace holds nothing to delete under this id: the object is
 * already gone (404), or it never was a cache object
 * ({@link OxyMediaNotCacheObjectError}). Either way, retrying cannot succeed.
 */
export function isAbsentFromCacheNamespace(error: unknown): boolean {
  return (
    error instanceof OxyMediaNotCacheObjectError ||
    (error instanceof OxyMediaStoreRequestError && error.statusCode === HTTP_NOT_FOUND)
  );
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
  await deleteFromCacheNamespace(oxyFileId);
}

/**
 * Delete a file the GIF library left in the federation media cache namespace
 * when it moved to application-owned files (ADR 0043;
 * `scripts/migrateGifLibraryToApplicationFiles.ts`). The cache's delete route
 * is the only one that reaches that namespace.
 *
 * NOT gated on {@link isMediaCacheEnabled}: those files were never the media
 * cache's (the library wrote there whatever that flag said), and finishing the
 * move must not depend on it. `not_found` when Oxy no longer has the file.
 */
export async function deleteRetiredGifCacheFile(
  oxyFileId: string,
): Promise<'deleted' | 'not_found'> {
  try {
    await deleteFromCacheNamespace(oxyFileId);
    return 'deleted';
  } catch (error) {
    if (error instanceof OxyMediaStoreRequestError && error.statusCode === HTTP_NOT_FOUND) {
      return 'not_found';
    }
    throw error;
  }
}

async function deleteFromCacheNamespace(oxyFileId: string): Promise<void> {
  assertWriteBudget('delete');

  const target = new URL(
    `${getOxyApiBaseUrl()}${OXY_ASSET_CACHE_PATH}/${encodeURIComponent(oxyFileId)}`,
  );

  const response = await streamRequest('DELETE', target, { Accept: 'application/json' });
  const status = response.statusCode ?? 0;

  if (status === HTTP_TOO_MANY_REQUESTS) {
    response.resume();
    throw beginWriteBudgetCooldown('delete', response.headers['retry-after']);
  }

  if (status !== HTTP_OK && status !== HTTP_NO_CONTENT) {
    const detail = await readErrorSnippet(response);
    if (status === HTTP_FORBIDDEN && errorFieldOf(detail, 'message') === NOT_CACHE_OBJECT_MESSAGE) {
      throw new OxyMediaNotCacheObjectError(detail);
    }
    throw new OxyMediaStoreRequestError('delete', status, detail || 'no response body');
  }

  // Drain any success body so the socket can be released back to the pool.
  response.resume();
  logger.debug('[MediaCache] Deleted cached media from Oxy', { oxyFileId });
}

/** Oxy's per-file answer to a federated-media delete. */
export type FederatedMediaDeleteResult = 'deleted' | 'not_found' | 'forbidden' | 'in_use';

const KNOWN_DELETE_RESULTS: ReadonlySet<string> = new Set([
  'deleted',
  'not_found',
  'forbidden',
  'in_use',
]);

/** The batch route's ceiling (oxy-api validates 1–20 ids). */
export const FEDERATED_MEDIA_DELETE_BATCH_MAX = 20;

/**
 * Delete durable federated media Mention re-hosted (`POST
 * /assets/service/federation/delete`, body `{ ids }`, 1–20 ids). Same raw
 * workload transport and single safe 401 retry as the upload beside it.
 *
 * DELIBERATELY NOT gated on {@link isMediaCacheEnabled}: turning media WRITES
 * off must never stop a deletion — a post deleted at its source (or on
 * Instagram) must not live on as a re-hosted file. Returns Oxy's per-id answer
 * (`in_use`: Oxy keeps the file because another owner or app also holds it;
 * an unknown result is left out, so the caller retries that id);
 * throws {@link OxyMediaStoreThrottledError} on 429 and
 * {@link OxyMediaStoreRequestError} on any other non-200 — including 404 for the
 * ROUTE itself on an oxy-api that predates it, which the caller must retry, never
 * read as "not found".
 */
export async function deleteFederatedMedia(
  fileIds: readonly string[],
): Promise<Array<{ id: string; result: FederatedMediaDeleteResult }>> {
  if (fileIds.length === 0) return [];
  if (fileIds.length > FEDERATED_MEDIA_DELETE_BATCH_MAX) {
    throw new Error(
      `deleteFederatedMedia: at most ${FEDERATED_MEDIA_DELETE_BATCH_MAX} ids per call`,
    );
  }
  assertWriteBudget('delete');

  const target = new URL(`${getOxyApiBaseUrl()}${OXY_ASSET_FEDERATION_PATH}/delete`);
  const body = JSON.stringify({ ids: [...fileIds] });
  const response = await streamRequest(
    'POST',
    target,
    {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
    },
    undefined,
    body,
  );
  const status = response.statusCode ?? 0;

  if (status === HTTP_TOO_MANY_REQUESTS) {
    response.resume();
    throw beginWriteBudgetCooldown('delete', response.headers['retry-after']);
  }
  if (status !== HTTP_OK) {
    const detail = await readErrorSnippet(response);
    throw new OxyMediaStoreRequestError('delete', status, detail || 'no response body');
  }

  const parsed = (await readJsonResponse(response)) as { data?: { results?: unknown } } | undefined;
  const results = Array.isArray(parsed?.data?.results) ? parsed.data.results : null;
  if (!results)
    throw new OxyMediaStoreRequestError('delete', status, 'response missing data.results');
  const asked = new Set(fileIds);
  const unknown: string[] = [];
  const answers = results.flatMap((entry) => {
    const record = entry as { id?: unknown; result?: unknown };
    if (typeof record.id !== 'string' || !asked.has(record.id)) return [];
    if (typeof record.result === 'string' && KNOWN_DELETE_RESULTS.has(record.result)) {
      return [{ id: record.id, result: record.result as FederatedMediaDeleteResult }];
    }
    unknown.push(String(record.result));
    return [];
  });
  if (unknown.length > 0) {
    // A result this build does not know is NOT an answer: the caller treats the
    // id as unanswered and retries it later.
    logger.warn('[MediaCache] Oxy answered an unknown federated-media delete result; will retry', {
      results: [...new Set(unknown)].slice(0, 5),
      files: unknown.length,
    });
  }
  return answers;
}

/**
 * Stream through the shared transport. A fresh disk stream is created only for
 * an authenticated attempt (and its one safe 401 replay). Activity resets the
 * idle deadline; a large active upload is not subject to a total-duration cap.
 * The returned readable keeps the existing response-consumption contract.
 */
async function streamRequest(
  method: 'POST' | 'DELETE',
  target: URL,
  headers: Record<string, string>,
  filePath?: string,
  jsonBody?: string,
  signal?: AbortSignal,
): Promise<OxyMediaResponse> {
  const controller = new AbortController();
  let upload: ReturnType<typeof createReadStream> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const onAbort = () => controller.abort(signal?.reason);
  const finish = () => {
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    upload?.destroy();
  };
  const touch = () => {
    if (finished) return;
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(new Error('oxy-api request timeout')),
      OXY_REQUEST_TIMEOUT_MS,
    );
    timer.unref();
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  touch();
  try {
    const transport = getMediaTransport();
    const init = { method, headers, signal: controller.signal };
    const response = filePath
      ? await transport.fetchReplayable(target, {
          ...init,
          bodyFactory: () => {
            // An early 401 may arrive while the previous disk stream is still
            // open. The shared transport decides replay; this source owns and
            // closes its file handle before providing the next fresh body.
            upload?.destroy();
            const file = createReadStream(filePath, { signal: controller.signal });
            upload = file;
            const chunks: AsyncIterator<Buffer> = file[Symbol.asyncIterator]();
            return new ReadableStream<Uint8Array>({
              async pull(output) {
                const { done, value } = await chunks.next();
                if (done) output.close();
                else {
                  touch();
                  output.enqueue(value);
                }
              },
              async cancel() {
                file.destroy();
                await chunks.return?.();
              },
            });
          },
        })
      : await transport.fetch(target, { ...init, body: jsonBody });
    touch();
    async function* responseBody() {
      const reader = response.body?.getReader();
      try {
        if (!reader) return;
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          touch();
          yield Buffer.from(value);
        }
      } finally {
        finish();
        await reader?.cancel().catch(() => undefined);
        reader?.releaseLock();
      }
    }
    const body = Readable.from(responseBody()) as OxyMediaResponse;
    body.statusCode = response.status;
    body.headers = Object.fromEntries(response.headers.entries());
    return body;
  } catch (error) {
    finish();
    throw error;
  }
}
