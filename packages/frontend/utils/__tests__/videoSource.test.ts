import { videoSourceFor } from '../videoSource';

/**
 * A PLAYLIST HANDED TO AN MP4 READER IS NOT A BROKEN VIDEO — IT IS A SLOW ONE.
 *
 * ExoPlayer chooses its media source from the URL's path. Our adaptive streams
 * arrive as `…/<id>?variant=hls_master`, whose path is a bare id with no
 * extension, so it picked "progressive file" and sent a manifest to the MP4 and
 * Matroska extractors. Measured on a Pixel 10 Pro:
 *
 *   UnrecognizedInputFormatException: None of the available extractors
 *   (FlvExtractor, …, Mp4Extractor, TsExtractor, …) could read the stream
 *   {contentIsMalformed=false}   sniff failures: [NoDeclaredBrand]
 *
 * The reel then recovered onto the progressive MP4, which is why this never
 * looked like a bug: it looked like videos that take a whole failed load before
 * they start, on every player build, and like "Video unavailable" whenever the
 * fallback failed too.
 *
 * The cases below are the URL SHAPES the app actually produces, not invented
 * ones — an Oxy variant URL, an atproto `.m3u8`, an Oxy progressive MP4, a
 * proxied federated file — because the defect was that a real shape fell through
 * a rule written for a different one.
 */

describe('the source a video URL becomes', () => {
  it('declares HLS for an Oxy manifest, whose path has no extension at all', () => {
    // The shape `mediaResolver` builds: getFileDownloadUrl(id, 'hls_master').
    expect(videoSourceFor('https://cloud.oxy.so/68f2?variant=hls_master')).toEqual({
      uri: 'https://cloud.oxy.so/68f2?variant=hls_master',
      contentType: 'hls',
    });
  });

  it('declares HLS for a manifest that does carry the extension', () => {
    // atproto serves real `.m3u8` URLs; ExoPlayer would infer these correctly on
    // its own, and saying so explicitly costs nothing and keeps one rule.
    expect(videoSourceFor('https://video.bsky.app/x/playlist.m3u8')).toEqual({
      uri: 'https://video.bsky.app/x/playlist.m3u8',
      contentType: 'hls',
    });
  });

  it('leaves a progressive file alone rather than mislabelling it', () => {
    // The mirror-image bug: forcing a type onto an MP4 would break the very
    // fallback that has been masking this one.
    for (const url of [
      'https://cloud.oxy.so/68f2?variant=full',
      'https://cloud.oxy.so/variants/2026/07/e6/abc/full.mp4',
      'https://api.mention.earth/api/media/proxy?url=https%3A%2F%2Fhost%2Fclip.mp4',
    ]) {
      expect(videoSourceFor(url)).toBe(url);
    }
  });

  it('does not mistake a proxied HLS manifest for a progressive file', () => {
    // Federated HLS reaches the app through the media proxy, where the manifest
    // URL is a query parameter — the extension is present but nested.
    const proxied =
      'https://api.mention.earth/api/media/proxy?url=https%3A%2F%2Fhost%2Fmaster.m3u8';
    expect(videoSourceFor(proxied)).toEqual({ uri: proxied, contentType: 'hls' });
  });

  it('passes an empty URL straight through', () => {
    // `resolveVideoUrl` can return '' and the caller drops the post; the source
    // builder must not turn that into an object that looks playable.
    expect(videoSourceFor('')).toBe('');
  });
});
