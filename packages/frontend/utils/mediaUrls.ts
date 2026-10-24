/**
 * Mention's own media URL routes: the backend media proxy and poster extractor.
 *
 * Oxy file ids resolve through the SDK (`oxyServices.assets.renderUrl` for a
 * render path, services' `useFileDownloadUrl` for a private asset), which owns
 * the only file-id → URL cache; nothing here caches.
 */

import type { OxyServices } from '@oxy.so/core';
import { API_URL, OXY_BASE_URL } from '@/config';

// Backend media proxy: streams remote media with CORS + cache + HTTP Range, and
// survives expiring upstream links. See backend `GET /media/proxy?url=<encoded>`.
const MEDIA_PROXY_PATH = '/media/proxy';

// Backend poster endpoint: extracts a single JPEG frame from a remote/federated
// video so we can show a thumbnail before the decoder mounts (or for static
// grids that never mount one). See backend `GET /media/poster?url=<encoded>`.
// May 404 when no frame can be extracted — callers must fall back to a
// placeholder and never surface a broken image.
const MEDIA_POSTER_PATH = '/media/poster';

// Oxy generated still-frame variant for native (non-federated) video assets.
const OXY_THUMB_VARIANT = 'thumb';

/**
 * Origins we own — absolute URLs on these hosts must NOT be routed through the
 * proxy (they already resolve to our own backend/CDN and proxying them would be
 * a wasteful double-hop). Derived from configured bases, never hardcoded hosts.
 */
const ownOrigins = (() => {
  const origins = new Set<string>();
  for (const base of [API_URL, OXY_BASE_URL]) {
    if (!base) continue;
    try {
      origins.add(new URL(base).origin);
    } catch {
      // A malformed base in config is non-fatal here: we simply can't treat it
      // as an "own" origin, so URLs on that host would be proxied. Skip it.
    }
  }
  return origins;
})();

/**
 * Route an absolute http(s) URL through the backend media proxy so external /
 * federated media loads reliably on web (CORS), survives expiring upstream
 * links, and gets cached. URLs that are already ours — our backend/CDN origins
 * or an existing `/media/proxy` URL — are returned unchanged to avoid a wasteful
 * double-proxy. Never throws: on any parse failure it returns the input URL so
 * it is safe to call directly in a render path.
 */
export function proxyExternalUrl(url: string): string {
  try {
    const parsed = new URL(url);

    // Only http(s) is proxyable. Anything else (data:, blob:, relative, …)
    // passes through untouched.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return url;
    }

    // Already ours → no proxy.
    if (ownOrigins.has(parsed.origin)) {
      return url;
    }

    // Already a proxy URL (defensive against double-proxying if a proxied URL
    // is fed back in from a host we don't recognise as ours).
    if (parsed.pathname === MEDIA_PROXY_PATH) {
      return url;
    }

    return `${API_URL}${MEDIA_PROXY_PATH}?url=${encodeURIComponent(url)}`;
  } catch {
    // Not a parseable absolute URL — return it as-is rather than throwing in a
    // render path. The non-http callers never reach here.
    return url;
  }
}

/**
 * Given the RAW video reference for a post (an Oxy file id OR an absolute
 * http(s) URL — possibly already wrapped by our `/media/proxy`), return a poster
 * (thumbnail) image URL, or `undefined` when no sensible poster exists.
 *
 * Resolution rules:
 *  - Absolute http(s) URL that is NOT one of our own origins (federated/remote
 *    video): route it through the backend poster endpoint
 *    (`${API_URL}/media/poster?url=<encoded original>`), which extracts a frame.
 *  - Already a `/media/proxy?url=…` URL (we proxy federated video, so the raw
 *    reference may arrive pre-wrapped): unwrap the original `url` param and build
 *    the poster from that ORIGINAL remote URL, not the proxy hop.
 *  - Any other own-origin http(s) URL (e.g. a direct link to our CDN): skip —
 *    these resolve to assets that already carry server-side posters; return
 *    `undefined` so the caller can use the Oxy thumb path or a placeholder.
 *  - Non-http reference (an Oxy file id): the Oxy `thumb` variant through the
 *    SDK. Requires `oxyServices`; without it we cannot resolve and return
 *    `undefined`.
 *
 * Never throws: any parse failure degrades to `undefined` so it is safe to call
 * directly in a render path. The poster endpoint may 404 — the caller must fall
 * back to a placeholder on image error and never show a broken image.
 */
export function videoPosterUrl(
  videoUrl: string,
  oxyServices?: Pick<OxyServices, 'assets'> | null,
): string | undefined {
  if (!videoUrl) return undefined;

  const isHttp = videoUrl.startsWith('http://') || videoUrl.startsWith('https://');

  // Non-http reference → Oxy file id. Native Oxy videos get a generated server
  // thumbnail via the `thumb` variant.
  if (!isHttp) {
    return oxyServices?.assets.renderUrl(videoUrl, OXY_THUMB_VARIANT);
  }

  try {
    const parsed = new URL(videoUrl);

    // If the reference already points at our own proxy, the real remote URL is
    // carried in its `url` query param. Derive the poster from THAT original so
    // the backend can fetch + frame-grab the upstream video directly.
    if (ownOrigins.has(parsed.origin) && parsed.pathname === MEDIA_PROXY_PATH) {
      const original = parsed.searchParams.get('url');
      if (!original) return undefined;
      return `${API_URL}${MEDIA_POSTER_PATH}?url=${encodeURIComponent(original)}`;
    }

    // Any other own-origin URL: not a federated video we need to frame-grab.
    // Skip — server-side posters (if any) come from the Oxy id path elsewhere.
    if (ownOrigins.has(parsed.origin)) {
      return undefined;
    }

    // Federated / remote absolute URL → poster from the backend frame extractor.
    return `${API_URL}${MEDIA_POSTER_PATH}?url=${encodeURIComponent(videoUrl)}`;
  } catch {
    // Not a parseable absolute URL — no sensible poster.
    return undefined;
  }
}
