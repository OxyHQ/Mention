import http, { IncomingMessage, IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import type { LookupAddress, LookupAllOptions, LookupOneOptions } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { URL } from 'node:url';
import { assertSafePublicUrl } from './ssrfGuard';

/**
 * Shared SSRF-safe upstream HTTP fetch primitives.
 *
 * Both `/media/proxy` (streams the body to the client) and `/media/poster`
 * (buffers a bounded prefix to a temp file for ffmpeg) MUST contact remote
 * fediverse origins under the exact same security contract:
 *
 *  - every URL — including each redirect hop — is validated by
 *    `assertSafePublicUrl` (DNS resolution + private/reserved-range denylist),
 *  - the TCP connection is PINNED to the validated IP via a custom `lookup`,
 *    closing the DNS-rebind TOCTOU window (we never re-resolve at connect time),
 *  - redirects are followed manually so each hop is re-validated and redirect
 *    bodies (potentially unbounded) are destroyed rather than drained.
 *
 * This module centralizes that logic so the security-critical code lives in ONE
 * place; each route layers its own body handling (stream vs. buffer) on top of
 * the validated, non-redirect `IncomingMessage` returned here.
 */

/**
 * Time-to-first-byte deadline: how long we wait for the upstream to ESTABLISH
 * the connection and send its RESPONSE HEADERS before aborting.
 *
 * This is enforced via `req.setTimeout` on the `ClientRequest` inside
 * {@link fetchOnce}, which fires on socket inactivity DURING the request phase
 * (connect + waiting for the status line/headers). Once headers arrive,
 * `fetchOnce` resolves with the `IncomingMessage` and the caller attaches its
 * OWN, longer idle timeout to the response body — so this deadline governs only
 * "is the remote alive and answering", NOT the streaming duration of a large
 * video that has already started flowing. Kept tight (8s) so a slow/dead remote
 * is abandoned quickly, collapsing the p99 latency tail, while big-file
 * streaming is unaffected because it is past this point.
 */
export const UPSTREAM_HEADERS_TIMEOUT_MS = 8_000;

/** Maximum number of HTTP redirects to follow; each hop is re-validated. */
export const MAX_REDIRECTS = 3;

/** Default User-Agent presented to upstream fediverse CDNs. */
export const PROXY_USER_AGENT = 'MentionMediaProxy/1.0 (+https://mention.earth)';

/** HTTP status codes that indicate a redirect we should follow. */
const REDIRECT_STATUS_CODES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Marker error for a blocked SSRF target (maps to 403 at the route layer). */
export class SsrfRejection extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SsrfRejection';
  }
}

/** Marker error for a generic upstream failure (maps to 502 at the route layer). */
export class UpstreamError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UpstreamError';
  }
}

/** Optional per-request conditional/range headers forwarded to the upstream. */
export interface UpstreamRequestExtras {
  /** Client `Range` header value to forward (proxy seeking support). */
  range?: string;
  /** Client `If-None-Match` validator to forward. */
  ifNoneMatch?: string;
  /** Client `If-Modified-Since` validator to forward. */
  ifModifiedSince?: string;
}

export interface UpstreamResult {
  /** The first non-redirect response. Caller owns draining/destroying it. */
  response: IncomingMessage;
  /** The final, post-redirect URL that produced the response. */
  finalUrl: string;
}

/**
 * Build the request options for a single hop, pinning the TCP connection to the
 * already-validated IP via a custom `lookup`. This closes the DNS-rebind TOCTOU
 * window: the address we validated is exactly the address Node connects to.
 *
 * `headers` are the EXACT request headers to send (already assembled by the
 * caller). The media-proxy path passes its media-oriented header set; the
 * federation `signedFetch` path passes its HTTP-signature + Accept headers.
 */
function buildRequestOptions(
  target: URL,
  pinnedIp: string,
  pinnedFamily: 4 | 6,
  headers: Record<string, string>,
  signal: AbortSignal,
  method = 'GET',
): https.RequestOptions {
  return {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    method,
    headers,
    // Aborts the in-flight request when an external deadline fires.
    signal,
    // Pin the connection to the validated IP — DNS is NOT re-resolved here.
    // The runtime (notably Bun) may invoke a custom lookup with `{ all: true }`
    // and then sort the result internally (`results.sort(...)`), so when `all`
    // is requested we MUST return an array of { address, family } — returning a
    // single value makes that internal sort throw `results.sort is not a function`.
    lookup: ((
      _hostname: string,
      options: number | LookupOneOptions | LookupAllOptions,
      callback: (
        err: NodeJS.ErrnoException | null,
        address: string | LookupAddress[],
        family?: number,
      ) => void,
    ): void => {
      const wantsAll = typeof options === 'object' && options !== null && options.all === true;
      if (wantsAll) {
        callback(null, [{ address: pinnedIp, family: pinnedFamily }]);
      } else {
        callback(null, pinnedIp, pinnedFamily);
      }
    }) as unknown as LookupFunction,
  };
}

/** Perform a single upstream GET (no auto-redirect). */
function fetchOnce(
  options: https.RequestOptions,
  isHttps: boolean,
  headersTimeoutMs: number = UPSTREAM_HEADERS_TIMEOUT_MS,
  body?: string | Buffer,
): Promise<IncomingMessage> {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const transport = isHttps ? https : http;
    const req = transport.request(options, (res) => resolve(res));

    req.setTimeout(headersTimeoutMs, () => {
      req.destroy(new Error('upstream headers timeout'));
    });
    req.on('error', (err) => reject(err));
    req.end(body);
  });
}

/** Build the media-proxy request headers from the optional conditional/range extras. */
function buildMediaProxyHeaders(extras: UpstreamRequestExtras): Record<string, string> {
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
  return headers;
}

/**
 * Fetch the upstream resource, following up to {@link MAX_REDIRECTS} redirects
 * and re-running the SSRF check (DNS + IP-range validation) on EVERY hop.
 * Returns the first non-redirect response; redirect bodies are destroyed.
 *
 * Throws {@link SsrfRejection} when any hop targets a blocked address and
 * {@link UpstreamError} on redirect-loop / malformed-redirect failures.
 */
export async function fetchUpstreamFollowingRedirects(
  initialUrl: string,
  extras: UpstreamRequestExtras,
  signal: AbortSignal,
): Promise<UpstreamResult> {
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const guard = await assertSafePublicUrl(currentUrl);
    if (!guard.ok) {
      throw new SsrfRejection(guard.reason);
    }

    const target = new URL(currentUrl);
    const options = buildRequestOptions(target, guard.ip, guard.family, buildMediaProxyHeaders(extras), signal);
    const response = await fetchOnce(options, target.protocol === 'https:');

    const status = response.statusCode ?? 0;
    if (REDIRECT_STATUS_CODES.has(status)) {
      const location = response.headers.location;
      // We only need the Location header. Destroy immediately rather than
      // draining (resume()) the redirect body, which could be unbounded.
      response.destroy();

      if (hop === MAX_REDIRECTS) {
        throw new UpstreamError('too many redirects');
      }
      if (!location || typeof location !== 'string') {
        throw new UpstreamError('redirect without location');
      }
      // Resolve relative redirects against the current URL.
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return { response, finalUrl: currentUrl };
  }

  // Unreachable: the loop either returns a response or throws.
  throw new UpstreamError('redirect loop exhausted');
}

/** A single, IP-pinned upstream response (which MAY be a redirect). */
export interface SingleHopResult {
  /** The raw response. The caller OWNS draining/destroying this stream. */
  response: IncomingMessage;
  /** The HTTP status code (may be a 3xx redirect — NOT followed here). */
  status: number;
  /** Response headers. */
  headers: IncomingHttpHeaders;
}

/** Options for {@link fetchUpstreamSingleHop}. */
export interface SingleHopOptions {
  /** HTTP method to use for this single hop. Defaults to GET. */
  method?: 'GET' | 'POST';
  /** The EXACT request headers to send (the caller assembles these). */
  headers: Record<string, string>;
  /** Optional request body for POST deliveries. */
  body?: string | Buffer;
  /** Aborts the in-flight request when the signal fires. */
  signal: AbortSignal;
  /** Time-to-first-byte deadline; defaults to {@link UPSTREAM_HEADERS_TIMEOUT_MS}. */
  headersTimeoutMs?: number;
}

/**
 * Perform ONE SSRF-safe upstream GET. The URL is validated by
 * {@link assertSafePublicUrl} and the TCP connection is PINNED to the validated
 * IP via a custom `lookup` — DNS is NOT re-resolved at connect time, closing the
 * DNS-rebind TOCTOU window.
 *
 * Unlike {@link fetchUpstreamFollowingRedirects}, redirects are NOT followed:
 * the redirect response (status + `location` header) is returned to the caller,
 * which decides whether/how to follow (e.g. {@link signedFetch} re-signs and
 * re-validates each hop). Used for signed ActivityPub fetches where each hop
 * needs its own HTTP signature and the caller may enforce a stricter per-hop
 * policy.
 *
 * @throws {SsrfRejection} when the target is a blocked address/host/port.
 */
export async function fetchUpstreamSingleHop(
  url: string,
  options: SingleHopOptions,
): Promise<SingleHopResult> {
  const guard = await assertSafePublicUrl(url);
  if (!guard.ok) {
    throw new SsrfRejection(guard.reason);
  }

  const target = new URL(url);
  const requestOptions = buildRequestOptions(
    target,
    guard.ip,
    guard.family,
    options.headers,
    options.signal,
    options.method ?? 'GET',
  );
  const response = await fetchOnce(
    requestOptions,
    target.protocol === 'https:',
    options.headersTimeoutMs,
    options.body,
  );
  return {
    response,
    status: response.statusCode ?? 0,
    headers: response.headers,
  };
}

/**
 * Extract the bare media type family from a raw content-type string (strips
 * parameters and casing). E.g. `'IMAGE/PNG; charset=binary'` → `'image/png'`.
 */
export function contentTypeFamilyFromString(raw: string | undefined): string {
  if (typeof raw !== 'string') return '';
  return raw.split(';')[0]?.trim().toLowerCase() ?? '';
}

/** Extract the bare media type family from response headers. */
export function contentTypeFamily(headers: IncomingHttpHeaders): string {
  const raw = headers['content-type'];
  return contentTypeFamilyFromString(typeof raw === 'string' ? raw : undefined);
}
