/**
 * Shared media-type detection helpers for the frontend.
 *
 * Centralizes the video detection logic that grids and media renderers would
 * otherwise duplicate. The backend keeps its own copy (different module system,
 * different runtime) — this util covers the frontend only.
 */

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
