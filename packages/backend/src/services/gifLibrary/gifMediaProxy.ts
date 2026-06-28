import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../config';
import { logger } from '../../utils/logger';

/**
 * GIF media proxy — sign / verify capability URLs that stream a not-yet-imported
 * Klipy GIF asset THROUGH our own origin.
 *
 * The picker surfaces GIFs we have not yet copied into our own library (the
 * background import is still running). Those tiles must NEVER point the client at
 * Klipy's CDN — every byte flows through our `/media/gif` route instead. To stop
 * that route from becoming an OPEN proxy, the upstream URL is bound to an HMAC
 * that only this backend can produce: a client cannot point `/media/gif` at an
 * arbitrary URL, only at a Klipy asset URL we ourselves surfaced and signed.
 *
 * Design (mirrors GitHub's "Camo" image proxy):
 *  - the signed URL is STABLE for a given upstream URL (no per-request expiry
 *    token) so the browser/CDN can cache it across responses;
 *  - the upstream URL is base64url-encoded, so the client-facing DTO carries no
 *    literal Klipy hostname (the leak we are closing);
 *  - on top of the HMAC, the route is restricted to Klipy-owned hosts and
 *    `safeFetch`'s private-IP guard (defense in depth).
 */

/** Public path of the GIF media-proxy route (mounted on the public `/media` router). */
export const GIF_MEDIA_PROXY_PATH = '/media/gif';

/** Domain-separation label so the derived signing subkey is purpose-bound (HMAC-KDF). */
const GIF_MEDIA_KEY_LABEL = 'mention:gif-media-proxy:v1';

/** Default Klipy registrable domain we proxy media from (see {@link getAllowedKlipyDomains}). */
const DEFAULT_KLIPY_DOMAIN = 'klipy.com';

/**
 * Klipy-owned registrable domains we will proxy. Defense-in-depth ON TOP of the
 * HMAC (which already restricts the route to URLs we signed) and the private-IP
 * guard. Klipy serves media from `static.klipy.com` and its API from
 * `api.klipy.com` — both under the `klipy.com` registrable domain. Overridable
 * via `KLIPY_MEDIA_HOSTS` (comma-separated registrable domains) should Klipy add
 * a new CDN host, without a code change.
 */
function getAllowedKlipyDomains(): string[] {
  const raw = process.env.KLIPY_MEDIA_HOSTS;
  const domains = (raw ? raw.split(',') : [DEFAULT_KLIPY_DOMAIN])
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain.length > 0);
  return domains.length > 0 ? domains : [DEFAULT_KLIPY_DOMAIN];
}

/**
 * Resolve the HMAC signing key (memoized).
 *
 *  1. explicit `GIF_MEDIA_PROXY_SECRET` when provided, else
 *  2. a dedicated subkey DERIVED from the always-present `OXY_SERVICE_API_SECRET`
 *     via HMAC-KDF — so prod needs no extra provisioned secret and we never sign
 *     with the raw service secret.
 *
 * Returns null only when neither is set (a misconfigured environment); callers
 * then suppress the not-yet-imported tile rather than leak a Klipy URL.
 */
let cachedKey: Buffer | null | undefined;
function resolveSigningKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;

  const explicit = process.env.GIF_MEDIA_PROXY_SECRET;
  if (explicit && explicit.length > 0) {
    cachedKey = Buffer.from(explicit, 'utf8');
    return cachedKey;
  }

  const serviceSecret = process.env.OXY_SERVICE_API_SECRET;
  if (serviceSecret && serviceSecret.length > 0) {
    cachedKey = createHmac('sha256', serviceSecret).update(GIF_MEDIA_KEY_LABEL).digest();
    return cachedKey;
  }

  logger.error(
    '[GifMediaProxy] No signing key available (set GIF_MEDIA_PROXY_SECRET or OXY_SERVICE_API_SECRET); not-yet-imported GIF tiles will be suppressed',
  );
  cachedKey = null;
  return cachedKey;
}

/** True when `rawUrl` is an http(s) URL whose host is a Klipy-owned domain. */
function isAllowedKlipyHost(rawUrl: string): boolean {
  if (!URL.canParse(rawUrl)) return false;
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase();
  return getAllowedKlipyDomains().some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * Build a signed, our-origin URL that streams the given Klipy asset through
 * `/media/gif`. Returns null when the URL is not a Klipy host or no signing key
 * is configured — the caller MUST then drop the tile rather than emit a raw
 * Klipy URL.
 */
export function signGifMediaUrl(upstreamUrl: string): string | null {
  if (!upstreamUrl || !isAllowedKlipyHost(upstreamUrl)) return null;
  const key = resolveSigningKey();
  if (!key) return null;

  const signature = createHmac('sha256', key).update(upstreamUrl).digest('base64url');
  const params = new URLSearchParams({
    u: Buffer.from(upstreamUrl, 'utf8').toString('base64url'),
    s: signature,
  });
  return `${config.publicApiUrl}${GIF_MEDIA_PROXY_PATH}?${params.toString()}`;
}

/**
 * Verify a `/media/gif` request and return the validated upstream Klipy URL, or
 * null when the request is unsigned/forged/non-Klipy. Used by the streaming
 * route (the route is otherwise unauthenticated — the signature IS the
 * capability, exactly like the public media proxy is gated by the SSRF guard).
 */
export function verifyGifMediaRequest(u: unknown, s: unknown): string | null {
  const key = resolveSigningKey();
  if (!key) return null;
  if (typeof u !== 'string' || typeof s !== 'string' || u.length === 0 || s.length === 0) return null;

  const upstreamUrl = Buffer.from(u, 'base64url').toString('utf8');
  if (!isAllowedKlipyHost(upstreamUrl)) return null;

  const expected = createHmac('sha256', key).update(upstreamUrl).digest();
  const provided = Buffer.from(s, 'base64url');
  if (provided.length !== expected.length) return null;
  return timingSafeEqual(provided, expected) ? upstreamUrl : null;
}

/**
 * Unwrap a value that MAY be one of our signed `/media/gif` URLs back to the
 * underlying Klipy URL, so the import path downloads from Klipy directly rather
 * than round-tripping through our own proxy. Any non-proxy value (a raw URL, an
 * empty string, an unverifiable/forged proxy URL) is returned unchanged.
 */
export function unwrapGifMediaUrl(maybeProxyUrl: string): string {
  if (!maybeProxyUrl || !URL.canParse(maybeProxyUrl)) return maybeProxyUrl;
  const parsed = new URL(maybeProxyUrl);
  if (parsed.pathname !== GIF_MEDIA_PROXY_PATH) return maybeProxyUrl;
  const upstreamUrl = verifyGifMediaRequest(parsed.searchParams.get('u'), parsed.searchParams.get('s'));
  return upstreamUrl ?? maybeProxyUrl;
}
