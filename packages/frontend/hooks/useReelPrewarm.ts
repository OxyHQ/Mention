import { useAppForeground } from '@oxy.so/bloom/hooks';
import { useNetworkStatus } from '@oxy.so/bloom/connection-status';
import { useAnyVideoPlaying } from '@/stores/videoPlayerRegistry';

/**
 * Whether the reel, while another screen is in front, may keep its first slide
 * prepared: a pooled player holding a short slice of the video
 * (`VIDEO_PRELOAD_BUFFER_OPTIONS`), so opening the Videos tab lands on a
 * picture and starts at once, as Instagram's Reels tab does.
 *
 * Only when it costs the viewer nothing they would notice:
 * - the app is in the foreground;
 * - the connection is online and not metered (Wi-Fi or unmetered; cellular and
 *   connections the platform marks expensive wait, as Instagram's "use less
 *   cellular data" does);
 * - no video is being asked to play, so the slice never takes the bandwidth of
 *   one the reader is watching on Home.
 *
 * Anything that stops holding is cheap to start again: the slice is in the
 * Android disk cache (`utils/videoSource`).
 */
export function useReelPrewarm(): boolean {
  const foreground = useAppForeground();
  const network = useNetworkStatus();
  const videoPlaying = useAnyVideoPlaying();
  return foreground && network.online && !network.metered && !videoPlaying;
}
