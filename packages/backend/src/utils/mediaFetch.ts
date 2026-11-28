import type { SafeFetchOptions, SsrfCheckOk } from '@oxy.so/core/server';

/**
 * How Mention asks a remote host for MEDIA — the request every fediverse media
 * fetch sends through the SDK's `safeFetch` (`/media/proxy`, `/media/poster`,
 * `/media/gif`, the media-cache worker, the GIF library import).
 *
 * `safeFetch` owns the security contract: every hop, redirects included, is
 * checked by `assertSafePublicUrl` and the connection is pinned to the address
 * it validated. This module owns only what Mention asks for on top of it.
 */

/** Redirects a media fetch follows, each one re-validated (the SDK default is 5). */
export const MEDIA_FETCH_MAX_REDIRECTS = 3;

/** The User-Agent remote media CDNs see. */
export const PROXY_USER_AGENT = 'MentionMediaProxy/1.0 (+https://mention.earth)';

/** Optional per-request conditional/range headers forwarded to the upstream. */
export interface UpstreamRequestExtras {
  /** Client `Range` header value to forward (proxy seeking support). */
  range?: string;
  /** Client `If-None-Match` validator to forward. */
  ifNoneMatch?: string;
  /** Client `If-Modified-Since` validator to forward. */
  ifModifiedSince?: string;
}

/**
 * The `safeFetch` options of a media fetch. `validated` is the caller's own
 * `assertSafePublicUrl` check of this very URL (`/media/proxy` validates before
 * the URL can reach the cache store), so the first hop is not resolved twice.
 */
export function mediaFetchOptions(
  signal: AbortSignal,
  extras: UpstreamRequestExtras = {},
  validated?: SsrfCheckOk,
): SafeFetchOptions {
  const headers: Record<string, string> = {
    'User-Agent': PROXY_USER_AGENT,
    Accept: 'image/*,video/*,audio/*,*/*;q=0.8',
    // Disable transparent decompression so byte caps measure wire bytes and the
    // buffered prefix is the raw container ffmpeg expects.
    'Accept-Encoding': 'identity',
  };
  if (extras.range) headers.Range = extras.range;
  if (extras.ifNoneMatch) headers['If-None-Match'] = extras.ifNoneMatch;
  if (extras.ifModifiedSince) headers['If-Modified-Since'] = extras.ifModifiedSince;
  return {
    headers,
    maxRedirects: MEDIA_FETCH_MAX_REDIRECTS,
    signal,
    ...(validated ? { validated } : {}),
  };
}
