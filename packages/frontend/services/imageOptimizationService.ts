import { proxyExternalUrl } from '@/utils/imageUrlCache';

export type ImageSize = 'thumb' | 'small' | 'medium' | 'large' | 'original';

/**
 * Resolve an image URI for display.
 *
 * Historically this routed external images through the backend `/images/optimize`
 * endpoint to resize/recompress them. That path is now superseded by the media
 * proxy (`/media/proxy`), which already streams external/federated media with
 * CORS, HTTP Range, and a server-side cache — and unlike the optimize endpoint it
 * does not depend on S3 object ACLs (the bucket is ownership-enforced, so the
 * optimize write path always failed and returned 502). External absolute URLs are
 * therefore routed through the proxy; our own-origin URLs (including URLs already
 * wrapped by `/media/proxy`) and non-http references pass through untouched.
 *
 * `size` is retained for call-site compatibility; sizing/compression is handled by
 * the proxy/CDN layer rather than a per-request optimize hop.
 */
export function getOptimizedImageUrl(uri: string, _size: ImageSize): string {
  if (!uri || typeof uri !== 'string') {
    return uri;
  }

  // Only absolute http(s) URLs are proxyable. `proxyExternalUrl` returns our-own
  // origin URLs (and already-proxied URLs) unchanged, and is a no-op for
  // data:/blob:/relative references — so it is safe to call unconditionally.
  if (uri.startsWith('http://') || uri.startsWith('https://')) {
    return proxyExternalUrl(uri);
  }

  return uri;
}
