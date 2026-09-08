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
  return url.includes(HLS_VARIANT_QUERY) || url.includes(HLS_EXTENSION)
    ? { uri: url, contentType: 'hls' }
    : url;
}
