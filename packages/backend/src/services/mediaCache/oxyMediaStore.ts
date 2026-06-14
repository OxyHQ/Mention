import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { logger } from '../../utils/logger';
import { MEDIA_CACHE_OXY_APP, MEDIA_CACHE_OXY_VISIBILITY, MEDIA_CACHE_WRITE_ENABLED } from './constants';

/**
 * Thin boundary over the Oxy asset operations the media cache needs from the
 * BACKEND SERVICE CLIENT (no end-user in the request). Isolating them here keeps
 * the upstream-capability dependency in ONE place.
 *
 * CAPABILITY STATUS (see upstream report):
 *  - DOWNLOAD-URL resolution works today: `getFileDownloadUrlAsync` returns a
 *    signed CDN URL the proxy can 302-redirect to.
 *  - UPLOAD + DELETE are BLOCKED on upstream. Oxy `POST /assets/upload` and
 *    `DELETE /assets/:id` are gated by `authMiddleware`, which only accepts
 *    session-USER tokens (it rejects tokens without a `sessionId`, i.e. all
 *    service tokens). The SDK's `uploadRawFile`/`deleteFile` also send via the
 *    plain request path, which never attaches the configured service token.
 *    There is no on-behalf-of (`X-Oxy-User-Id`) path for asset writes. So a
 *    backend service client CANNOT upload or delete arbitrary post media today.
 *
 * Per "Fix Upstream, Never Patch", we do NOT fabricate a workaround. Upload and
 * delete throw {@link MediaStoreUnavailableError} unless the write side has been
 * explicitly enabled (after the upstream service-token asset path lands) — and
 * the worker/eviction jobs short-circuit on the same flag so no broken write
 * traffic is generated in the meantime.
 */

/** Raised when an Oxy write capability the cache needs is not available. */
export class MediaStoreUnavailableError extends Error {
  constructor(operation: 'upload' | 'delete') {
    super(
      `Oxy media store ${operation} is unavailable: the backend service client cannot ` +
        `${operation} assets until oxy-api exposes a service-token asset path (blocked upstream).`,
    );
    this.name = 'MediaStoreUnavailableError';
  }
}

export interface UploadedAsset {
  oxyFileId: string;
  sizeBytes?: number;
  contentType?: string;
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
 * Upload a media payload to Oxy S3 from the backend service client.
 *
 * BLOCKED UPSTREAM: see module docs. Throws {@link MediaStoreUnavailableError}
 * until the write side is enabled. When enabled, this is the single call site
 * that must invoke the (future) service-token-capable upload.
 */
export async function uploadCachedMedia(
  _payload: Blob,
  _filename: string,
  _contentType: string,
): Promise<UploadedAsset> {
  if (!isMediaStoreWriteEnabled()) {
    throw new MediaStoreUnavailableError('upload');
  }
  // NOTE: This branch only runs once the upstream service-token asset upload
  // path exists. The exact call (e.g. a future service-scoped uploadRawFile) is
  // wired here at that point; we intentionally do not call the user-token-only
  // `uploadRawFile` today because it would silently produce unauthenticated
  // requests against oxy-api. Until then the guard above makes this unreachable.
  logger.error('[MediaCache] uploadCachedMedia invoked while write enabled but unwired', {
    app: MEDIA_CACHE_OXY_APP,
    visibility: MEDIA_CACHE_OXY_VISIBILITY,
  });
  throw new MediaStoreUnavailableError('upload');
}

/**
 * Delete a previously-cached Oxy file (used by the eviction job).
 *
 * BLOCKED UPSTREAM: see module docs. Throws {@link MediaStoreUnavailableError}
 * until the write side is enabled.
 */
export async function deleteCachedMedia(_oxyFileId: string): Promise<void> {
  if (!isMediaStoreWriteEnabled()) {
    throw new MediaStoreUnavailableError('delete');
  }
  logger.error('[MediaCache] deleteCachedMedia invoked while write enabled but unwired');
  throw new MediaStoreUnavailableError('delete');
}
