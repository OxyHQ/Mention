/**
 * Recognising an HLS (RFC 8216) video source.
 *
 * Federated video from atproto is an HLS playlist, not a self-contained file —
 * Bluesky serves `…/playlist.m3u8`. By the time a player sees one it has been
 * wrapped by `proxyExternalUrl` into `<api>/media/proxy?url=<encoded playlist>`,
 * so the `.m3u8` is in the QUERY STRING and not in the path. Both spellings have
 * to be recognised: the wrapped form is what the app renders, and the bare form
 * is what a direct upstream url looks like.
 *
 * Pure and platform-agnostic; the decision of what to DO about an HLS source is
 * `lib/hlsPlayback` (a JS player on web, the platform decoder on native).
 */

/** Playlist file extension, per RFC 8216 §4. */
const HLS_PATH_SUFFIX = '.m3u8';

/** Query parameter the media proxy carries the upstream url in. */
const PROXY_URL_PARAM = 'url';

/** True when `pathname` names a playlist, ignoring a trailing slash. */
function pathIsPlaylist(pathname: string): boolean {
  return pathname.toLowerCase().endsWith(HLS_PATH_SUFFIX);
}

/**
 * True when `src` resolves to an HLS playlist — either directly, or as the
 * proxied upstream of a `/media/proxy?url=…` request.
 *
 * Deliberately a URL-shape test and not a content-type probe: the decision has
 * to be made BEFORE the first request, to choose which player attaches to the
 * element at all. A false negative degrades to today's behaviour (the element
 * tries and fails); a false positive costs one unnecessary hls.js load, and
 * hls.js reports a non-playlist body as an error itself.
 */
export function isHlsSource(src: string | undefined | null): boolean {
  if (!src) return false;

  // Relative urls (our own proxy path is absolute in practice, but a same-origin
  // caller could pass one) need a base to parse against.
  let parsed: URL;
  try {
    parsed = new URL(src, 'https://placeholder.invalid');
  } catch {
    return false;
  }

  if (pathIsPlaylist(parsed.pathname)) return true;

  const proxied = parsed.searchParams.get(PROXY_URL_PARAM);
  if (!proxied) return false;

  try {
    return pathIsPlaylist(new URL(proxied, 'https://placeholder.invalid').pathname);
  } catch {
    return false;
  }
}
