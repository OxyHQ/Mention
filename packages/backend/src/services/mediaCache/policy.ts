import type { FederatedMediaCacheState } from '../../models/FederatedMediaCache';
import {
  MEDIA_CACHE_ALLOWED_TYPE_PREFIXES,
  MEDIA_CACHE_BACKOFF_BASE_MS,
  MEDIA_CACHE_BACKOFF_MAX_MS,
  MEDIA_CACHE_MAX_FAIL_COUNT,
  MEDIA_CACHE_MAX_IMAGE_BYTES,
  MEDIA_CACHE_MAX_VIDEO_BYTES,
  MEDIA_CACHE_REJECTED_TYPES,
  MEDIA_CACHE_VIDEO_TYPE_PREFIX,
} from './constants';

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
  const family = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (MEDIA_CACHE_REJECTED_TYPES.has(family)) return false;
  return MEDIA_CACHE_ALLOWED_TYPE_PREFIXES.some((prefix) => family.startsWith(prefix));
}

/** True when the content type denotes a video (poster extraction applies). */
export function isVideoType(contentType: string): boolean {
  const family = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return family.startsWith(MEDIA_CACHE_VIDEO_TYPE_PREFIX);
}

/** The per-type size cap above which media stays proxy-only (marked `failed`). */
export function maxBytesForType(contentType: string): number {
  return isVideoType(contentType) ? MEDIA_CACHE_MAX_VIDEO_BYTES : MEDIA_CACHE_MAX_IMAGE_BYTES;
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
