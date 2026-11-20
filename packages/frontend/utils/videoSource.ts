import { Platform } from 'react-native';
import type { BufferOptions, VideoSource } from 'expo-video';
import { isHlsSource } from '@/utils/hlsSource';

/**
 * How far ahead of the playhead every player the app builds may buffer.
 *
 * Unset, an Android player buffers FIFTY seconds ahead (Media3's
 * `DefaultLoadControl` defaults, which expo-video keeps until `bufferOptions` is
 * assigned; its docs say 20), and it does so whether or not it is playing: a
 * feed row preloading behind the one being watched downloaded up to fifty
 * seconds of a video nobody may ever start. Media3's own short-form sample
 * buffers 5-20 s, and its preloading examples keep 1-5 s of the neighbours.
 *
 * Ten seconds is lead time enough for a 2 s HLS ladder to switch rungs without a
 * stall, and caps what a preloaded row costs at ten seconds of its rung.
 * `minBufferForPlayback` is Media3's start threshold (1 s); expo-video applies
 * it after a rebuffer as well, where Media3 waits 2 s.
 */
export const VIDEO_BUFFER_OPTIONS: BufferOptions = {
  preferredForwardBufferDuration: 10,
  minBufferForPlayback: 1,
};

/**
 * How far ahead a reel slide that is preloading, not being watched, may buffer:
 * a short slice of the start, which is all a swipe needs to land on a playing
 * video. Media3's preloading examples keep 3-5 s of the next item, and Meta's
 * rule is that preloading must never take the bandwidth of the video being
 * watched; a 3 s slice of the top rung is about 750 KB. The slide gets
 * {@link VIDEO_BUFFER_OPTIONS} back the moment it is watched.
 */
export const VIDEO_PRELOAD_BUFFER_OPTIONS: BufferOptions = {
  preferredForwardBufferDuration: 3,
  minBufferForPlayback: 1,
};

/**
 * Disk-cache video bytes on Android, so a looping feed video, a scroll back
 * and the same clip opened in the reel read what was already downloaded
 * instead of fetching it again (expo-video's LRU cache, HLS included). Not on
 * iOS, which cannot cache HLS, and not on the web, where the browser caches.
 */
const CACHE_VIDEO = Platform.OS === 'android';

/**
 * A playable source for a video URL, declaring HLS when the URL cannot.
 *
 * WHY THIS EXISTS, measured rather than reasoned. ExoPlayer picks its media
 * source from the URL's path: no recognised extension means "progressive file",
 * which sends the bytes to the MP4/Matroska/WebM extractors. Our manifests are
 * `?variant=hls_master` with a bare id for a path, so every HLS-backed video in
 * the reel failed its FIRST load on a Pixel 10 Pro:
 *
 *   UnrecognizedInputFormatException: None of the available extractors
 *   (FlvExtractor, …, Mp4Extractor, TsExtractor, …) could read the stream
 *   {contentIsMalformed=false}   sniff failures: [NoDeclaredBrand]
 *
 * `contentIsMalformed=false` is the tell: the bytes downloaded fine and are a
 * perfectly good playlist — nothing in that extractor list reads playlists,
 * because HLS is not an extractor. The playback then recovered by falling back
 * to the progressive MP4, so the defect never surfaced as a broken video; it
 * surfaced as one that took a whole failed load before starting, on every player
 * build — and as "Video unavailable" whenever the fallback failed too.
 *
 * expo-video documents `contentType` for exactly this: "use this property when
 * playing HLS … from an uri which does not contain a standardized extension for
 * the corresponding media type."
 *
 * `contentType` is declared for HLS only, deliberately. It defaults to `'auto'`,
 * and forcing a type onto a progressive MP4 would trade this bug for its mirror
 * image. Every source also asks for the disk cache where it works
 * ({@link CACHE_VIDEO}); with neither to say, the url string is returned as is.
 */
export function videoSourceFor(url: string): VideoSource {
  if (!url) return url;
  const hls = isHlsSource(url);
  if (!hls && !CACHE_VIDEO) return url;
  // One object per url. `useVideoPlayer` rebuilds its player whenever the
  // source it is handed changes identity, so a fresh object per render would
  // tear the decoder down on every commit; this keeps callers from each having
  // to memoise it (and every video row from paying a hook for that).
  let source = sourceCache.get(url);
  if (!source) {
    source = {
      uri: url,
      ...(hls ? { contentType: 'hls' as const } : {}),
      ...(CACHE_VIDEO ? { useCaching: true } : {}),
    };
    sourceCache.set(url, source);
    if (sourceCache.size > SOURCE_CACHE_LIMIT) {
      // Insertion order: the first key is the oldest, and the map is non-empty.
      sourceCache.delete(sourceCache.keys().next().value as string);
    }
  }
  return source;
}

/** Bounds the identity cache; an evicted url just gets a new object once. */
const SOURCE_CACHE_LIMIT = 200;
const sourceCache = new Map<string, VideoSource>();
