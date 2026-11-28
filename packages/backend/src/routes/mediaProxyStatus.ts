/**
 * Pure status-mapping for the `/media/proxy` endpoint.
 *
 * Kept in its own module (no Express/Redis imports) so it can be unit-tested in
 * isolation and reasoned about independently of the streaming route.
 *
 * The proxy relays remote fediverse media. Remote servers routinely answer with
 * client-class errors for media that was deleted, made private, or is
 * hotlink-protected (observed in prod: 403 ≫ 404). Those are NOT failures of our
 * gateway — the correct answer to the client is "this asset is Not Found", a 404.
 * Relaying them as 502 (the previous behaviour) both mislabels the result and
 * pollutes our 5xx rate. A 502 is reserved for a genuine upstream 5xx or a
 * connection/network failure, which signals a real gateway problem.
 */

/** How the proxy should react to a given upstream status. */
export type UpstreamStatusClass =
  /** 200/206 — a media body we relay to the client. */
  | 'media'
  /** 304 — conditional request hit; relay validators, no body. */
  | 'not-modified'
  /** 416 — range not satisfiable; relay Content-Range, no body. */
  | 'range-not-satisfiable'
  /** 4xx (deleted/forbidden/gone/etc.) — respond 404 from our proxy. */
  | 'client-error'
  /** 5xx or unknown — genuine upstream failure; respond 502. */
  | 'upstream-error';

const HTTP_OK = 200;
const HTTP_PARTIAL_CONTENT = 206;
const HTTP_NOT_MODIFIED = 304;
const HTTP_RANGE_NOT_SATISFIABLE = 416;
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_SERVER_ERROR_MIN = 500;
const HTTP_SERVER_ERROR_MAX = 599;

/**
 * Classify an upstream HTTP status into the proxy's reaction.
 *
 *  - 200/206                 → `media`
 *  - 304                     → `not-modified`
 *  - 416                     → `range-not-satisfiable`
 *  - any other 4xx           → `client-error`  (we answer 404)
 *  - any 5xx                 → `upstream-error` (we answer 502)
 *  - anything unexpected (0, 1xx, 3xx that isn't 304, ≥600) → `upstream-error`
 *
 * `client-error` deliberately covers the full 4xx range, not just 403/404/410:
 * any client-class answer means the remote will not give us a body, and from the
 * browser's perspective the asset is unavailable → Not Found.
 */
export function classifyUpstreamStatus(status: number): UpstreamStatusClass {
  if (status === HTTP_OK || status === HTTP_PARTIAL_CONTENT) return 'media';
  if (status === HTTP_NOT_MODIFIED) return 'not-modified';
  if (status === HTTP_RANGE_NOT_SATISFIABLE) return 'range-not-satisfiable';
  if (status >= HTTP_SERVER_ERROR_MIN && status <= HTTP_SERVER_ERROR_MAX) return 'upstream-error';
  if (status >= HTTP_CLIENT_ERROR_MIN && status < HTTP_SERVER_ERROR_MIN) return 'client-error';
  // 0/1xx/3xx-non-304/≥600 are not statuses we can usefully relay — treat as a
  // gateway problem rather than silently 404-ing a possibly-transient condition.
  return 'upstream-error';
}
