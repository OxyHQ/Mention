import type { IncomingHttpHeaders } from 'node:http';
import { readResponseBody, safeFetch } from '@oxy.so/core/server';
import { sleep } from '../../utils/sleep';
import { backoffDelayMs } from '../../utils/backoff';

/**
 * Thin, SSRF-safe XRPC client for the AT Protocol.
 *
 * The atproto connector NEVER uses `@atproto/api`. Every outbound GET — AppView
 * XRPC queries, PLC directory lookups, did:web `did.json`, `.well-known`
 * documents — goes through the same IP-pinned single-hop fetch the federation
 * media proxy and signed ActivityPub fetches use (core's `safeFetch`, `redirect: 'manual'`):
 *
 *  - the URL is validated by `assertSafePublicUrl` (DNS resolution + private /
 *    reserved-range denylist) and the TCP connection is PINNED to the validated
 *    IP, closing the DNS-rebind TOCTOU window;
 *  - the response body is read with core's `readResponseBody`: a hard byte cap
 *    so a hostile remote cannot make us buffer an unbounded payload, and a
 *    whole-body deadline so one that stalls after its headers cannot hold us;
 *  - a time-to-first-byte deadline abandons slow/dead hosts.
 *
 * Redirects are NOT followed (XRPC / PLC / did:web endpoints answer directly);
 * a 3xx is surfaced as a non-2xx error.
 *
 * It is also the ONE place Mention is polite to an atproto host, so no caller
 * can forget to be:
 *
 *  - at most {@link MAX_IN_FLIGHT_PER_HOST} requests run against one host at a
 *    time; the rest wait their turn here instead of piling onto it;
 *  - a `429` (or a `503`) pauses the WHOLE host, not just the request that saw
 *    it, for as long as the host asked (`Retry-After`, else atproto's
 *    `RateLimit-Reset`, else a bounded exponential backoff), and the request is
 *    retried up to {@link MAX_ATTEMPTS} times. Bluesky rate-limits per client IP,
 *    and every Mention task egresses from the same NAT, so a request that
 *    ignored a sibling's 429 would only extend the penalty for both;
 *  - a pause longer than {@link MAX_RETRY_WAIT_MS} is not waited out inside a
 *    request: the call fails fast with a `429` {@link XrpcError} until the pause
 *    ends, and the caller's own fail-soft path (a later sync tick, the next
 *    profile view) picks the work up again.
 */

/** Time-to-first-byte + overall read deadline for an atproto GET. */
const XRPC_TIMEOUT_MS = 8_000;

/** Maximum JSON document size accepted from any atproto endpoint (2 MiB). */
const MAX_JSON_BYTES = 2 * 1024 * 1024;

/** User-Agent presented to atproto hosts. */
const USER_AGENT = 'Mention/atproto-connector (+https://mention.earth)';

/** Concurrent requests allowed against one host from this process. */
export const MAX_IN_FLIGHT_PER_HOST = 6;

/** Total tries for one GET when the host answers 429/503 (the first try included). */
export const MAX_ATTEMPTS = 3;

/** Backoff for a 429/503 that names no wait: 1 s, then 2 s, then 4 s (plus jitter). */
const BASE_BACKOFF_MS = 1_000;

/**
 * The longest a request waits for a rate-limited host before giving up. A
 * longer `Retry-After` still pauses the host for its full length; requests in
 * that window fail fast instead of holding a sync job open.
 */
export const MAX_RETRY_WAIT_MS = 30_000;

/** Statuses that mean "slow down and try again", never "this request is wrong". */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 503]);

/** A failed atproto GET (non-2xx upstream, transport error, or invalid body). */
export class XrpcError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'XrpcError';
    this.status = status;
  }
}

/**
 * Query-string parameter values an XRPC endpoint accepts. An array is an XRPC
 * array parameter, sent as the key repeated once per value
 * (`app.bsky.feed.getPosts?uris=a&uris=b`).
 */
export type XrpcParams = Record<string, string | number | boolean | readonly string[] | undefined>;

/** Build the absolute XRPC URL for `host`/`nsid` with `params` query-encoded. */
export function buildXrpcUrl(host: string, nsid: string, params: XrpcParams = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, item);
      continue;
    }
    search.set(key, String(value));
  }
  const qs = search.toString();
  return `https://${host}/xrpc/${nsid}${qs ? `?${qs}` : ''}`;
}

/**
 * One host's share of this process's atproto traffic: how many requests are in
 * flight against it, who is queued for a slot, and until when the host asked us
 * to stay away.
 */
interface HostGate {
  inFlight: number;
  waiting: Array<() => void>;
  pausedUntil: number;
}

const hostGates = new Map<string, HostGate>();

function gateFor(host: string): HostGate {
  let gate = hostGates.get(host);
  if (!gate) {
    gate = { inFlight: 0, waiting: [], pausedUntil: 0 };
    hostGates.set(host, gate);
  }
  return gate;
}

async function acquireSlot(host: string): Promise<HostGate> {
  const gate = gateFor(host);
  if (gate.inFlight < MAX_IN_FLIGHT_PER_HOST) {
    gate.inFlight += 1;
    return gate;
  }
  // The releasing request hands its slot straight to us (no decrement), so a
  // newcomer can never jump the queue between the release and our wake-up.
  await new Promise<void>((resolve) => gate.waiting.push(resolve));
  return gate;
}

function releaseSlot(host: string, gate: HostGate): void {
  const next = gate.waiting.shift();
  if (next) {
    next();
    return;
  }
  gate.inFlight -= 1;
  // Hosts are many (every PDS, every did:web domain): drop an idle one.
  if (gate.inFlight === 0 && gate.pausedUntil <= Date.now()) hostGates.delete(host);
}

/**
 * How long the host asked us to wait, in ms, or undefined when it did not say.
 * `Retry-After` is either delta-seconds or an HTTP date; atproto services also
 * send `RateLimit-Reset`, the epoch second the window reopens.
 */
export function retryDelayFromHeaders(
  headers: IncomingHttpHeaders,
  now: number = Date.now(),
): number | undefined {
  const retryAfter = headerValue(headers['retry-after']);
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  const reset = Number(headerValue(headers['ratelimit-reset']));
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1_000 - now);
  return undefined;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Common bounded GET used for both JSON and text reads. */
async function safeGet(url: string, accept: string, maxBytes: number): Promise<Buffer> {
  const host = new URL(url).host;
  for (let attempt = 1; ; attempt++) {
    const pausedFor = (hostGates.get(host)?.pausedUntil ?? 0) - Date.now();
    if (pausedFor > MAX_RETRY_WAIT_MS) {
      throw new XrpcError(`atproto host ${host} is rate limited; not retrying yet`, 429);
    }
    if (pausedFor > 0) await sleep(pausedFor);

    const gate = await acquireSlot(host);
    let outcome: { body: Buffer } | { status: number; retryAfterMs?: number };
    try {
      outcome = await fetchOnce(url, accept, maxBytes);
    } finally {
      releaseSlot(host, gate);
    }
    if ('body' in outcome) return outcome.body;

    const { status } = outcome;
    if (!RETRYABLE_STATUSES.has(status) || attempt >= MAX_ATTEMPTS) {
      throw new XrpcError(`atproto GET ${url} returned ${status}`, status);
    }
    const delay = outcome.retryAfterMs ?? backoffDelayMs(attempt - 1, { baseMs: BASE_BACKOFF_MS });
    const pausedGate = gateFor(host);
    pausedGate.pausedUntil = Math.max(pausedGate.pausedUntil, Date.now() + delay);
    if (delay > MAX_RETRY_WAIT_MS) {
      throw new XrpcError(`atproto GET ${url} returned ${status}; host paused`, status);
    }
  }
}

/** One GET: the body on a 2xx, or the status (and any wait the host asked for). */
async function fetchOnce(
  url: string,
  accept: string,
  maxBytes: number,
): Promise<{ body: Buffer } | { status: number; retryAfterMs?: number }> {
  const deadline = AbortSignal.timeout(XRPC_TIMEOUT_MS);
  const { response, status, headers } = await safeFetch(url, {
    redirect: 'manual',
    headers: { 'User-Agent': USER_AGENT, Accept: accept },
    signal: deadline,
    headersTimeoutMs: XRPC_TIMEOUT_MS,
  });

  if (status < 200 || status >= 300) {
    response.destroy();
    return { status, retryAfterMs: retryDelayFromHeaders(headers) };
  }

  const result = await readResponseBody(response, { maxBytes, timeoutMs: XRPC_TIMEOUT_MS });
  switch (result.kind) {
    case 'ok':
      return { body: result.body };
    case 'too_large':
      throw new XrpcError(`atproto GET ${url} exceeded ${maxBytes} bytes`);
    case 'timeout':
      throw new XrpcError(`atproto GET ${url} body did not end within ${XRPC_TIMEOUT_MS} ms`);
    case 'error':
      throw new XrpcError(`atproto GET ${url} body failed: ${result.error.message}`);
  }
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

/**
 * Perform an XRPC query: `GET https://{host}/xrpc/{nsid}?{params}` and parse the
 * JSON response. Throws {@link XrpcError} on any non-2xx / transport / parse
 * failure so callers can fail soft.
 */
export function xrpcGet<T = unknown>(
  host: string,
  nsid: string,
  params: XrpcParams = {},
): Promise<T> {
  return safeGetJson<T>(buildXrpcUrl(host, nsid, params));
}
