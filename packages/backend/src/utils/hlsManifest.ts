import { URL } from 'node:url';

/**
 * HLS (RFC 8216) playlist rewriting for the media proxy.
 *
 * A `.m3u8` playlist is not media bytes — it is a manifest of further URIs
 * (variant playlists, media segments, encryption keys, init sections). Relaying
 * one verbatim through `/media/proxy` does not work and is not safe:
 *
 *  - RELATIVE URIs break outright. Real playlists (Bluesky's `video.bsky.app`
 *    among them) reference `720p/video.m3u8` and `video0.ts?session_id=…`, which
 *    a client resolves against the manifest's OWN url. Served through the proxy
 *    that base is `/media/proxy?url=…`, so the client would resolve segments to
 *    `/media/<relative>` — a 404. The stream never plays.
 *  - ABSOLUTE URIs escape every guarantee the proxy exists to provide: segment
 *    fetches would skip the SSRF guard and its per-hop redirect re-validation,
 *    the response size caps, the rate limiter and the negative cache — and, on
 *    web, would be blocked by our CSP anyway, since `connect-src` lists our own
 *    origin and not arbitrary media CDNs.
 *
 * So the proxy rewrites the manifest: every URI it contains is resolved to an
 * absolute url against the manifest's own (post-redirect) url and then wrapped
 * back through `/media/proxy`. Nested variant playlists need no special case —
 * fetching one goes through the proxy too, which rewrites it in turn.
 *
 * The rewrite is deliberately structural rather than a regex over the document.
 * RFC 8216 §4.1 defines a playlist line-by-line: a line is blank, a tag
 * (`#EXT…`), a comment (`#…`), or a URI. Only two things can carry a URI — a
 * bare URI line, and the `URI` attribute of a tag — and §4.2 defines attribute
 * lists precisely enough (comma-separated `NAME=VALUE`; a quoted-string value
 * can contain neither a quote nor a line break) to split them exactly.
 */

/** Prefix identifying an HLS tag line, as opposed to a plain `#` comment. */
const TAG_PREFIX = '#EXT';

/** The one attribute name whose value is a URI (RFC 8216 §4.2). */
const URI_ATTRIBUTE_NAME = 'URI';

/** Every playlist must start with this tag (RFC 8216 §4.3.1.1). */
const PLAYLIST_HEADER_TAG = '#EXTM3U';

/** URI schemes we are willing to route through the proxy. */
const PROXYABLE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * True when `body` looks like an HLS playlist, i.e. its first line is `#EXTM3U`.
 *
 * The content type alone is not proof: this guards against rewriting — and
 * relaying under a media content type — a body that an upstream merely
 * mislabelled as a playlist.
 */
export function isHlsManifestBody(body: string): boolean {
  // `trimStart` also drops a leading BOM, which some servers prepend even though
  // RFC 8216 does not allow one.
  return body.trimStart().startsWith(PLAYLIST_HEADER_TAG);
}

/**
 * Builds the url a client should fetch in place of one absolute upstream url.
 * Injected rather than assembled here so this module stays free of config and
 * crypto: the caller decides the proxy path and attaches the provenance
 * signature (see `utils/hlsSignature.ts`).
 */
export type ProxyUrlBuilder = (absoluteUrl: string) => string;

/**
 * Rewrite every URI in an HLS playlist to point back through the media proxy.
 *
 * @param manifest      The playlist body, exactly as received.
 * @param manifestUrl   The absolute url the playlist was fetched FROM, after any
 *                      redirects — relative URIs resolve against this, so
 *                      passing the pre-redirect url would produce wrong urls.
 * @param buildProxyUrl Maps a resolved absolute url to the url the client should
 *                      fetch instead.
 *
 * Non-URI content is preserved byte for byte, so tags we do not understand
 * (including future ones) pass through untouched.
 */
export function rewriteHlsManifest(
  manifest: string,
  manifestUrl: string,
  buildProxyUrl: ProxyUrlBuilder,
): string {
  return manifest
    .split('\n')
    .map((line) => rewriteLine(line, manifestUrl, buildProxyUrl))
    .join('\n');
}

/**
 * Rewrite one line, preserving a CRLF line ending. Splitting the document on
 * `\n` leaves the `\r` of a CRLF file attached to the end of each line; it must
 * not be swept into a URI.
 */
function rewriteLine(rawLine: string, manifestUrl: string, buildProxyUrl: ProxyUrlBuilder): string {
  const hasCarriageReturn = rawLine.endsWith('\r');
  const line = hasCarriageReturn ? rawLine.slice(0, -1) : rawLine;
  const rewritten = rewriteLineBody(line, manifestUrl, buildProxyUrl);
  return hasCarriageReturn ? `${rewritten}\r` : rewritten;
}

function rewriteLineBody(line: string, manifestUrl: string, buildProxyUrl: ProxyUrlBuilder): string {
  const trimmed = line.trim();

  // Blank line: structural padding, nothing to rewrite.
  if (trimmed.length === 0) return line;

  // `#EXT…` is a tag (which MAY carry a `URI` attribute); any other `#…` line is
  // a comment and is opaque.
  if (trimmed.startsWith('#')) {
    return trimmed.startsWith(TAG_PREFIX) ? rewriteTagUri(line, manifestUrl, buildProxyUrl) : line;
  }

  // Anything else is a URI line: a media segment, or a variant playlist in a
  // master playlist.
  return toProxiedUrl(trimmed, manifestUrl, buildProxyUrl) ?? line;
}

/**
 * Rewrite the `URI` attribute of a tag line, if it has one.
 *
 * Tags whose value is not an attribute list (`#EXTINF:6.0,`,
 * `#EXT-X-TARGETDURATION:6`) simply contain no `URI=` pair and fall through
 * unchanged, so they need no special case. Matching the attribute name exactly
 * matters: `#EXT-X-DATERANGE` may carry client attributes such as
 * `X-COM-EXAMPLE-URI="…"`, which are NOT playlist URIs and must be left alone.
 */
function rewriteTagUri(line: string, manifestUrl: string, buildProxyUrl: ProxyUrlBuilder): string {
  const separatorIndex = line.indexOf(':');
  if (separatorIndex === -1) return line; // A valueless tag, e.g. `#EXTM3U`.

  const tagName = line.slice(0, separatorIndex + 1);
  const attributes = splitAttributeList(line.slice(separatorIndex + 1));
  const rewritten = attributes.map((attribute) => rewriteAttribute(attribute, manifestUrl, buildProxyUrl));

  return `${tagName}${rewritten.join(',')}`;
}

/**
 * Split an RFC 8216 §4.2 attribute list on its top-level commas.
 *
 * Quote-aware, because attribute values legitimately contain commas —
 * `CODECS="avc1.4d401e,mp4a.40.2"` is one attribute, not two. A quoted-string
 * cannot itself contain a double quote, so tracking a single in/out flag is
 * exact, with no escape sequences to handle.
 */
function splitAttributeList(value: string): string[] {
  const parts: string[] = [];
  let partStart = 0;
  let insideQuotes = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') {
      insideQuotes = !insideQuotes;
    } else if (character === ',' && !insideQuotes) {
      parts.push(value.slice(partStart, index));
      partStart = index + 1;
    }
  }
  parts.push(value.slice(partStart));

  return parts;
}

/**
 * Rewrite a single `NAME=VALUE` attribute when it is the `URI` one. Everything
 * else — including the attribute's original spacing — is returned untouched.
 */
function rewriteAttribute(attribute: string, manifestUrl: string, buildProxyUrl: ProxyUrlBuilder): string {
  const equalsIndex = attribute.indexOf('=');
  if (equalsIndex === -1) return attribute;

  if (attribute.slice(0, equalsIndex).trim() !== URI_ATTRIBUTE_NAME) return attribute;

  const value = attribute.slice(equalsIndex + 1).trim();
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return attribute;

  const proxied = toProxiedUrl(value.slice(1, -1), manifestUrl, buildProxyUrl);
  if (proxied === null) return attribute;

  // Re-quoting is safe without escaping as long as the builder percent-encodes
  // its payload (the caller's does), so a proxied url contains neither `"` nor
  // `,` — the quoted-string and the attribute list stay well formed.
  return `${attribute.slice(0, equalsIndex)}="${proxied}"`;
}

/**
 * Resolve one playlist URI against the manifest url and wrap it in a proxy url.
 *
 * Returns `null` when the URI is empty, unparseable, or uses a scheme the proxy
 * does not serve (a `data:` decryption key, say) — the caller then leaves the
 * original text in place rather than emitting something broken.
 */
function toProxiedUrl(uri: string, manifestUrl: string, buildProxyUrl: ProxyUrlBuilder): string | null {
  if (uri.length === 0) return null;

  let absolute: URL;
  try {
    absolute = new URL(uri, manifestUrl);
  } catch {
    return null;
  }

  if (!PROXYABLE_PROTOCOLS.has(absolute.protocol)) return null;

  return buildProxyUrl(absolute.toString());
}
