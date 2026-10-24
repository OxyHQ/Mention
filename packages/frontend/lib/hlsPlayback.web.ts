import { useCallback, useEffect, useRef, useState } from 'react';
import type { VideoViewHandle } from '@oxy.so/bloom/video-view';
import type HlsJs from 'hls.js';
import type { VideoPlayer } from 'expo-video';
import { subscribeVideoLoadingDemand } from '@/stores/video-playback-control';
import { createLogger } from '@oxy.so/core/logger';
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

const logger = createLogger('HlsPlayback');

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

/**
 * True when `src` will be decoded by hls.js on this browser — the same test
 * `useHlsPlayback` makes, for code that builds a player before any element
 * exists (the shared player registry) and must withhold the source from it.
 */
export function needsJsHlsDecoder(src: string | undefined | null): boolean {
  return isHlsSource(src) && canDecodeHlsInJs();
}

/**
 * hls.js tuning for feed-sized players. The defaults buffer 30s ahead at the
 * highest rendition the bandwidth estimate allows, whatever the element's size
 * — for a 300px card, and for every mounted card at once.
 */
const HLS_CONFIG = {
  // Never fetch a rendition wider than the element draws it.
  capLevelToPlayerSize: true,
  // A short forward buffer: players near the viewport each hold one, and they
  // share one connection with the video being watched.
  maxBufferLength: 10,
  maxMaxBufferLength: 30,
  // Let the bandwidth estimate pick the first rendition.
  startLevel: -1,
  // The owner starts downloads after publishing its visibility/preload demand.
  autoStartLoad: false,
} as const;

/**
 * Hand an element whose stream failed the same video as a progressive file.
 *
 * While hls.js is attached it, not expo-video, supplies the element's bytes, so
 * a fatal stream error never reaches expo-video's status — and with it the
 * fallback every other player failure takes. This is that fallback, on the same
 * element expo-video keeps driving: play/pause and the time updates carry on.
 * `resume` is whether the element was playing when the stream died.
 */
export function playProgressiveInstead(
  element: HTMLVideoElement,
  src: string,
  resume: boolean,
): void {
  element.src = src;
  if (!resume) return;
  void element.play().catch(() => {
    // Autoplay refused; the viewer's tap plays it like any video.
  });
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
  /**
   * The `ref` for the `VideoView` that paints this source. It fills `viewRef`
   * as an object ref would, and it is what attaches hls.js — so give it to that
   * view and to nothing else.
   */
  readonly ref: React.RefCallback<VideoViewHandle>;
}

/**
 * Attach hls.js to the actual video element, independently of Expo's ephemeral
 * imperative handle. The component rendering the view owns this hook and keeps
 * it mounted when Bloom moves the element between feed and reel.
 */
export function useHlsPlayback(
  src: string,
  viewRef: React.RefObject<VideoViewHandle | null>,
  player: VideoPlayer,
  /**
   * The same video as a progressive file, played when the stream fails. While
   * hls.js is attached it, not expo-video, supplies this element's bytes, so a
   * fatal stream error never reaches expo-video's status and its fallback; the
   * element is handed this file instead, which is all a fallback is.
   */
  fallbackSrc?: string,
): HlsPlayback {
  // The decision is a pure function of the source and the browser, so it is
  // resolved during render (not in an effect): the caller needs it on the FIRST
  // render to decide what source to hand `expo-video`, and a later flip would
  // mean the element had already begun a doomed native load.
  const active = needsJsHlsDecoder(src);
  const fallbackRef = useRef(fallbackSrc);
  useEffect(() => {
    fallbackRef.current = fallbackSrc;
  }, [fallbackSrc]);

  // Expo rebuilds its imperative handle on every render. Its transient ref
  // cleanup does not mean the HTML video element went away. Only element/source
  // changes or this hook's unmount may dispose the decoder.
  const [element, setElement] = useState<HTMLVideoElement | null>(null);
  const ref = useCallback(
    (handle: VideoViewHandle | null) => {
      viewRef.current = handle;
      if (!handle) return;
      const video: unknown = handle.nativeRef?.current;
      if (video instanceof HTMLVideoElement) setElement(video);
    },
    [viewRef],
  );

  useEffect(() => {
    if (!active || !element) return;
    let hls: HlsJs | null = null;
    let cancelled = false;
    let unsubscribeLoading: (() => void) | undefined;
    void loadHls()
      .then((Hls) => {
        if (cancelled) return;
        const created = new Hls(HLS_CONFIG);
        hls = created;
        created.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          logger.warn('Fatal HLS error, giving up on this source', {
            errorType: data.type,
            details: data.details,
          });
          const resume = !element.paused;
          unsubscribeLoading?.();
          created.destroy();
          if (hls === created) hls = null;
          const fallback = fallbackRef.current;
          if (fallback) playProgressiveInstead(element, fallback, resume);
        });
        created.attachMedia(element);
        unsubscribeLoading = subscribeVideoLoadingDemand(player, (loading) => {
          if (loading) {
            // Hidden media does not fetch its manifest. Resuming preserves buffer.
            if (created.url !== src) created.loadSource(src);
            created.startLoad(-1);
          } else {
            created.stopLoad();
          }
        });
      })
      .catch((error: unknown) => {
        logger.warn('Failed to load the HLS decoder', {
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
      unsubscribeLoading?.();
      hls?.destroy();
    };
  }, [active, src, element, player]);

  return { active, ref };
}
