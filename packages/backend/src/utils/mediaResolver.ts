import {
  type MediaItem,
  MEDIA_VARIANT_THUMB,
  MEDIA_VARIANT_FULL,
  MEDIA_VARIANT_AVATAR,
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
 *        sees same-origin, cacheable, range-seekable bytes.
 *  - anything else → treated as an Oxy file id and turned into a CDN/stream URL
 *    via the SDK's synchronous `getFileDownloadUrl` (pure URL construction, no
 *    network), with image variants for image thumbnails/fullscreen and the
 *    native `thumb` variant for video posters.
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
   * be derived. Sized for the on-open upgrade, NOT the raw original. Only emitted
   * for Oxy file ids — federated/proxied media has no variant system.
   */
  fullUrl?: string;
}

/**
 * Oxy asset IMAGE variant taxonomy lives in `@mention/shared-types`
 * (`MEDIA_VARIANT_*`) as the single source of truth shared with the frontend.
 * The asset service (`packages/api/src/services/variantService.ts`
 * `imageVariants`) generates only `thumb`(256) / `w320` / `w640` / `w1280` /
 * `w2048`; `small`/`medium`/`large`/`original` 404 on the CDN. Verified live
 * scale: `thumb`~2.6KB, `w320`~4KB, `w2048`~25.2KB, raw original ~77KB. Each
 * render context maps to a real, existing variant instead of the 256px thumb or
 * the raw original.
 *
 *  - thumbnail (post media card / profile grid) → {@link MEDIA_VARIANT_THUMB}.
 *    Both surfaces are ≤320px wide, so this resolves to the lighter `w320`
 *    variant rather than a wider one — big enough for a retina render of those
 *    small cards/cells without paying for the wider variants.
 *  - fullscreen lightbox (upgrade on open)      → {@link MEDIA_VARIANT_FULL}.
 *  - avatars (small, square crop)               → {@link MEDIA_VARIANT_AVATAR}.
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

/** True when `ref` is an absolute `http(s)` URL. */
function isAbsoluteHttpUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref);
}

/** Build a `${PUBLIC_BASE}${path}?url=<encoded ref>` URL. */
function buildProxyUrl(path: string, ref: string): string {
  return `${getPublicBase()}${path}?url=${encodeURIComponent(ref)}`;
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

      // Federated/external media: serve it through our own proxy.
      const proxied = buildProxyUrl(MEDIA_PROXY_PATH, ref);
      return {
        url: proxied,
        thumbUrl: proxied,
        posterUrl: buildProxyUrl(MEDIA_POSTER_PATH, ref),
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
 * small square `thumb` (256px) crop — avatars are rendered tiny and circular, so
 * the square crop is correct (unlike post media, which uses wider variants). For
 * federated/proxied avatars it is the proxied URL. Returns `undefined` when the
 * reference is empty so callers can omit the field.
 */
export function resolveAvatarUrl(ref?: string | null): string | undefined {
  if (!ref || typeof ref !== 'string') {
    return undefined;
  }
  try {
    if (isAbsoluteHttpUrl(ref)) {
      // Defer to the shared resolver for own-origin passthrough / proxy wrapping.
      const resolved = resolveMediaRef(ref);
      return (resolved.thumbUrl || resolved.url) || undefined;
    }
    // Oxy file id → square avatar crop.
    return getServiceOxyClient().getFileDownloadUrl(ref, MEDIA_VARIANT_AVATAR) || undefined;
  } catch (error) {
    logger.warn('[mediaResolver] Failed to resolve avatar ref; falling back to passthrough:', error);
    return ref;
  }
}

/**
 * Enrich a list of {@link MediaItem}s with final `url`/`thumbUrl`/`posterUrl`/
 * `fullUrl`, preserving each item's `id` and `type`. Items without an `id` are
 * dropped.
 */
export function resolveMediaItems(items: MediaItem[] | undefined | null): MediaItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  return items
    .filter((item): item is MediaItem => Boolean(item) && typeof item.id === 'string' && item.id.length > 0)
    .map((item) => {
      const resolved = resolveMediaRef(item.id);

      if (item.type === 'video' && !isAbsoluteHttpUrl(item.id)) {
        try {
          const posterUrl = getServiceOxyClient().getFileDownloadUrl(item.id, MEDIA_VARIANT_AVATAR);
          return {
            id: item.id,
            type: item.type,
            url: resolved.url || undefined,
            thumbUrl: posterUrl,
            posterUrl,
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
          url: original,
          thumbUrl: original,
          posterUrl: original,
          fullUrl: original,
        };
      }

      return {
        id: item.id,
        type: item.type,
        url: resolved.url || undefined,
        thumbUrl: resolved.thumbUrl,
        posterUrl: resolved.posterUrl,
        fullUrl: resolved.fullUrl,
      };
    });
}
