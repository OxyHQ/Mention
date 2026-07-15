import { config } from '../config';
import { normalizeAlt } from '../services/MediaMetadataService';

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
  /** Accessibility description (alt text) for the image; normalized + length-capped. */
  alt?: string;
}

/**
 * Client-supplied alt text, at the write boundary: the canonical alt rule
 * ({@link normalizeAlt} — the SAME one the federated ingest paths apply), then the
 * product length cap.
 *
 * The cap runs last and its cut can leave a dangling space, so the rule runs
 * again over the truncated value; it is idempotent, so a value that was already
 * short is untouched.
 *
 * This is where the invariant lives for everything a Mention client writes. It
 * cannot be deferred to the read path: a native post's media is signed onto the
 * author's MTN hash chain at creation, and a signed record is immutable.
 */
export function normalizeAltInput(value: unknown): string | undefined {
  const alt = normalizeAlt(value);
  if (alt === undefined || alt.length <= config.posts.maxAltTextLength) return alt;
  return normalizeAlt(alt.slice(0, config.posts.maxAltTextLength));
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

      // Accessibility description (alt text). Explicitly whitelisted, normalized,
      // and length-capped — never spread from the raw body. Empty/whitespace-only
      // values are dropped so the field stays absent rather than an empty string.
      const alt = normalizeAltInput(obj.alt);

      seen.add(id);
      normalized.push({
        id,
        type: resolvedType,
        ...(mimeValue ? { mime: String(mimeValue) } : {}),
        ...(alt ? { alt } : {}),
      });
    }
  });

  return normalized;
}
