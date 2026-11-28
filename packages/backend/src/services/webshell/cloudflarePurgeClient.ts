/**
 * Cloudflare's purge-by-URL call (`POST /zones/:zone/purge_cache` with
 * `{ files }`), and nothing else: the token it is given may only purge
 * mention.earth's cache (oxy-infra runbook 73), so this is the whole of what
 * Mention does with Cloudflare.
 *
 * Errors are split by what a retry can change. A 429, a 5xx, a timeout or a
 * refused connection may pass on the next attempt; any other 4xx (a revoked or
 * expired token, a malformed request) will fail the same way every time, so it
 * is reported once rather than retried for ten minutes. Neither error carries
 * the token.
 */

const CLOUDFLARE_API_ORIGIN = 'https://api.cloudflare.com/client/v4';

/** Cloudflare's limit of URLs per purge call on the mention.earth plan. */
export const CLOUDFLARE_PURGE_MAX_URLS = 30;

/** One purge call's budget, so a hung connection cannot hold a worker slot. */
const PURGE_REQUEST_TIMEOUT_MS = 10_000;

/** A purge that may succeed if tried again. */
export class CloudflarePurgeRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudflarePurgeRetryableError';
  }
}

/** A purge Cloudflare refused in a way no retry changes. */
export class CloudflarePurgeRejectedError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CloudflarePurgeRejectedError';
  }
}

interface CloudflareEnvelope {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
}

export interface CloudflarePurgeTarget {
  zoneId: string;
  token: string;
  /** Injected by tests; the global `fetch` otherwise. */
  fetchImpl?: typeof fetch;
}

function describeErrors(body: CloudflareEnvelope | null): string {
  const errors = body?.errors ?? [];
  if (errors.length === 0) return 'no error detail';
  return errors
    .slice(0, 3)
    .map((error) => `${error.code ?? '?'} ${error.message ?? ''}`.trim())
    .join('; ');
}

/** Purge these exact URLs from the zone's cache. Throws on anything but success. */
export async function purgeCloudflareUrls(
  urls: readonly string[],
  target: CloudflarePurgeTarget,
): Promise<void> {
  return purgeCloudflare('files', urls, target);
}

/**
 * Purge everything cached under these prefixes (`host/path`, no scheme). One
 * prefix covers a page with and without its trailing slash and every query
 * string variant (`?utm_source=…`), which purge-by-URL cannot. Measured on the
 * mention.org zone on 2026-11-28: purge-by-URL answered success and the page
 * stayed a cache HIT, while a prefix purge emptied it at once.
 */
export async function purgeCloudflarePrefixes(
  prefixes: readonly string[],
  target: CloudflarePurgeTarget,
): Promise<void> {
  return purgeCloudflare('prefixes', prefixes, target);
}

async function purgeCloudflare(
  kind: 'files' | 'prefixes',
  urls: readonly string[],
  target: CloudflarePurgeTarget,
): Promise<void> {
  if (urls.length === 0) return;
  if (urls.length > CLOUDFLARE_PURGE_MAX_URLS) {
    throw new RangeError(
      `A Cloudflare purge takes at most ${CLOUDFLARE_PURGE_MAX_URLS} URLs, got ${urls.length}`,
    );
  }
  const fetchImpl = target.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${CLOUDFLARE_API_ORIGIN}/zones/${target.zoneId}/purge_cache`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${target.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ [kind]: urls }),
      signal: AbortSignal.timeout(PURGE_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CloudflarePurgeRetryableError(
      `Cloudflare purge request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const body = (await response.json().catch(() => null)) as CloudflareEnvelope | null;
  if (response.ok && body?.success === true) return;

  const message = `Cloudflare purge answered ${response.status}: ${describeErrors(body)}`;
  if (response.ok || response.status === 429 || response.status >= 500) {
    throw new CloudflarePurgeRetryableError(message);
  }
  throw new CloudflarePurgeRejectedError(response.status, message);
}
