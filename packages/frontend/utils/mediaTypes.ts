/**
 * Shared media-type detection helpers for the frontend.
 *
 * Centralizes the video detection logic that grids and media renderers would
 * otherwise duplicate. The backend keeps its own copy (different module system,
 * different runtime) — this util covers the frontend only.
 */

/** Persisted intrinsic media fields the backend copies onto each MediaItem. */
export interface PersistedMediaDimensions {
  width?: number;
  height?: number;
  aspectRatio?: number;
  orientation?: 'portrait' | 'landscape' | 'square';
  durationSec?: number;
}

/**
 * Read the stored aspect ratio from a media DTO. Returns undefined when the
 * backend has not yet backfilled metadata for this item.
 */
export function readMediaAspectRatio(item: PersistedMediaDimensions | undefined): number | undefined {
  if (!item) return undefined;
  if (typeof item.aspectRatio === 'number' && item.aspectRatio > 0) return item.aspectRatio;
  if (typeof item.width === 'number' && typeof item.height === 'number' && item.width > 0 && item.height > 0) {
    return item.width / item.height;
  }
  return undefined;
}

/** Read stored orientation from the media DTO (never computed client-side). */
export function readMediaOrientation(
  item: PersistedMediaDimensions | undefined,
): 'portrait' | 'landscape' | 'square' | undefined {
  const orientation = item?.orientation;
  return orientation === 'portrait' || orientation === 'landscape' || orientation === 'square'
    ? orientation
    : undefined;
}

/** Read stored duration in seconds from the media DTO. */
export function readMediaDurationSec(item: PersistedMediaDimensions | undefined): number | undefined {
  const duration = item?.durationSec;
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

/**
 * File extensions we treat as video. Matched against the END of a URL/path
 * (case-insensitive). Kept in sync with the formats the player + poster
 * extractor support.
 */
const VIDEO_EXTENSION_PATTERN = /\.(mp4|mov|m4v|webm|mpg|mpeg|avi|mkv)$/i;

/**
 * True when the given URL/path ends in a known video file extension.
 * Tolerant of non-string input (a malformed media reference never throws).
 */
export function isVideoExtension(url: string): boolean {
  return VIDEO_EXTENSION_PATTERN.test(String(url ?? ''));
}

/**
 * Decide whether a raw media reference is a video, combining the three signals
 * the feeds expose: the post-level `type`, the per-item `mediaType`, and the
 * file extension of the reference itself. Any one being "video" is sufficient.
 */
export function isVideoMediaRef(
  raw: string,
  options: { postType?: string; mediaType?: string } = {},
): boolean {
  const isPostVideo = options.postType === 'video';
  const isMediaTypeVideo = options.mediaType === 'video';
  return isPostVideo || isMediaTypeVideo || isVideoExtension(raw);
}
