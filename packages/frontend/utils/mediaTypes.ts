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

/** Intrinsic pixel size of a media item, as a pair. */
export interface MediaPixelSize {
  width: number;
  height: number;
}

/**
 * A width and height that describe a real shape, or `undefined`.
 *
 * ONE definition of a usable axis — positive and finite — because two callers need
 * it: the persisted dimensions below, and the size a video player reports. Both
 * feed the Android Picture-in-Picture window, which rejects a non-positive axis
 * outright, and `0 × 0` is precisely what a player reports before it has decoded a
 * frame. Non-finite is checked as well as positive: `NaN <= 0` is false, so a
 * comparison alone would let `NaN` through.
 *
 * BOTH axes or nothing: one alone says nothing about shape, and every caller here
 * wants a ratio.
 */
export function toMediaPixelSize(width: unknown, height: unknown): MediaPixelSize | undefined {
  if (!isUsableAxis(width) || !isUsableAxis(height)) return undefined;
  return { width, height };
}

function isUsableAxis(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Read the stored intrinsic pixel size from the media DTO.
 *
 * `undefined` where the backend has not backfilled the dimensions, which is normal
 * for older media.
 *
 * Unlike [readMediaAspectRatio] this does not fall back to the stored
 * `aspectRatio` — a ratio cannot be turned back into a size, and the one caller
 * that needs a size (the Picture-in-Picture window, which takes a `Rational`)
 * would only be handing the same information through a lossier route.
 */
export function readMediaPixelSize(
  item: PersistedMediaDimensions | undefined,
): MediaPixelSize | undefined {
  return toMediaPixelSize(item?.width, item?.height);
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
 * Decide whether a media reference is a video from the canonical per-item type
 * and, for older media whose metadata is incomplete, the file extension.
 */
export function isVideoMediaRef(
  raw: string,
  options: { mediaType?: string } = {},
): boolean {
  const isMediaTypeVideo = options.mediaType === 'video';
  return isMediaTypeVideo || isVideoExtension(raw);
}
