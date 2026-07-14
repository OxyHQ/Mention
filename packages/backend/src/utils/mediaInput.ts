import { config } from '../config';

/**
 * A media entry accepted from a request body, normalized to the persisted shape.
 * `id` + `type` are the only required fields; `mime`/`alt` are whitelisted
 * passthroughs. Everything else the client sends is dropped — media metadata
 * (dimensions, duration, size) is resolved server-side from Oxy, never trusted.
 */
export interface NormalizedMediaItem {
  id: string;
  type: 'image' | 'video' | 'gif';
  mime?: string;
  /** Accessibility description (alt text) for the image; trimmed + length-capped. */
  alt?: string;
}

/** Untrusted media entry shape accepted from the request body before normalization. */
interface RawMediaInput {
  id?: unknown;
  fileId?: unknown;
  _id?: unknown;
  mediaId?: unknown;
  type?: unknown;
  mediaType?: unknown;
  mime?: unknown;
  contentType?: unknown;
  alt?: unknown;
}

/**
 * Normalize an untrusted media array from a request body into a deduplicated
 * list of {@link NormalizedMediaItem}s.
 *
 * The single normalizer for every write boundary that accepts client media — the
 * post create/update paths AND the localized media override on a post language
 * variant — so a media item is validated and shaped identically wherever it
 * enters the system.
 */
export function normalizeMediaItems(arr: unknown): NormalizedMediaItem[] {
  if (!Array.isArray(arr)) return [];

  const seen = new Set<string>();
  const normalized: NormalizedMediaItem[] = [];

  arr.forEach((item: unknown) => {
    if (!item) return;

    if (typeof item === 'string') {
      const id = item.trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      normalized.push({ id, type: 'image' });
      return;
    }

    if (typeof item === 'object') {
      const obj = item as RawMediaInput;
      const rawId = obj.id || obj.fileId || obj._id || obj.mediaId;
      if (!rawId) return;
      const id = String(rawId);
      if (!id || seen.has(id)) return;

      const rawType = (obj.type || obj.mediaType || '').toString().toLowerCase();
      const mimeValue = obj.mime || obj.contentType;
      const rawMime = mimeValue ? mimeValue.toString().toLowerCase() : '';

      let resolvedType: 'image' | 'video' | 'gif';
      if (rawType === 'video' || rawMime.startsWith('video/')) {
        resolvedType = 'video';
      } else if (rawType === 'gif' || rawMime.includes('gif')) {
        resolvedType = 'gif';
      } else {
        resolvedType = 'image';
      }

      // Accessibility description (alt text). Explicitly whitelisted, trimmed, and
      // length-capped — never spread from the raw body. Empty/whitespace-only
      // values are dropped so the field stays absent rather than an empty string.
      const altRaw = typeof obj.alt === 'string' ? obj.alt.trim().slice(0, config.posts.maxAltTextLength) : '';

      seen.add(id);
      normalized.push({
        id,
        type: resolvedType,
        ...(mimeValue ? { mime: String(mimeValue) } : {}),
        ...(altRaw ? { alt: altRaw } : {}),
      });
    }
  });

  return normalized;
}
