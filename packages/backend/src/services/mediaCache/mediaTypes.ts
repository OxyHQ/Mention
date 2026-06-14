/**
 * Single source of truth for the media content-type allow/deny policy shared by
 * the media proxy/poster routes and the federated media cache.
 *
 * Both the proxy (which decides whether to RELAY an upstream body) and the cache
 * (which decides whether to STORE it) gate on the exact same rule: only
 * image/video/audio families, and never `image/svg+xml` (an XML document that
 * can embed `<script>`/event handlers — relaying it same-origin enables stored
 * XSS). Defining it once keeps the two paths from drifting apart.
 */

/** Content-type families this platform is willing to relay/store. */
export const MEDIA_ALLOWED_TYPE_PREFIXES = ['image/', 'video/', 'audio/'] as const;

/**
 * Content types explicitly rejected even though they match an allowed prefix.
 * SVG matches `image/` but is an XML document that can embed scripts; we never
 * relay or store it same-origin.
 */
export const MEDIA_REJECTED_TYPES: ReadonlySet<string> = new Set(['image/svg+xml']);

/** Prefix used to detect a video content-type family (poster extraction applies). */
export const MEDIA_VIDEO_TYPE_PREFIX = 'video/';

/**
 * True when a (parameter-stripped, lowercased) content-type family is an allowed
 * media type. Callers pass the bare family produced by
 * {@link import('../../utils/safeUpstreamFetch').contentTypeFamily}.
 */
export function isAllowedMediaType(family: string): boolean {
  if (MEDIA_REJECTED_TYPES.has(family)) return false;
  return MEDIA_ALLOWED_TYPE_PREFIXES.some((prefix) => family.startsWith(prefix));
}
