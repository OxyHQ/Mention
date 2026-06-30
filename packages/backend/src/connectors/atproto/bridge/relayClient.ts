/**
 * Atproto Relay registration client (Phase C4 — EXTERNAL ACTIVATION, gated).
 *
 * A Bluesky AppView indexes a repo only after a Relay crawls it. The bridge tells
 * a Relay to crawl this PDS via `com.atproto.sync.requestCrawl` (a POST whose body
 * is `{ hostname }` — the PDS host the Relay should fetch repos from).
 *
 * THIS IS AN EXTERNAL ACTIVATION STEP. It makes a real network call to a real
 * Relay. It is therefore:
 *  - gated behind {@link ATPROTO_RELAY_HOST} being configured AND the bridge being
 *    enabled, and
 *  - NEVER auto-invoked — it runs ONLY when an operator calls {@link requestRelayCrawl}
 *    from the explicit activation entry point. There is no scheduler, no
 *    bootstrap call, and the test suite never reaches the network (the function
 *    short-circuits when unconfigured and is otherwise only exercised with a
 *    mocked transport).
 *
 * The request goes through the same SSRF-safe single-hop fetch the read XRPC
 * client uses, so even an operator-supplied Relay host is IP-pinned + size-bounded.
 */

import { fetchUpstreamSingleHop } from '../../../utils/safeUpstreamFetch';
import { readBoundedResponseBody } from '../../shared/httpBody';
import { logger } from '../../../utils/logger';
import {
  ATPROTO_BRIDGE_ENABLED,
  ATPROTO_RELAY_HOST,
  BRIDGE_DOMAIN,
} from './constants';

/** Time-to-first-byte + read deadline for the Relay POST. */
const RELAY_TIMEOUT_MS = 10_000;
/** Max accepted Relay response body (the response is small). */
const MAX_RELAY_RESPONSE_BYTES = 64 * 1024;
/** User-Agent presented to the Relay. */
const USER_AGENT = 'Mention/atproto-bridge (+https://mention.earth)';

/** The outcome of a Relay crawl request. */
export interface RelayCrawlResult {
  ok: boolean;
  /** The Relay host the request targeted, when one was configured. */
  relayHost?: string;
  /** A human-readable reason on failure / skip. */
  reason?: string;
  /** The Relay's HTTP status, when a request was actually made. */
  status?: number;
}

/**
 * Request a Relay crawl of this bridge PDS (`com.atproto.sync.requestCrawl`).
 *
 * EXPLICIT ACTIVATION ONLY. Returns `{ ok:false, reason:'disabled' }` without any
 * network call when the bridge is off or no `ATPROTO_RELAY_HOST` is configured —
 * so it is inert by default and safe to leave in the codebase. On a configured
 * activation it POSTs `{ hostname: <bridge domain> }` to the Relay and reports the
 * result. Never throws — the activation entry point logs the structured outcome.
 */
export async function requestRelayCrawl(): Promise<RelayCrawlResult> {
  if (!ATPROTO_BRIDGE_ENABLED) {
    return { ok: false, reason: 'bridge_disabled' };
  }
  if (!ATPROTO_RELAY_HOST) {
    return { ok: false, reason: 'no_relay_host_configured' };
  }

  const url = `https://${ATPROTO_RELAY_HOST}/xrpc/com.atproto.sync.requestCrawl`;
  const body = JSON.stringify({ hostname: BRIDGE_DOMAIN });

  try {
    const { response, status } = await fetchUpstreamSingleHop(url, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      headersTimeoutMs: RELAY_TIMEOUT_MS,
    });

    // Drain the bounded body so the socket is freed; the content is not needed.
    try {
      await readBoundedResponseBody(response, MAX_RELAY_RESPONSE_BYTES);
    } catch {
      response.destroy();
    }

    const ok = status >= 200 && status < 300;
    if (ok) {
      logger.info('[atproto-bridge] Relay crawl requested', { relayHost: ATPROTO_RELAY_HOST, status });
    } else {
      logger.warn('[atproto-bridge] Relay crawl request returned non-2xx', {
        relayHost: ATPROTO_RELAY_HOST,
        status,
      });
    }
    return { ok, relayHost: ATPROTO_RELAY_HOST, status, reason: ok ? undefined : `relay_status_${status}` };
  } catch (err) {
    logger.warn('[atproto-bridge] Relay crawl request failed', {
      relayHost: ATPROTO_RELAY_HOST,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, relayHost: ATPROTO_RELAY_HOST, reason: 'request_failed' };
  }
}
