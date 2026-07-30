import { useEffect, useState } from 'react';
import { useEventListener } from 'expo';
import type { VideoPlayer, VideoTrack } from 'expo-video';
import { createScopedLogger } from '@/lib/logger';
import { setPipAspectRatio } from '@/modules/pip-transport';
import { toMediaPixelSize, type MediaPixelSize } from '@/utils/mediaTypes';

/**
 * Give the **Android** OS Picture-in-Picture window the shape of the video it is
 * about to show, so a portrait reel does not come up in a landscape box.
 *
 * ## Why the app has to do this at all
 *
 * expo-video sets the window's aspect ratio in exactly one place —
 * `VideoView.onVideoSourceLoaded` calls `calculateCurrentPipAspectRatio()`, which
 * reads `player.videoSize` — and its `VideoView` has no `onVideoSizeChanged`, so
 * the value is never recomputed. Two consequences, and a reels screen hits both:
 *
 *  - At source-load time ExoPlayer has usually not reported a size yet, so the
 *    ratio cannot be computed. What the window gets then is expo-video's OWN
 *    default, and that default is `Rational(16, 9)` (`PiPParams.aspectRatio`) —
 *    landscape, asserted rather than merely absent, which is why the reported bug
 *    is so consistent.
 *  - A screen that swaps sources with `replaceAsync` keeps whichever ratio the
 *    first source produced, so even a correct value goes stale on the next video.
 *
 * ## When it fires
 *
 * Per video, not once — that staleness is half the bug. The size arrives from
 * `videoTrackChange`, which fires for each new track (including after a swap), and
 * until it does the caller's persisted dimensions stand in. Publishing is keyed on
 * the SIZE, so a re-render cannot re-issue the call and a genuinely new shape
 * always does.
 *
 * Ordering matters and is why this is an effect rather than an event handler:
 * expo-video re-pushes its own params when the PiP candidate changes, which is the
 * same commit that flips [active] here. An effect runs after that commit, so this
 * value lands on top of expo-video's rather than under it.
 *
 * Where the native module is absent — iOS, web, or a build predating it — the
 * binding resolves to a no-op, so there is no platform branch at the call site.
 */

const logger = createScopedLogger('PipAspectRatio');

/**
 * The size a video track reports, or nothing when there is no usable one yet.
 *
 * `0 × 0` is the ordinary answer before ExoPlayer has decoded a frame — and it is
 * the value that lands a reel in a landscape window, so it is filtered by the same
 * rule the persisted dimensions go through rather than by a second copy of it.
 */
function trackPixelSize(track: VideoTrack | null | undefined): MediaPixelSize | undefined {
  return toMediaPixelSize(track?.size?.width, track?.size?.height);
}

/**
 * Which size the window should be told about: what is PLAYING if the player has
 * reported it, otherwise what the feed persisted about the video.
 *
 * The track wins because it is the truth about the decoded stream, and the
 * persisted dimensions are what makes the FIRST window of a session right — they
 * are known before playback starts, which is exactly when expo-video has nothing.
 *
 * `null` when neither is usable, and the caller then publishes nothing: a zero or
 * negative axis is rejected natively (`InvalidAspectRatioException`), so sending
 * one would be asking for a rejection we already know the answer to.
 */
export function resolvePipAspectSize(
  trackSize: MediaPixelSize | undefined,
  persistedSize: MediaPixelSize | undefined,
): MediaPixelSize | null {
  return trackSize ?? persistedSize ?? null;
}

export interface UsePipAspectRatioOptions {
  /** The player whose video the OS window would show. */
  player: VideoPlayer;
  /**
   * Whether this surface is the one that can enter PiP. Only the watched surface
   * publishes: the params are activity-wide, so a preloading neighbour asserting
   * its own shape would describe a video nobody is watching.
   */
  active: boolean;
  /** Intrinsic dimensions from the feed, used until the player reports a track. */
  persistedSize?: MediaPixelSize;
  /** For the log line, so a failure names the video it was about. */
  postId: string;
}

export function usePipAspectRatio({
  player,
  active,
  persistedSize,
  postId,
}: UsePipAspectRatioOptions): void {
  // Seeded from the player rather than from nothing: a surface promoted from
  // preloading neighbour to watched already has its track, and waiting for the
  // next event would leave the first window of that video on the wrong shape.
  const [trackSize, setTrackSize] = useState<MediaPixelSize | undefined>(
    () => trackPixelSize(player.videoTrack),
  );

  // `useEventListener` (expo) subscribes once per player and always invokes the
  // latest listener, so this tracks swaps without re-subscribing.
  useEventListener(player, 'videoTrackChange', ({ videoTrack }) => {
    setTrackSize(trackPixelSize(videoTrack));
  });

  const size = resolvePipAspectSize(trackSize, persistedSize);
  const width = size?.width;
  const height = size?.height;

  useEffect(() => {
    if (!active || width === undefined || height === undefined) return;
    setPipAspectRatio(width, height).catch((error: unknown) => {
      // Louder than its sibling in `usePipTransportActions`, which logs a failed
      // action list at debug: a missing button is a smaller loss than the window
      // coming up the wrong shape, and this rejection is the one signal that the
      // activity is not PiP-capable at all.
      logger.warn('Could not set the Picture-in-Picture aspect ratio', {
        postId,
        width,
        height,
        error,
      });
    });
  }, [active, width, height, postId]);
}
