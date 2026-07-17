import type { MediaItem } from '@mention/shared-types';
import { mergeMediaItem, patchFromApAttachment } from '../../services/MediaMetadataService';

/**
 * ActivityPub media-attachment extraction.
 *
 * Different fediverse servers describe attachment URLs in incompatible shapes:
 *  - Mastodon: `attachment[].url` is a plain string, MIME on `attachment[].mediaType`.
 *  - PeerTube/Lemmy: `attachment[].url` is an ARRAY of `Link` objects, each with its
 *    own `href` + `mediaType` (progressive `video/mp4`, HLS `application/x-mpegURL`,
 *    DASH `application/dash+xml`, etc.).
 *  - Pleroma/Misskey: `attachment[].url` may be a single `Link` object `{href, mediaType}`.
 *
 * This module normalizes all of those into a single string URL + classified media
 * type so the three Post insert paths (outbox backfill, inbox Create, Announce)
 * store a consistent, playable `MediaItem` shape.
 */

/** A single AP `Link` object as it appears inside `attachment[].url`. */
export interface ApUrlEntry {
  type?: string;
  href?: string;
  mediaType?: string;
}

/** A single entry of an AP Note's `attachment` array. */
export interface ApAttachment {
  type?: string;
  mediaType?: string;
  /** Accessibility text on Mastodon/Pleroma attachments. */
  name?: string;
  width?: number;
  height?: number;
  duration?: number | string;
  /** String (Mastodon), Link object (Pleroma), or array of Link objects (PeerTube). */
  url?: string | ApUrlEntry | Array<string | ApUrlEntry>;
}

/** Resolved media classification. */
export type ApMediaType = 'image' | 'video';

/** A candidate URL resolved to a concrete string href + its (possibly empty) MIME. */
interface ResolvedUrl {
  href: string;
  mimeType: string;
}

/**
 * File extensions that indicate a video, mirroring the frontend's detection in
 * `components/Profile/MediaGrid.tsx` / `VideosGrid.tsx`. HLS/DASH manifests are
 * also treated as video.
 */
const VIDEO_EXTENSION_RE = /\.(mp4|mov|m4v|webm|mpg|mpeg|avi|mkv|m3u8|mpd)(?:[?#].*)?$/i;

/** Common still-image extensions. */
const IMAGE_EXTENSION_RE = /\.(jpe?g|png|gif|webp|avif|bmp|heic|heif|tiff?)(?:[?#].*)?$/i;

/** Progressive-download MIME types with the broadest player compatibility. */
const PROGRESSIVE_VIDEO_MIME = 'video/mp4';

/** HLS/DASH manifest MIME types (least preferred — many web players can't play them natively). */
const STREAMING_VIDEO_MIMES = new Set([
  'application/x-mpegurl',
  'application/vnd.apple.mpegurl',
  'application/dash+xml',
]);

/**
 * Coerce a single `url` member (string or object) into a `ResolvedUrl`, pulling the
 * MIME from the link object first and falling back to the attachment-level MIME.
 * Returns `null` for anything without a usable string href.
 */
function toResolvedUrl(
  member: string | ApUrlEntry | undefined,
  attachmentMimeType: string,
): ResolvedUrl | null {
  if (typeof member === 'string') {
    const href = member.trim();
    if (!href) return null;
    return { href, mimeType: attachmentMimeType };
  }
  if (member && typeof member === 'object') {
    const href = typeof member.href === 'string' ? member.href.trim() : '';
    if (!href) return null;
    const mimeType = (member.mediaType || attachmentMimeType || '').toLowerCase();
    return { href, mimeType };
  }
  return null;
}

/** Normalize a possibly-empty MIME string for comparison. */
function normalizeMime(mimeType: string): string {
  return mimeType.trim().toLowerCase();
}

/** Classify a resolved URL as image/video, inferring from the extension when MIME is absent. */
function classify(resolved: ResolvedUrl): ApMediaType | null {
  const mime = normalizeMime(resolved.mimeType);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (STREAMING_VIDEO_MIMES.has(mime)) return 'video';

  // MIME missing or unrecognized — fall back to the file extension.
  if (VIDEO_EXTENSION_RE.test(resolved.href)) return 'video';
  if (IMAGE_EXTENSION_RE.test(resolved.href)) return 'image';
  return null;
}

/**
 * Classify an attachment from its AP `type` discriminator — the LAST-RESORT
 * signal used only when neither the MIME type nor a file extension resolves.
 *
 * Bridgy Fed (brid.gy) bridges Bluesky media as
 * `{ type:'Image'|'Video', width, height, url:'https://…bsky.network/xrpc/com.atproto.sync.getBlob?did=…&cid=…' }`:
 * NO `mediaType`, and the `getBlob` URL carries no extension, so the AP object
 * `type` is the only remaining evidence of the medium. Mastodon/Pleroma always
 * send a MIME, so their MIME-first path never reaches this.
 */
function classifyFromApType(attachment: ApAttachment): ApMediaType | null {
  const apType = typeof attachment.type === 'string' ? attachment.type : undefined;
  switch (apType) {
    case 'Image':
      return 'image';
    case 'Video':
      return 'video';
    case 'Audio':
      // The Post media model has no dedicated audio kind; an audio attachment is
      // stored as a video item so it stays playable through the video pipeline
      // rather than being dropped.
      return 'video';
    case 'Document':
      // A generic `Document` with no MIME is only treated as an image when it
      // carries still-image dimensions and no playback duration (a duration would
      // imply audio/video, which cannot be assumed from `Document` alone).
      return isImageIshDocument(attachment) ? 'image' : null;
    default:
      return null;
  }
}

/** True when a MIME-less `Document` looks like a still image: has pixel dimensions and no duration. */
function isImageIshDocument(attachment: ApAttachment): boolean {
  const hasDuration = attachment.duration !== undefined && attachment.duration !== null;
  const width = typeof attachment.width === 'number' ? attachment.width : 0;
  const height = typeof attachment.height === 'number' ? attachment.height : 0;
  return !hasDuration && (width > 0 || height > 0);
}

/**
 * Rank a video candidate for "most broadly playable":
 *  0 — progressive `video/mp4` (best `expo-video`/web `<video>` compatibility)
 *  1 — any other `video/*` (webm, quicktime, etc.)
 *  2 — HLS/DASH manifest (only used when nothing better exists)
 *
 * MIME-less candidates are scored by extension with the same ordering.
 */
function videoPreferenceScore(resolved: ResolvedUrl): number {
  const mime = normalizeMime(resolved.mimeType);
  if (mime === PROGRESSIVE_VIDEO_MIME) return 0;
  if (mime.startsWith('video/')) return 1;
  if (STREAMING_VIDEO_MIMES.has(mime)) return 2;

  // Infer from extension when MIME is missing.
  if (/\.mp4(?:[?#].*)?$/i.test(resolved.href)) return 0;
  if (/\.(m3u8|mpd)(?:[?#].*)?$/i.test(resolved.href)) return 2;
  if (VIDEO_EXTENSION_RE.test(resolved.href)) return 1;
  return 3;
}

/**
 * Resolve a single AP attachment to a string href + classified type, choosing the
 * most broadly-playable variant when multiple URL candidates are present.
 *
 * Never throws: malformed/empty entries resolve to `null` and are skipped by the caller.
 */
export function resolveApAttachment(
  attachment: ApAttachment | null | undefined,
): { href: string; type: ApMediaType } | null {
  if (!attachment || typeof attachment !== 'object') return null;
  if (attachment.url === undefined || attachment.url === null) return null;

  const attachmentMime = normalizeMime(attachment.mediaType || '');

  // Normalize `url` into a flat list of resolved candidates.
  const members: Array<string | ApUrlEntry> = Array.isArray(attachment.url)
    ? attachment.url
    : [attachment.url];

  const resolved: ResolvedUrl[] = [];
  for (const member of members) {
    const r = toResolvedUrl(member, attachmentMime);
    if (r) resolved.push(r);
  }
  if (resolved.length === 0) return null;

  // Split candidates by classified type.
  const videos: ResolvedUrl[] = [];
  const images: ResolvedUrl[] = [];
  for (const r of resolved) {
    const kind = classify(r);
    if (kind === 'video') videos.push(r);
    else if (kind === 'image') images.push(r);
  }

  // Prefer video when present: pick the most broadly-playable variant.
  if (videos.length > 0) {
    let best = videos[0];
    let bestScore = videoPreferenceScore(best);
    for (let i = 1; i < videos.length; i++) {
      const score = videoPreferenceScore(videos[i]);
      if (score < bestScore) {
        best = videos[i];
        bestScore = score;
      }
    }
    return { href: best.href, type: 'video' };
  }

  // Otherwise take the first valid image.
  if (images.length > 0) {
    return { href: images[0].href, type: 'image' };
  }

  // Nothing classified by MIME or extension. When NO MIME was declared at all —
  // the Bridgy Fed shape (`type:'Image'`/`'Video'`, extensionless getBlob URL, no
  // `mediaType`) — fall back to the AP `type` discriminator. A candidate that DID
  // declare a MIME we don't recognize (e.g. `application/pdf`) is a deliberate
  // non-media type and stays skipped, so Mastodon's MIME-first path is preserved.
  const undeclared = resolved.find((r) => normalizeMime(r.mimeType).length === 0);
  if (undeclared) {
    const apType = classifyFromApType(attachment);
    if (apType) return { href: undeclared.href, type: apType };
  }

  return null;
}

/**
 * Extract media items + attachment descriptors from an AP Note's `attachment` array.
 * Output shape is intentionally fixed to match `MediaItem` (`{ id, type }`) and the
 * Post `attachments` descriptor — the frontend and native posts depend on it.
 */
export function extractApMediaFromNote(note: { attachment?: unknown }): {
  media: MediaItem[];
  attachments: Array<{ type: 'media'; id: string; mediaType: ApMediaType }>;
} {
  const media: MediaItem[] = [];
  const attachments: Array<{ type: 'media'; id: string; mediaType: ApMediaType }> = [];

  if (!Array.isArray(note.attachment)) return { media, attachments };

  for (const att of note.attachment) {
    const resolved = resolveApAttachment(att as ApAttachment);
    if (!resolved) continue;
    const patch = patchFromApAttachment(att as ApAttachment);
    const item = mergeMediaItem({ id: resolved.href, type: resolved.type }, patch);
    media.push(item);
    attachments.push({ type: 'media', id: resolved.href, mediaType: resolved.type });
  }

  return { media, attachments };
}
