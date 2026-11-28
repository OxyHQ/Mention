/**
 * The intrinsic size of a web `<video>`, for a player whose record carries no
 * dimensions.
 *
 * expo-video's web player reports no track sizes (`videoTrack` /
 * `availableVideoTracks` carry none), so on web the only source of a video's
 * shape is the element itself: `videoWidth`/`videoHeight`, known once its
 * metadata loaded (the player reads them at `readyToPlay`). Without it a video stored before its dimensions were
 * collected (an Instagram Reel in the half-minute after import) keeps the
 * card's fallback box — or, before that box existed, rendered as nothing.
 */

/** The part of an `HTMLVideoElement` this reads — structural, so it is testable without a DOM. */
export interface VideoElementLike {
  readonly videoWidth: number;
  readonly videoHeight: number;
}

function isVideoElement(value: unknown): value is VideoElementLike {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<VideoElementLike>;
  return typeof candidate.videoWidth === 'number' && typeof candidate.videoHeight === 'number';
}

/**
 * The `<video>` behind a web `VideoView`: its `nativeRef` (the element
 * `hlsPlayback` attaches to), else the first `<video>` inside `container`.
 */
export function findVideoElement(
  view: { nativeRef?: { current?: unknown } } | null | undefined,
  container: { querySelector?: (selector: string) => unknown } | null | undefined,
): VideoElementLike | null {
  const own = view?.nativeRef?.current;
  if (isVideoElement(own)) return own;
  const found = container?.querySelector?.('video');
  return isVideoElement(found) ? found : null;
}
