import type { MediaItem } from '@mention/shared-types';
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
 *    network), with a `thumb` variant for the thumbnail.
 *
 * This module NEVER throws: on any failure it degrades to the safest passthrough
 * (`{ url: ref }` or `undefined`).
 */

/** Final resolved URLs for a single media reference. */
export interface ResolvedMedia {
  /** The primary, ready-to-render URL. Empty string when the ref is falsy. */
  url: string;
  /** Thumbnail variant URL, when one can be derived. */
  thumbUrl?: string;
  /** Poster/still-frame URL (videos); mirrors `thumbUrl` for images. */
  posterUrl?: string;
}

/** Oxy asset variant requested for thumbnails. */
const THUMB_VARIANT = 'thumb';

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
    // pure URL construction (no network), with a `thumb` variant for thumbnails.
    const client = getServiceOxyClient();
    const url = client.getFileDownloadUrl(ref);
    const thumbUrl = client.getFileDownloadUrl(ref, THUMB_VARIANT);
    return { url, thumbUrl, posterUrl: thumbUrl };
  } catch (error) {
    logger.warn('[mediaResolver] Failed to resolve media ref; falling back to passthrough:', error);
    return { url: ref };
  }
}

/**
 * Resolve an avatar reference to a FINAL URL (thumbnail variant when derivable).
 * Returns `undefined` when the reference is empty so callers can omit the field.
 */
export function resolveAvatarUrl(ref?: string | null): string | undefined {
  if (!ref || typeof ref !== 'string') {
    return undefined;
  }
  const resolved = resolveMediaRef(ref);
  const value = resolved.thumbUrl || resolved.url;
  return value || undefined;
}

/**
 * Enrich a list of {@link MediaItem}s with final `url`/`thumbUrl`/`posterUrl`,
 * preserving each item's `id` and `type`. Items without an `id` are dropped.
 */
export function resolveMediaItems(items: MediaItem[] | undefined | null): MediaItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  return items
    .filter((item): item is MediaItem => Boolean(item) && typeof item.id === 'string' && item.id.length > 0)
    .map((item) => {
      const resolved = resolveMediaRef(item.id);
      return {
        id: item.id,
        type: item.type,
        url: resolved.url || undefined,
        thumbUrl: resolved.thumbUrl,
        posterUrl: resolved.posterUrl,
      };
    });
}
