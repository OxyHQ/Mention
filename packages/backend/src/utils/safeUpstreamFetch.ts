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
  /** Additional request headers to send upstream after the proxy defaults. */
  headers?: Record<string, string>;
  /** When false, return redirect responses after validating the current hop. */
  followRedirects?: boolean;
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
 */
function buildRequestOptions(
  target: URL,
  pinnedIp: string,
  pinnedFamily: 4 | 6,
  extras: UpstreamRequestExtras,
  signal: AbortSignal,
): https.RequestOptions {
  const headers: Record<string, string> = {
    'User-Agent': PROXY_USER_AGENT,
    Accept: 'image/*,video/*,audio/*,*/*;q=0.8',
    // Disable transparent decompression so byte caps measure wire bytes and the
    // buffered prefix is the raw container ffmpeg expects.
    'Accept-Encoding': 'identity',
  };
  Object.assign(headers, extras.headers ?? {});
  if (extras.range) headers.Range = extras.range;
  if (extras.ifNoneMatch) headers['If-None-Match'] = extras.ifNoneMatch;
  if (extras.ifModifiedSince) headers['If-Modified-Since'] = extras.ifModifiedSince;

  return {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    method: 'GET',
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
function fetchOnce(options: https.RequestOptions, isHttps: boolean): Promise<IncomingMessage> {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const transport = isHttps ? https : http;
    const req = transport.request(options, (res) => resolve(res));

    req.setTimeout(UPSTREAM_HEADERS_TIMEOUT_MS, () => {
      req.destroy(new Error('upstream headers timeout'));
    });
    req.on('error', (err) => reject(err));
    req.end();
  });
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
    const options = buildRequestOptions(target, guard.ip, guard.family, extras, signal);
    const response = await fetchOnce(options, target.protocol === 'https:');

    const status = response.statusCode ?? 0;
    if (REDIRECT_STATUS_CODES.has(status)) {
      if (extras.followRedirects === false) {
        return { response, finalUrl: currentUrl };
      }
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
