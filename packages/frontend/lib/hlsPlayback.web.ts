import { useEffect, useState } from 'react';
import type { VideoView } from 'expo-video';
import type HlsJs from 'hls.js';
import { createScopedLogger } from '@/lib/logger';
import { isHlsSource } from '@/utils/hlsSource';

/**
 * HLS playback on web, via hls.js over Media Source Extensions.
 *
 * Federated video from atproto is an HLS playlist. Safari and iOS decode one
 * natively; Chrome and Firefox — most desktop viewers — do NOT, and there is no
 * server-side fix for that: the manifest arrives correctly and the element still
 * refuses it. Measured in real browsers against a production Bluesky playlist:
 * every engine ended at `networkState: 3` (NETWORK_NO_SOURCE) with
 * `MEDIA_ERR_SRC_NOT_SUPPORTED` and `play()` rejecting `NotSupportedError`.
 *
 * So on web an HLS source is decoded in JS: hls.js fetches the playlist and the
 * segments (both through our media proxy, which rewrote every URI in the
 * playlist to come back through itself) and appends them to a MediaSource that
 * the SAME `<video>` element `expo-video` renders plays from. Native is
 * untouched — see `hlsPlayback.native.ts`; ExoPlayer and AVPlayer both handle
 * HLS, and shipping a JS demuxer there would be strictly worse.
 */

const logger = createScopedLogger('HlsPlayback');

/**
 * hls.js is loaded from ONE `import()` site, on purpose.
 *
 * Expo's web serializer hoists any module reachable from two or more async
 * chunks into `__common.js`, which is emitted as a NON-async script — so a
 * second `import('hls.js')` anywhere in the app would silently make the demuxer
 * part of first paint for every visitor, whether or not they ever open a video.
 * With a single site there is nothing to pair it against and the chunk stays
 * async.
 *
 * The package's own `hls.js` entry, not the smaller `hls.js/light` one: only the
 * main entry carries type declarations, and the light build would need a
 * `declare module` shim for a package that ships its own types. The difference
 * is the subtitle, alternate-audio and EME controllers — bytes a viewer only
 * downloads when they actually open an HLS video, since this chunk stays async.
 *
 * Module scope rather than inside the hook, so the fetch is shared by every
 * player and starts as soon as the first one mounts.
 */
let hlsModulePromise: Promise<typeof HlsJs> | null = null;
function loadHls(): Promise<typeof HlsJs> {
  if (!hlsModulePromise) {
    hlsModulePromise = import('hls.js').then((module) => module.default);
  }
  return hlsModulePromise;
}

/**
 * The codecs a federated HLS stream actually carries: H.264 Baseline 3.0 video
 * and AAC-LC audio, in the fragmented-MP4 container hls.js remuxes the
 * upstream MPEG-TS segments into.
 *
 * Baseline 3.0 is the most universal H.264 profile, so a browser that cannot
 * decode it cannot decode any H.264 — which is why probing this exact string is
 * meaningful where `Hls.isSupported()` is not: that check passes when MSE
 * supports ANY of H.264/AV1/VP9 and ANY of AAC/FLAC, so a build without an
 * H.264 decoder (a Firefox snap, a Linux box with no restricted extras) passes
 * it and then fails later, when the first segment is appended.
 */
const HLS_PLAYBACK_CODECS = 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';

/**
 * The MediaSource implementation hls.js will actually use, in its own order of
 * preference (`ManagedMediaSource` on recent iOS, then `MediaSource`, then the
 * legacy WebKit spelling) — so the probe below asks the same constructor that
 * will do the decoding.
 */
function resolveMediaSource(): typeof MediaSource | undefined {
  if (typeof self === 'undefined') return undefined;
  const scope = self as typeof self & {
    ManagedMediaSource?: typeof MediaSource;
    WebKitMediaSource?: typeof MediaSource;
  };
  return scope.ManagedMediaSource ?? scope.MediaSource ?? scope.WebKitMediaSource;
}

/**
 * True when this browser can decode a federated HLS stream through MSE.
 *
 * Deliberately NOT `video.canPlayType('application/vnd.apple.mpegurl')`:
 * Chromium answers `"maybe"` to that and then fails the load outright
 * (`MEDIA_ERR_SRC_NOT_SUPPORTED`), so trusting it would route every Chrome
 * viewer to a decoder that does not exist — a check that cannot tell success
 * from failure.
 */
function canDecodeHlsInJs(): boolean {
  const mediaSource = resolveMediaSource();
  if (typeof mediaSource?.isTypeSupported !== 'function') return false;
  return mediaSource.isTypeSupported(HLS_PLAYBACK_CODECS);
}

/** What the caller needs to know about the JS decoder for one source. */
export interface HlsPlayback {
  /**
   * True when hls.js owns this element's media. The caller MUST then withhold
   * the source from `expo-video` (pass `null` to `useVideoPlayer`): hls.js
   * attaches a MediaSource by setting `src` itself, and an element carrying the
   * playlist url would first try — and fail — to decode it natively.
   */
  readonly active: boolean;
}

/**
 * Attach hls.js to the `<video>` element `expo-video` rendered, for as long as
 * `src` is an HLS source this browser needs a JS decoder for.
 *
 * The element is reached through `VideoView.nativeRef`, which expo-video
 * documents as the `HTMLVideoElement` on web. Everything else about the player —
 * play/pause, muting, the time updates driving the scrubber, the status events —
 * keeps running through expo-video, whose web player operates on that same
 * element; hls.js only supplies the bytes.
 */
export function useHlsPlayback(
  src: string,
  viewRef: React.RefObject<InstanceType<typeof VideoView> | null>,
): HlsPlayback {
  // The decision is a pure function of the source and the browser, so it is
  // resolved during render (not in an effect): the caller needs it on the FIRST
  // render to decide what source to hand `expo-video`, and a later flip would
  // mean the element had already begun a doomed native load.
  const [active] = useState(() => isHlsSource(src) && canDecodeHlsInJs());

  useEffect(() => {
    if (!active) return;

    const element: unknown = viewRef.current?.nativeRef?.current;
    if (!(element instanceof HTMLVideoElement)) {
      logger.warn('No video element to attach to; HLS source will not play');
      return;
    }

    let instance: HlsJs | null = null;
    let cancelled = false;

    void loadHls()
      .then((Hls) => {
        if (cancelled) return;
        instance = new Hls();
        instance.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          logger.warn('Fatal HLS error, giving up on this source', {
            errorType: data.type,
            details: data.details,
          });
          instance?.destroy();
          instance = null;
        });
        instance.loadSource(src);
        instance.attachMedia(element);
      })
      .catch((error: unknown) => {
        logger.warn('Failed to load the HLS decoder', {
          reason: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
      instance?.destroy();
      instance = null;
    };
  }, [active, src, viewRef]);

  return { active };
}
