import { fetchUpstreamSingleHop } from '../../utils/safeUpstreamFetch';
import { readBoundedResponseBody } from '../shared/httpBody';

/**
 * Thin, SSRF-safe XRPC client for the AT Protocol.
 *
 * The atproto connector NEVER uses `@atproto/api`. Every outbound GET — AppView
 * XRPC queries, PLC directory lookups, did:web `did.json`, `.well-known`
 * documents — goes through the same IP-pinned single-hop fetch the federation
 * media proxy and signed ActivityPub fetches use (`fetchUpstreamSingleHop`):
 *
 *  - the URL is validated by `assertSafePublicUrl` (DNS resolution + private /
 *    reserved-range denylist) and the TCP connection is PINNED to the validated
 *    IP, closing the DNS-rebind TOCTOU window;
 *  - the response body is read with a hard byte cap so a hostile remote cannot
 *    make us buffer an unbounded payload;
 *  - a time-to-first-byte deadline abandons slow/dead hosts.
 *
 * Redirects are NOT followed (XRPC / PLC / did:web endpoints answer directly);
 * a 3xx is surfaced as a non-2xx error.
 */

/** Time-to-first-byte + overall read deadline for an atproto GET. */
const XRPC_TIMEOUT_MS = 8_000;

/** Maximum JSON document size accepted from any atproto endpoint (2 MiB). */
const MAX_JSON_BYTES = 2 * 1024 * 1024;

/** Maximum text document size (e.g. `.well-known/atproto-did`) — DIDs are short. */
const MAX_TEXT_BYTES = 4 * 1024;

/** User-Agent presented to atproto hosts. */
const USER_AGENT = 'Mention/atproto-connector (+https://mention.earth)';

/** A failed atproto GET (non-2xx upstream, transport error, or invalid body). */
export class XrpcError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'XrpcError';
    this.status = status;
  }
}

/** Query-string parameter values an XRPC endpoint accepts. */
export type XrpcParams = Record<string, string | number | boolean | undefined>;

/** Build the absolute XRPC URL for `host`/`nsid` with `params` query-encoded. */
export function buildXrpcUrl(host: string, nsid: string, params: XrpcParams = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return `https://${host}/xrpc/${nsid}${qs ? `?${qs}` : ''}`;
}

/** Common bounded GET used for both JSON and text reads. */
async function safeGet(
  url: string,
  accept: string,
  maxBytes: number,
): Promise<Buffer> {
  const deadline = AbortSignal.timeout(XRPC_TIMEOUT_MS);
  const { response, status } = await fetchUpstreamSingleHop(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: accept },
    signal: deadline,
    headersTimeoutMs: XRPC_TIMEOUT_MS,
  });

  if (status < 200 || status >= 300) {
    response.destroy();
    throw new XrpcError(`atproto GET ${url} returned ${status}`, status);
  }

  const buffer = await readBoundedResponseBody(response, maxBytes);
  return Buffer.from(buffer);
}

/** Fetch + parse a JSON document from `url`. Throws {@link XrpcError} on failure. */
export async function safeGetJson<T = unknown>(url: string): Promise<T> {
  const buffer = await safeGet(url, 'application/json', MAX_JSON_BYTES);
  try {
    return JSON.parse(buffer.toString('utf8')) as T;
  } catch {
    throw new XrpcError(`atproto GET ${url} returned invalid JSON`);
  }
}

/** Fetch a short text document (e.g. `.well-known/atproto-did`), trimmed. */
export async function safeGetText(url: string): Promise<string> {
  const buffer = await safeGet(url, 'text/plain', MAX_TEXT_BYTES);
  return buffer.toString('utf8').trim();
}

/**
 * Perform an XRPC query: `GET https://{host}/xrpc/{nsid}?{params}` and parse the
 * JSON response. Throws {@link XrpcError} on any non-2xx / transport / parse
 * failure so callers can fail soft.
 */
export function xrpcGet<T = unknown>(host: string, nsid: string, params: XrpcParams = {}): Promise<T> {
  return safeGetJson<T>(buildXrpcUrl(host, nsid, params));
}
