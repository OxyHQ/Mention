/**
 * Single source of truth for the media content-type allow/deny policy shared by
 * the media proxy/poster routes and the federated media cache.
 *
 * Both the proxy (which decides whether to RELAY an upstream body) and the cache
 * (which decides whether to STORE it) gate on the exact same rule: only
 * image/video/audio families, and never `image/svg+xml` (an XML document that
 * can embed `<script>`/event handlers — relaying it same-origin enables stored
 * XSS). Defining it once keeps the two paths from drifting apart.
 *
 * HLS playlists are the one media class that is NEITHER of those things: they
 * are not self-contained bytes but a manifest of further URIs, so they are
 * excluded from {@link isAllowedMediaType} entirely and handled by the proxy's
 * own rewrite branch ({@link isHlsManifestType} +
 * {@link import('../../utils/hlsManifest.js').rewriteHlsManifest}).
 */

/** Prefix used to detect a still-image content-type family. */
export const MEDIA_IMAGE_TYPE_PREFIX = 'image/';

/** Prefix used to detect a video content-type family (poster extraction applies). */
export const MEDIA_VIDEO_TYPE_PREFIX = 'video/';

/** Content-type families this platform is willing to relay/store verbatim. */
export const MEDIA_ALLOWED_TYPE_PREFIXES = [
  MEDIA_IMAGE_TYPE_PREFIX,
  MEDIA_VIDEO_TYPE_PREFIX,
  'audio/',
] as const;

/**
 * Content types explicitly rejected even though they match an allowed prefix.
 * SVG matches `image/` but is an XML document that can embed scripts; we never
 * relay or store it same-origin.
 */
export const MEDIA_REJECTED_TYPES: ReadonlySet<string> = new Set(['image/svg+xml']);

/**
 * Content types that denote an HLS (RFC 8216) playlist. `.m3u8` has no single
 * registered type and servers disagree: the Apple-registered one, the older
 * `x-` vendor forms, and the `audio/` spellings that Apache/nginx default mime
 * maps still emit for `.m3u`/`.m3u8` are all seen in the wild.
 */
export const HLS_MANIFEST_TYPES: ReadonlySet<string> = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
  'video/mpegurl',
  'video/x-mpegurl',
]);

/**
 * True when a (parameter-stripped, lowercased) content-type family denotes an
 * HLS playlist.
 *
 * A playlist is a manifest of segment/variant URIs, not media bytes: relaying it
 * verbatim hands the client URIs it will resolve against OUR proxy URL (breaking
 * relative URIs outright) or fetch straight from the remote CDN (escaping the
 * SSRF guard, the size caps and the negative cache). Storing it in the S3
 * activity cache is worse still — the cached copy would be served back
 * un-rewritten forever. So playlists take the proxy's rewrite branch and are
 * excluded from every "relay/store verbatim" decision.
 */
export function isHlsManifestType(family: string): boolean {
  return HLS_MANIFEST_TYPES.has(family);
}

/**
 * True when a (parameter-stripped, lowercased) content-type family is an allowed
 * media type. Callers pass the bare family produced by
 * {@link import('../../utils/safeUpstreamFetch.js').contentTypeFamily}.
 */
export function isAllowedMediaType(family: string): boolean {
  if (MEDIA_REJECTED_TYPES.has(family)) return false;
  // Note the `audio/…` and `video/…` playlist spellings would otherwise pass the
  // prefix test below; they must not, for the reasons in `isHlsManifestType`.
  if (isHlsManifestType(family)) return false;
  return MEDIA_ALLOWED_TYPE_PREFIXES.some((prefix) => family.startsWith(prefix));
}
