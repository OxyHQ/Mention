import type { FederatedMediaCacheState } from '../../models/FederatedMediaCache';
import { contentTypeFamilyFromString } from '../../utils/safeUpstreamFetch';
import {
  FEDERATED_BANNER_MAX_BYTES,
  MEDIA_CACHE_BACKOFF_BASE_MS,
  MEDIA_CACHE_BACKOFF_MAX_MS,
  MEDIA_CACHE_MAX_FAIL_COUNT,
  MEDIA_CACHE_MAX_IMAGE_BYTES,
  MEDIA_CACHE_MAX_VIDEO_BYTES,
} from './constants';
import {
  MEDIA_IMAGE_TYPE_PREFIX,
  MEDIA_VIDEO_TYPE_PREFIX,
  isAllowedMediaType,
  isHlsManifestType,
} from './mediaTypes';

/**
 * Pure decision helpers for the federated media cache.
 *
 * These contain NO database or network access so the state-machine behaviour is
 * unit-testable in isolation (matching the existing pure-logic test style for
 * the SSRF guard and video poster). The proxy read-path and the cache worker
 * call these to decide what to do; the side effects live in the store/worker.
 */

/** What the proxy should do for a given cache lookup result. */
export type ProxyServeDecision =
  /** Redirect/stream from Oxy — the bytes are cached. */
  | { action: 'serve-from-oxy'; oxyFileId: string }
  /** Stream from the remote upstream; ALSO enqueue a fresh cache attempt. */
  | { action: 'stream-and-enqueue' }
  /** Stream from the remote upstream; do NOT enqueue (already pending/failed). */
  | { action: 'stream-only' };

/**
 * Minimal projection of a cache row needed to make the serve decision. Accepting
 * a plain shape (not the Mongoose Document) keeps this pure and easy to test.
 */
export interface CacheLookup {
  state: FederatedMediaCacheState;
  oxyFileId?: string;
  /** Stored upstream content type, when the worker recorded one. */
  contentType?: string;
}

/**
 * Decide how the proxy should serve a request given the current cache row.
 *
 * - No row (`undefined`): stream from remote and enqueue a first cache attempt.
 * - `cached` WITH an `oxyFileId`: serve from Oxy.
 * - `cached` WITHOUT an `oxyFileId` (inconsistent): treat as a miss → enqueue.
 * - `pending`: already in flight — stream from remote, do not double-enqueue.
 * - `evicted`: stream from remote and re-enqueue (re-cache on access).
 * - `failed`: stream from remote only — caching gave up for this URL.
 */
export function decideProxyServe(lookup: CacheLookup | undefined): ProxyServeDecision {
  if (!lookup) {
    return { action: 'stream-and-enqueue' };
  }

  // An HLS playlist must never be served from Oxy, whatever the row says: the
  // stored copy is the RAW upstream manifest, and its URIs only become usable
  // once the proxy rewrites them at serve time. `isCacheableMediaType` stops new
  // playlists being stored; this covers rows written before that was true.
  if (isHlsManifestType(contentTypeFamilyFromString(lookup.contentType))) {
    return { action: 'stream-only' };
  }

  switch (lookup.state) {
    case 'cached':
      return lookup.oxyFileId
        ? { action: 'serve-from-oxy', oxyFileId: lookup.oxyFileId }
        : { action: 'stream-and-enqueue' };
    case 'evicted':
      return { action: 'stream-and-enqueue' };
    case 'pending':
      return { action: 'stream-only' };
    case 'failed':
      return { action: 'stream-only' };
    default:
      return { action: 'stream-only' };
  }
}

/** True when the content-type family is one this cache is willing to store. */
export function isCacheableMediaType(contentType: string): boolean {
  return isAllowedMediaType(contentTypeFamilyFromString(contentType));
}

/** True when the content type denotes a video (poster extraction applies). */
export function isVideoType(contentType: string): boolean {
  return contentTypeFamilyFromString(contentType).startsWith(MEDIA_VIDEO_TYPE_PREFIX);
}

/** The per-type size cap above which media stays proxy-only (marked `failed`). */
export function maxBytesForType(contentType: string): number {
  return isVideoType(contentType) ? MEDIA_CACHE_MAX_VIDEO_BYTES : MEDIA_CACHE_MAX_IMAGE_BYTES;
}

/**
 * An optional, call-site-specific NARROWING of the generic federated-media
 * download rules, for callers whose media has a tighter contract than "any
 * federated media".
 *
 * It can only ever narrow, never widen: {@link isAllowedByDownloadPolicy}
 * INTERSECTS with {@link isCacheableMediaType} and {@link maxBytesForDownload}
 * takes the MINIMUM of the per-type cap and the caller's ceiling. So a policy can
 * never re-admit something the generic rules reject (`image/svg+xml` stays
 * rejected via the generic branch) nor raise a per-type size cap.
 */
export interface MediaDownloadPolicy {
  /** Content-type family prefixes this call site accepts (e.g. `['image/']`). */
  allowedContentTypePrefixes: readonly string[];
  /** Byte ceiling for this call site, intersected with the per-type cap. */
  maxBytes: number;
}

/**
 * Download policy for a federated actor's profile banner.
 *
 * A banner is a single decorative STILL IMAGE, so it accepts `image/` only. The
 * generic federated-media policy also allows `video/` and `audio/` because
 * federated POST media legitimately carries them — but a video "banner" is never
 * a real banner, and accepting one made every actor resolve mirror a video-sized
 * body to S3 and run poster extraction over it. This bound is about what a banner
 * IS, so it holds regardless of how the generic per-type caps are tuned later.
 */
export const FEDERATED_BANNER_DOWNLOAD_POLICY: MediaDownloadPolicy = {
  allowedContentTypePrefixes: [MEDIA_IMAGE_TYPE_PREFIX],
  maxBytes: FEDERATED_BANNER_MAX_BYTES,
};

/**
 * True when a content type satisfies BOTH the generic cacheable-media rules and
 * the caller's optional narrowing policy. With no policy this is exactly
 * {@link isCacheableMediaType}.
 */
export function isAllowedByDownloadPolicy(
  contentType: string,
  policy?: MediaDownloadPolicy,
): boolean {
  if (!isCacheableMediaType(contentType)) return false;
  if (!policy) return true;
  const family = contentTypeFamilyFromString(contentType);
  return policy.allowedContentTypePrefixes.some((prefix) => family.startsWith(prefix));
}

/**
 * The effective byte cap for a download: the per-type cap from
 * {@link maxBytesForType}, further narrowed by the caller's ceiling when a policy
 * is supplied. Callers enforce this on BOTH the declared `content-length` and the
 * streamed byte count, so a lying `content-length` is still caught mid-stream.
 */
export function maxBytesForDownload(contentType: string, policy?: MediaDownloadPolicy): number {
  const perType = maxBytesForType(contentType);
  return policy ? Math.min(perType, policy.maxBytes) : perType;
}

/**
 * Given the number of consecutive failures (AFTER incrementing for the latest
 * failure), decide whether the entry should give up (`failed`) or be retried
 * after an exponential backoff.
 */
export type FailureOutcome =
  | { giveUp: true }
  | { giveUp: false; nextAttemptInMs: number };

export function classifyFailure(failCountAfterIncrement: number): FailureOutcome {
  if (failCountAfterIncrement >= MEDIA_CACHE_MAX_FAIL_COUNT) {
    return { giveUp: true };
  }
  // Exponential backoff: base * 2^(n-1), capped.
  const exponent = Math.max(0, failCountAfterIncrement - 1);
  const backoff = Math.min(
    MEDIA_CACHE_BACKOFF_BASE_MS * 2 ** exponent,
    MEDIA_CACHE_BACKOFF_MAX_MS,
  );
  return { giveUp: false, nextAttemptInMs: backoff };
}
