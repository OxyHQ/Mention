import {
  type MediaItem,
  MEDIA_VARIANT_THUMB,
  MEDIA_VARIANT_FULL,
  MEDIA_VARIANT_AVATAR,
  MEDIA_VARIANT_VIDEO_POSTER,
  MEDIA_VARIANT_BANNER,
} from '@mention/shared-types';
import { config } from '../config';
import { getServiceOxyClient } from './oxyHelpers';
import { logger } from './logger';

/**
 * Server-authoritative media URL resolver — the SINGLE place that converts a
 * media reference (Oxy file id, absolute URL, or empty) into FINAL,
 * ready-to-render URL(s). Every API response that emits an avatar or post media
 * should route through here so the frontend never computes URLs itself.
 *
 * A media ref can be:
 *  - falsy → resolves to an empty URL.
 *  - an absolute `http(s)` URL:
 *      - if its host is one of OUR OWN origins (the backend public URL or the
 *        Oxy API origin) → returned verbatim (already servable by us).
 *      - otherwise (a federated/external CDN) → wrapped behind our own
 *        `/media/proxy` (and `/media/poster` for the poster), so the browser
 *        sees same-origin, cacheable, range-seekable bytes. The display URLs
 *        additionally carry a `variant`, which the proxy honours by redirecting
 *        to the sized Oxy render once the remote bytes have been mirrored.
 *  - anything else → treated as an Oxy file id and turned into a CDN/stream URL
 *    via the SDK's synchronous `getFileDownloadUrl` (pure URL construction, no
 *    network), with image variants for image thumbnails/fullscreen, the dedicated
 *    96px `w96` crop for avatars, and the 256px `thumb` crop for video posters.
 *
 * This module NEVER throws: on any failure it degrades to the safest passthrough
 * (`{ url: ref }` or `undefined`).
 */

/** Final resolved URLs for a single media reference. */
export interface ResolvedMedia {
  /**
   * The primary, ready-to-render URL. Empty string when the ref is falsy. For
   * an Oxy image this is the no-variant ORIGINAL (full resolution); display
   * paths should prefer `thumbUrl`/`fullUrl` and only fall back to this. For a
   * video this is the playable source (no image variant). For federated media
   * it is the proxied URL.
   */
  url: string;
  /** Thumbnail variant URL, when one can be derived. */
  thumbUrl?: string;
  /** Poster/still-frame URL (videos); mirrors `thumbUrl` for images. */
  posterUrl?: string;
  /**
   * Large display variant URL for fullscreen viewers (the lightbox) when one can
   * be derived. Sized for the on-open upgrade, NOT the raw original — for either
   * an Oxy file id or federated media, which reaches the same Oxy variant
   * pipeline through the proxy once its bytes have been mirrored.
   */
  fullUrl?: string;
}

/**
 * Oxy asset IMAGE variant taxonomy lives in `@mention/shared-types`
 * (`MEDIA_VARIANT_*`) as the single source of truth shared with the frontend.
 * The asset service (`packages/api/src/services/variantService.ts`
 * `imageVariants`) generates only `w96` / `w128` / `thumb`(256) / `w320` /
 * `w640` / `w1280` / `w2048`; `small`/`medium`/`large`/`original`/`avatar` 404
 * on the CDN. Each render context maps to a real, existing variant instead of
 * the raw original.
 *
 *  - thumbnail (post media card / profile grid) → {@link MEDIA_VARIANT_THUMB}.
 *    Both surfaces are ≤320px wide, so this resolves to the lighter `w320`
 *    variant rather than a wider one — big enough for a retina render of those
 *    small cards/cells without paying for the wider variants.
 *  - fullscreen lightbox (upgrade on open)      → {@link MEDIA_VARIANT_FULL}.
 *  - avatars (small, circular crop)             → {@link MEDIA_VARIANT_AVATAR}.
 *    The dedicated 96px square `w96` crop — most avatars across the app
 *    render ≤40px, comfortably covered even at 3x DPR.
 *  - video posters (feed media rectangle)       → {@link MEDIA_VARIANT_VIDEO_POSTER}.
 *    Kept on the 256px `thumb` crop: a poster fills the media card, so it
 *    must not be shrunk to a small square.
 *  - profile banners (full-bleed 170px strip)   → {@link MEDIA_VARIANT_BANNER}.
 *    Bounded by width, not by the lightbox: `w1280` covers a 3x-DPR phone.
 */

/** Backend route that proxies remote media through our own origin. */
const MEDIA_PROXY_PATH = '/media/proxy';
/** Backend route that extracts a poster frame for remote videos. */
const MEDIA_POSTER_PATH = '/media/poster';

/** Our backend's own public origin (e.g. `https://api.mention.earth`). */
function getPublicBase(): string {
  return config.publicApiUrl;
}

/**
 * The Oxy CDN host (e.g. `cloud.oxy.so`). A federated avatar Oxy has already
 * mirrored resolves to a final `cloud.oxy.so/<id>` URL (not a bare file id), so
 * we still need to attach the avatar variant to it rather than serving the
 * no-variant original or double-proxying our own CDN. Defensive like the rest of
 * this module: returns `undefined` on any failure instead of throwing.
 */
function getCloudHost(): string | undefined {
  try {
    return new URL(getServiceOxyClient().getCloudURL()).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * The set of hostnames we consider "ours" — media already served from these is
 * returned verbatim instead of being wrapped behind the proxy. Includes the
 * backend public origin and the Oxy API origin (CDN/stream endpoints).
 */
function getOwnHosts(): Set<string> {
  const hosts = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    try {
      hosts.add(new URL(value).host.toLowerCase());
    } catch {
      // Ignore unparseable origins — they simply won't match.
    }
  };
  add(getPublicBase());
  try {
    add(getServiceOxyClient().getBaseURL());
  } catch (error) {
    logger.warn('[mediaResolver] Failed to resolve Oxy base URL for own-host check:', error);
  }
  return hosts;
}

/**
 * Attach `variant` to `url` if it's hosted on our own Oxy CDN
 * (`cloud.oxy.so`) — idempotent (`set`, not `append`, so a pre-existing
 * `variant` param is overwritten rather than duplicated). Returns `url`
 * unchanged for any other host or if it isn't a parseable absolute URL.
 * Never throws. Shared by every caller that has an already-final Oxy CDN URL
 * (not a bare file id) and needs to size it down instead of serving the
 * no-variant original — {@link resolveAvatarUrl} and Oxy-hosted link-preview
 * images.
 */
export function attachCdnVariant(url: string, variant: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.host.toLowerCase() !== getCloudHost()) {
      return url;
    }
    parsed.searchParams.set('variant', variant);
    return parsed.toString();
  } catch {
    return url;
  }
}

/** True when `ref` is an absolute `http(s)` URL. */
function isAbsoluteHttpUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref);
}

/**
 * Build a `${PUBLIC_BASE}${path}?url=<encoded ref>` URL, optionally asking the
 * proxy for a sized `variant` of the remote image.
 *
 * The variant is a REQUEST, not a promise: `/media/proxy` honours it only once
 * the remote bytes have been mirrored into Oxy (whose variant pipeline does the
 * actual resizing), and otherwise streams the original. Emitting it regardless is
 * what makes a thumbnail request distinguishable from a full-size one in the
 * first place — without it the proxy cannot tell the two apart and has no choice
 * but to serve the original to both.
 */
function buildProxyUrl(path: string, ref: string, variant?: string): string {
  const base = `${getPublicBase()}${path}?url=${encodeURIComponent(ref)}`;
  return variant ? `${base}&variant=${encodeURIComponent(variant)}` : base;
}

/**
 * Resolve a single media reference into final URL(s). Never throws.
 */
export function resolveMediaRef(ref: string | null | undefined): ResolvedMedia {
  if (!ref || typeof ref !== 'string') {
    return { url: '' };
  }

  try {
    if (isAbsoluteHttpUrl(ref)) {
      let host: string;
      try {
        host = new URL(ref).host.toLowerCase();
      } catch {
        // Malformed absolute URL — return it untouched rather than proxying garbage.
        return { url: ref };
      }

      if (getOwnHosts().has(host)) {
        // Already served from one of our origins; nothing to rewrite.
        return { url: ref };
      }

      // Federated/external media: serve it through our own proxy, asking for the
      // SAME sized variants the Oxy branch below uses. `thumbUrl` must never be
      // the full-size URL: a feed card renders it directly, so pointing it at the
      // original makes every media post download a multi-megabyte file to fill a
      // ≤320px box. `url` stays un-varianted — it is the raw original and, for a
      // federated video, the playable source.
      return {
        url: buildProxyUrl(MEDIA_PROXY_PATH, ref),
        thumbUrl: buildProxyUrl(MEDIA_PROXY_PATH, ref, MEDIA_VARIANT_THUMB),
        posterUrl: buildProxyUrl(MEDIA_POSTER_PATH, ref),
        fullUrl: buildProxyUrl(MEDIA_PROXY_PATH, ref, MEDIA_VARIANT_FULL),
      };
    }

    // Treat anything else as an Oxy file id. `getFileDownloadUrl` is synchronous
    // pure URL construction (no network). Emit display-sized image variants so
    // thumbnails don't render the 256px crop (too small) and the lightbox can
    // upgrade to a large variant instead of reusing the thumb or pulling the raw
    // original. `url` stays the no-variant original (also the playable source for
    // videos, where these image variants are simply ignored by the player).
    const client = getServiceOxyClient();
    const url = client.getFileDownloadUrl(ref);
    const thumbUrl = client.getFileDownloadUrl(ref, MEDIA_VARIANT_THUMB);
    const fullUrl = client.getFileDownloadUrl(ref, MEDIA_VARIANT_FULL);
    return { url, thumbUrl, posterUrl: thumbUrl, fullUrl };
  } catch (error) {
    logger.warn('[mediaResolver] Failed to resolve media ref; falling back to passthrough:', error);
    return { url: ref };
  }
}

/**
 * Resolve an avatar reference to a FINAL URL. For an Oxy file id this is the
 * dedicated 96px square `w96` crop — avatars are rendered tiny and circular,
 * so the small square crop is correct (unlike post media, which uses wider
 * variants) and far lighter than the 256px `thumb`.
 *
 * For an absolute URL already on the Oxy CDN host (`cloud.oxy.so`) — the shape a
 * federated avatar takes once Oxy has mirrored it at resolve/hydration time — the
 * avatar variant is attached directly to the URL rather than serving the
 * no-variant original or needlessly double-proxying our own CDN. For a genuinely
 * external/federated CDN it is the proxied URL, carrying that same avatar
 * variant so the proxy can serve a small square render instead of the remote
 * original. Returns `undefined` when the reference is empty so callers can omit
 * the field.
 */
export function resolveAvatarUrl(ref?: string | null): string | undefined {
  if (!ref || typeof ref !== 'string') {
    return undefined;
  }
  try {
    if (isAbsoluteHttpUrl(ref)) {
      let host: string | undefined;
      try {
        host = new URL(ref).host.toLowerCase();
      } catch {
        // Malformed absolute URL — return it untouched rather than proxying garbage.
        return ref;
      }
      if (host && host === getCloudHost()) {
        // Federated avatar Oxy already mirrored to its CDN: attach the avatar
        // variant to the existing URL instead of serving the no-variant
        // original or proxying our own CDN through /media/proxy.
        return attachCdnVariant(ref, MEDIA_VARIANT_AVATAR);
      }
      // Defer to the shared resolver for own-origin passthrough / proxy wrapping.
      // A genuinely-external avatar must ask the proxy for the AVATAR variant
      // specifically: `resolveMediaRef`'s `thumbUrl` is sized for a post media
      // card (`w320`), which is several times larger than any avatar is ever
      // rendered. Own-origin refs resolve to a bare `url` with no variant to
      // attach, so the fallback below covers them.
      const resolved = resolveMediaRef(ref);
      if (resolved.thumbUrl) {
        return buildProxyUrl(MEDIA_PROXY_PATH, ref, MEDIA_VARIANT_AVATAR);
      }
      return resolved.url || undefined;
    }
    // Oxy file id → square avatar crop.
    return getServiceOxyClient().getFileDownloadUrl(ref, MEDIA_VARIANT_AVATAR) || undefined;
  } catch (error) {
    logger.warn('[mediaResolver] Failed to resolve avatar ref; falling back to passthrough:', error);
    return ref;
  }
}

/**
 * Resolve a profile-banner reference to a FINAL URL, sized for the banner strip
 * ({@link MEDIA_VARIANT_BANNER}).
 *
 * Same three-way shape as {@link resolveAvatarUrl}, and it exists for the same
 * reason: {@link resolveMediaRef}'s `url` is deliberately the NO-VARIANT
 * original, so a caller that hands a banner to a client through it ships the raw
 * upload — megabytes of PNG straight from the camera roll — for a 170px-tall
 * strip. Both banner shapes must therefore attach the variant explicitly:
 *  - a bare Oxy file id (what the picker and the federated-actor mirror write)
 *    resolves through the SDK builder with the variant;
 *  - an absolute URL already on the Oxy CDN (legacy rows) gets the variant
 *    attached in place rather than being served un-transformed or pointlessly
 *    double-proxied through our own `/media/proxy`;
 *  - a genuinely external/federated CDN URL falls back to the shared resolver's
 *    proxy wrapping (no variant system exists there).
 *
 * Returns `undefined` for an empty reference so callers can omit the field.
 */
export function resolveBannerUrl(ref?: string | null): string | undefined {
  if (!ref || typeof ref !== 'string') {
    return undefined;
  }
  try {
    if (isAbsoluteHttpUrl(ref)) {
      let host: string | undefined;
      try {
        host = new URL(ref).host.toLowerCase();
      } catch {
        // Malformed absolute URL — return it untouched rather than proxying garbage.
        return ref;
      }
      if (host && host === getCloudHost()) {
        return attachCdnVariant(ref, MEDIA_VARIANT_BANNER);
      }
      return resolveMediaRef(ref).url || undefined;
    }
    // Oxy file id → banner-width variant.
    return getServiceOxyClient().getFileDownloadUrl(ref, MEDIA_VARIANT_BANNER) || undefined;
  } catch (error) {
    logger.warn('[mediaResolver] Failed to resolve banner ref; falling back to passthrough:', error);
    return ref;
  }
}

/**
 * The intrinsic geometry a client needs to reserve the correct box BEFORE any
 * byte of the image arrives.
 *
 * These fields are resolved once at ingest — from Oxy for native uploads
 * (`MediaMetadataService.enrichFromOxy`) or from the AP attachment for
 * federated ones — and persisted on the post, so they are already in hand here.
 * They must be forwarded rather than rebuilt: every return site below
 * constructs a fresh object, so anything not explicitly carried over is
 * silently dropped, and a client with no geometry has no choice but to render a
 * placeholder box and then re-lay-out once it has measured the bytes itself.
 *
 * `aspectRatio` is emitted rather than left to the client to divide, because it
 * is what Mention's renderers already read, and because it is computed at a
 * single Oxy chokepoint from the same width/height pair emitted beside it — so
 * the two can never disagree. Deriving it per-app instead would put the same
 * arithmetic in every consumer.
 *
 * Each field is omitted when absent so a media item that genuinely has no known
 * geometry keeps its current shape rather than gaining `undefined` keys.
 */
function persistedGeometry(item: MediaItem): Partial<MediaItem> {
  return {
    ...(item.width !== undefined ? { width: item.width } : {}),
    ...(item.height !== undefined ? { height: item.height } : {}),
    ...(item.aspectRatio !== undefined ? { aspectRatio: item.aspectRatio } : {}),
    ...(item.orientation !== undefined ? { orientation: item.orientation } : {}),
    ...(item.durationSec !== undefined ? { durationSec: item.durationSec } : {}),
  };
}

/**
 * Enrich a list of {@link MediaItem}s with final `url`/`thumbUrl`/`posterUrl`/
 * `fullUrl`, preserving each item's `id`, `type`, `alt` (accessibility
 * description — passed through unchanged, it is not a URL and needs no
 * resolution) and its persisted {@link persistedGeometry}. Items without an
 * `id` are dropped.
 *
 * Because each return site builds a fresh object, this list IS the public shape
 * of a media cell — a property with two edges. It is what let the geometry go
 * missing silently, and it is also the boundary that keeps ingest bookkeeping
 * (`sizeBytes`, `mime`, `cachedFromFederation`, and above all `remoteUrl`, the
 * origin URL a federated item is proxied to hide) off the wire. Widening the
 * list is therefore a deliberate act, not a formality; a test pins the exclusion
 * so the next field added has to be a decision.
 */
export function resolveMediaItems(items: MediaItem[] | undefined | null): MediaItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  return items
    .filter((item): item is MediaItem => Boolean(item) && typeof item.id === 'string' && item.id.length > 0)
    .map((item) => {
      const resolved = resolveMediaRef(item.id);
      // Accessibility description — passthrough only (never a URL). Omitted when
      // absent so the field stays off items that have no alt text.
      const altField = item.alt ? { alt: item.alt } : {};
      const geometry = persistedGeometry(item);

      if (item.type === 'video' && !isAbsoluteHttpUrl(item.id)) {
        try {
          const posterUrl = getServiceOxyClient().getFileDownloadUrl(item.id, MEDIA_VARIANT_VIDEO_POSTER);
          // Adaptive-bitrate HLS master playlist. NOT guaranteed to exist yet
          // (background transcode is fire-and-forget on upload) — the frontend
          // player MUST fall back to `url` (the raw original) on a playback
          // error. See MediaItem.hlsUrl's doc comment for the full contract.
          const hlsUrl = getServiceOxyClient().getFileDownloadUrl(item.id, 'hls_master');
          return {
            id: item.id,
            type: item.type,
            ...altField,
            ...geometry,
            url: resolved.url || undefined,
            thumbUrl: posterUrl,
            posterUrl,
            hlsUrl,
          };
        } catch (error) {
          logger.warn('[mediaResolver] Failed to resolve video poster; falling back to media ref:', error);
        }
      }

      if (item.type === 'gif' && !isAbsoluteHttpUrl(item.id)) {
        // GIFs must animate. The Oxy image variants are STATIC — oxy-api
        // variantService runs sharp() WITHOUT { animated:true }, so every variant is
        // the first frame. Point all display URLs at the no-variant animated original.
        const original = resolved.url || undefined;
        return {
          id: item.id,
          type: item.type,
          ...altField,
          ...geometry,
          url: original,
          thumbUrl: original,
          posterUrl: original,
          fullUrl: original,
        };
      }

      return {
        id: item.id,
        type: item.type,
        ...altField,
        ...geometry,
        url: resolved.url || undefined,
        thumbUrl: resolved.thumbUrl,
        posterUrl: resolved.posterUrl,
        fullUrl: resolved.fullUrl,
      };
    });
}
