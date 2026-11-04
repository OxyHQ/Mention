import { openAsBlob } from 'node:fs';
import {
  type OxyApiError,
  retryAfterSecondsOf,
  type ServiceFederatedMediaDeletion,
} from '@oxy.so/core';

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
 *  - UPLOAD + DELETE: the process `OxyServer`'s federation media methods
 *    (`assets.mediaCache`, `assets.federatedMedia`), as Mention's workload
 *    identity. Upload bodies are a Blob over the temp file (`fs.openAsBlob`),
 *    streamed from disk and never buffered. The store keeps its own domain
 *    rules on top: the write-budget cooldown, the permanent refusals, and no
 *    transport retries (every caller already retries a failed write later).
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
/** The file is not there (any more). */
const HTTP_NOT_FOUND = 404;

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
/** Bounds on a server-supplied wait, so a bad answer cannot park writes for hours. */
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

/** The wait a 429 names (`retryAfterSecondsOf`), bounded; else the budget window. */
function cooldownFromRetryAfter(retryAfterSeconds: number | undefined): number {
  if (retryAfterSeconds === undefined) return WRITE_BUDGET_WINDOW_MS;
  return Math.min(Math.max(retryAfterSeconds * 1000, MIN_COOLDOWN_MS), MAX_COOLDOWN_MS);
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
  retryAfterSeconds: number | undefined,
): OxyMediaStoreThrottledError {
  const cooldownMs = cooldownFromRetryAfter(retryAfterSeconds);
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
  /** Optional original/derived filename sent as `x-original-name` (printable ASCII only). */
  originalName?: string;
  /** Known byte length, reported back on the {@link UploadedAsset}. */
  sizeBytes?: number;
  /** Cancel the upload. */
  signal?: AbortSignal;
}

/**
 * Bound on one upload, request to response: up to `MEDIA_CACHE_MAX_VIDEO_BYTES`
 * streamed to oxy-api, plus Oxy storing it before it answers.
 */
const OXY_UPLOAD_TIMEOUT_MS = 5 * 60_000;
/** Bound on one delete call (a federated batch deletes up to 20 files before answering). */
const OXY_DELETE_TIMEOUT_MS = 60_000;

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
 * The store's answer for an Oxy refusal: a 429 opens the write-budget cooldown,
 * the two permanent refusals get their own types, any other HTTP status is an
 * {@link OxyMediaStoreRequestError}. A failure with no HTTP status (a network
 * error, a timeout) is rethrown as it is.
 */
function rethrowAs(operation: 'upload' | 'delete') {
  return (failure: unknown): never => {
    // Read by shape (the SDK rejects with an `OxyApiError`): `status`, `code`, `message`.
    const error = failure as Partial<OxyApiError> | null;
    if (typeof error?.status !== 'number' || error.status < 400) throw failure;
    const message = error.message ?? '';
    if (error.status === 429) {
      throw beginWriteBudgetCooldown(operation, retryAfterSecondsOf(error));
    }
    if (error.status === 409 && error.code === OWNED_ELSEWHERE_CODE) {
      throw new OxyMediaOwnedElsewhereError();
    }
    if (error.status === HTTP_FORBIDDEN && message === NOT_CACHE_OBJECT_MESSAGE) {
      throw new OxyMediaNotCacheObjectError(message);
    }
    throw new OxyMediaStoreRequestError(operation, error.status, message);
  };
}

/**
 * Upload a media payload to the federation media cache, STREAMING the temp file
 * as the raw request body (never buffering it in memory). Returns the new Oxy
 * file id.
 *
 * Gated behind {@link isMediaCacheEnabled}; throws
 * {@link MediaStoreUnavailableError} when the cache is disabled and
 * {@link OxyMediaStoreRequestError} when Oxy refuses it.
 */
export async function uploadCachedMedia(source: CachedMediaSource): Promise<UploadedAsset> {
  if (!isMediaCacheEnabled()) {
    throw new MediaStoreUnavailableError('upload');
  }
  assertWriteBudget('upload');

  const bytes = await openAsBlob(source.filePath, { type: source.contentType });
  const { file } = await getServiceOxyClient()
    .assets.mediaCache.upload(bytes, source.contentType, uploadDescription(source))
    .catch(rethrowAs('upload'));
  return uploaded(source, file?.id);
}

export interface FederatedMediaSource extends CachedMediaSource {
  ownerUserId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Upload durable federated media to Oxy as a normal public asset owned by the
 * resolved federated Oxy user. This is used when Mention persists post media
 * references directly to file ids, so the file must not be in the cache eviction
 * namespace. Throws {@link OxyMediaOwnedElsewhereError} when the bytes belong to
 * another owner or application.
 */
export async function uploadFederatedMedia(source: FederatedMediaSource): Promise<UploadedAsset> {
  if (!isMediaCacheEnabled()) {
    throw new MediaStoreUnavailableError('upload');
  }
  assertWriteBudget('upload');

  const bytes = await openAsBlob(source.filePath, { type: source.contentType });
  const { file, deduplicated } = await getServiceOxyClient()
    .assets.federatedMedia.upload(source.ownerUserId, bytes, source.contentType, {
      ...uploadDescription(source),
      ...(source.metadata ? { metadata: source.metadata } : {}),
    })
    .catch(rethrowAs('upload'));
  return { ...uploaded(source, file?.id), ...(deduplicated ? { deduplicated: true } : {}) };
}

function uploadDescription(source: CachedMediaSource) {
  return {
    ...(source.originalName ? { originalName: source.originalName } : {}),
    ...(source.signal ? { signal: source.signal } : {}),
    timeout: OXY_UPLOAD_TIMEOUT_MS,
  };
}

function uploaded(source: CachedMediaSource, fileId: string | undefined): UploadedAsset {
  if (typeof fileId !== 'string' || fileId.length === 0) {
    throw new OxyMediaStoreRequestError('upload', 200, 'response missing file.id');
  }
  logger.debug('[MediaCache] Uploaded cached media to Oxy', {
    oxyFileId: fileId,
    contentType: source.contentType,
    sizeBytes: source.sizeBytes,
  });
  return { oxyFileId: fileId, sizeBytes: source.sizeBytes, contentType: source.contentType };
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

/** Delete calls: one attempt, a delete's own bound; a failure is the caller's to retry. */
function deleteScope() {
  return getServiceOxyClient().withCallOptions({ timeout: OXY_DELETE_TIMEOUT_MS, retry: false })
    .assets;
}

async function deleteFromCacheNamespace(oxyFileId: string): Promise<void> {
  assertWriteBudget('delete');
  await deleteScope().mediaCache.delete(oxyFileId).catch(rethrowAs('delete'));
  logger.debug('[MediaCache] Deleted cached media from Oxy', { oxyFileId });
}

/** The batch route's ceiling (oxy-api validates 1–20 ids): one drain batch is one call. */
export const FEDERATED_MEDIA_DELETE_BATCH_MAX = 20;

/**
 * Delete durable federated media Mention re-hosted
 * (`assets.federatedMedia.delete`, `POST /assets/service/federation/delete`).
 *
 * DELIBERATELY NOT gated on {@link isMediaCacheEnabled}: turning media WRITES
 * off must never stop a deletion — a post deleted at its source (or on
 * Instagram) must not live on as a re-hosted file. Returns Oxy's per-id answer
 * (`in_use`: Oxy keeps the file because another owner or app also holds it);
 * an id missing from the answer — one Oxy did not answer for, or answered with
 * a result this build does not know — is unanswered, and the caller retries it.
 * Throws {@link OxyMediaStoreThrottledError} on 429 and
 * {@link OxyMediaStoreRequestError} on any other refusal — including 404 for the
 * ROUTE itself on an oxy-api that predates it, which the caller must retry, never
 * read as "not found".
 */
export async function deleteFederatedMedia(
  fileIds: readonly string[],
): Promise<ServiceFederatedMediaDeletion[]> {
  if (fileIds.length === 0) return [];
  assertWriteBudget('delete');
  return deleteScope()
    .federatedMedia.delete([...fileIds])
    .catch(rethrowAs('delete'));
}
