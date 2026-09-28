import type { VideoSource } from 'expo-video';

/**
 * The query the media pipeline resolves an adaptive stream under.
 *
 * `mediaResolver` builds `hlsUrl` as `getFileDownloadUrl(id, 'hls_master')`, so
 * the manifest arrives as `…/<id>?variant=hls_master` — a URL whose PATH carries
 * no file extension at all.
 */
const HLS_VARIANT_QUERY = 'variant=hls_master';

/** The extension a manifest carries when it has one (atproto, and any remote host). */
const HLS_EXTENSION = '.m3u8';

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
 * A STRING IS RETURNED UNCHANGED for everything else, deliberately. `contentType`
 * defaults to `'auto'`, and forcing a type onto a progressive MP4 would trade
 * this bug for its mirror image.
 */
export function videoSourceFor(url: string): VideoSource {
  if (!url) return url;
  if (!(url.includes(HLS_VARIANT_QUERY) || url.includes(HLS_EXTENSION))) return url;
  // One object per url. `useVideoPlayer` rebuilds its player whenever the
  // source it is handed changes identity, so a fresh object per render would
  // tear the decoder down on every commit; this keeps callers from each having
  // to memoise it (and every video row from paying a hook for that).
  let source = hlsSourceCache.get(url);
  if (!source) {
    source = { uri: url, contentType: 'hls' };
    hlsSourceCache.set(url, source);
    if (hlsSourceCache.size > HLS_SOURCE_CACHE_LIMIT) {
      const oldest = hlsSourceCache.keys().next().value;
      if (oldest !== undefined) hlsSourceCache.delete(oldest);
    }
  }
  return source;
}

/** Bounds the identity cache; an evicted url just gets a new object once. */
const HLS_SOURCE_CACHE_LIMIT = 200;
const hlsSourceCache = new Map<string, VideoSource>();
