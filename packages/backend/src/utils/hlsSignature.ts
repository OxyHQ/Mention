import { createHmac, timingSafeEqual } from 'node:crypto';
import { getOxyServiceCredentials } from '../config';
import { logger } from './logger';

/**
 * Provenance signatures for the URIs the media proxy writes into a rewritten HLS
 * playlist.
 *
 * The proxy relays only image/video/audio content types, which is what keeps it
 * from becoming a relay for arbitrary unlabelled binaries. HLS segments break
 * that assumption through no fault of their own: object stores routinely serve
 * `.ts` and `.m4s` as `application/octet-stream` (Bluesky's segments, behind
 * `video.cdn.bsky.app`, are exactly this), so a correct playlist points at bytes
 * the content-type gate rejects.
 *
 * Widening the gate to allow `application/octet-stream` for every request would
 * relax the policy for the whole proxy. Instead the rewriter SIGNS each URI it
 * emits, and the octet-stream allowance applies only to a request carrying a
 * valid signature — i.e. only to bytes that a playlist we ourselves fetched,
 * validated and rewrote named as one of its components. A client cannot mint
 * one, so `/media/proxy` is unchanged for every other caller.
 *
 * The signature is a STABLE function of the upstream url (no expiry nonce), so a
 * segment url stays cacheable by the browser and any CDN in front of us — the
 * same Camo-style construction the GIF media proxy uses.
 */

/** Query parameter carrying the signature on a rewritten playlist component url. */
export const HLS_SIGNATURE_PARAM = 'hls';

/** Domain-separation label so the derived subkey is purpose-bound (HMAC-KDF). */
const HLS_SIGNATURE_KEY_LABEL = 'mention:hls-media-proxy:v1';

/**
 * Resolve the HMAC signing key (memoized), derived from the always-present Oxy
 * service secret so no additional secret has to be provisioned. Returns null
 * only when that secret is absent (an unconfigured environment), in which case
 * playlists are still rewritten and still play wherever the upstream labels its
 * segments honestly — only the octet-stream allowance is unavailable.
 */
let cachedKey: Buffer | null | undefined;
function resolveSigningKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;

  const serviceSecret = getOxyServiceCredentials().apiSecret;
  if (serviceSecret && serviceSecret.length > 0) {
    cachedKey = createHmac('sha256', serviceSecret).update(HLS_SIGNATURE_KEY_LABEL).digest();
    return cachedKey;
  }

  logger.error(
    '[HlsSignature] No signing key available (set OXY_SERVICE_API_SECRET); HLS segments served as application/octet-stream will be rejected',
  );
  cachedKey = null;
  return cachedKey;
}

/** Sign an upstream playlist-component url. Null when no key is configured. */
export function signHlsComponentUrl(upstreamUrl: string): string | null {
  const key = resolveSigningKey();
  if (!key) return null;
  return createHmac('sha256', key).update(upstreamUrl).digest('base64url');
}

/**
 * True when `signature` is one we produced for `upstreamUrl` — i.e. this request
 * is for a component of a playlist the proxy itself rewrote.
 */
export function isSignedHlsComponent(upstreamUrl: string, signature: unknown): boolean {
  const key = resolveSigningKey();
  if (!key) return false;
  if (typeof signature !== 'string' || signature.length === 0) return false;

  const expected = createHmac('sha256', key).update(upstreamUrl).digest();
  const provided = Buffer.from(signature, 'base64url');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
