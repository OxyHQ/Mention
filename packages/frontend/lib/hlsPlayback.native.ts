import type { VideoView } from 'expo-video';

/**
 * HLS playback on native: nothing to do.
 *
 * ExoPlayer (Android) and AVPlayer (iOS) both decode HLS natively, and
 * `expo-video` hands the playlist url straight to them. Shipping a JS demuxer
 * here would replace a hardware decoder with a software one — so this side of
 * the split is deliberately inert, and `active` is always false, meaning the
 * caller keeps giving the source to `expo-video`.
 *
 * The web counterpart, and why it exists at all, is in `hlsPlayback.web.ts`.
 */

/** What the caller needs to know about the JS decoder for one source. */
export interface HlsPlayback {
  /** Always false on native — the platform decoder owns HLS. */
  readonly active: boolean;
}

const NATIVE_PLAYBACK: HlsPlayback = { active: false };

export function useHlsPlayback(
  _src: string,
  _viewRef: React.RefObject<InstanceType<typeof VideoView> | null>,
): HlsPlayback {
  return NATIVE_PLAYBACK;
}
