import { isHlsSource } from '../hlsSource';

/**
 * `isHlsSource` decides which decoder a video source gets on web, so the case
 * that matters most is the PROXIED one: by the time a player sees a federated
 * playlist it has been wrapped by `proxyExternalUrl`, and the `.m3u8` is in the
 * query string rather than the path. Missing that is exactly the shape of bug
 * where every federated video silently keeps failing.
 */
describe('isHlsSource', () => {
  const BSKY_PLAYLIST =
    'https://video.bsky.app/watch/did%3Aplc%3Aabc/bafkrei123/playlist.m3u8';

  it('recognises a bare playlist url', () => {
    expect(isHlsSource(BSKY_PLAYLIST)).toBe(true);
    expect(isHlsSource('https://cdn.example/720p/video.M3U8')).toBe(true);
  });

  it('recognises a playlist wrapped by the media proxy — the shape the app renders', () => {
    const proxied = `https://api.mention.earth/media/proxy?url=${encodeURIComponent(BSKY_PLAYLIST)}`;
    expect(isHlsSource(proxied)).toBe(true);
  });

  it('recognises a proxied playlist carrying the component signature', () => {
    const proxied = `https://api.mention.earth/media/proxy?url=${encodeURIComponent(BSKY_PLAYLIST)}&hls=abc123`;
    expect(isHlsSource(proxied)).toBe(true);
  });

  it('does not claim a progressive video file', () => {
    expect(isHlsSource('https://cdn.example/clip.mp4')).toBe(false);
    const proxiedMp4 = `https://api.mention.earth/media/proxy?url=${encodeURIComponent('https://files.mastodon.social/media/original/clip.mp4')}`;
    expect(isHlsSource(proxiedMp4)).toBe(false);
  });

  it('does not claim an Oxy file id, which is not a url at all', () => {
    expect(isHlsSource('6a390d4b9d8fecf98a320181')).toBe(false);
  });

  it('is false for an absent source rather than throwing in a render path', () => {
    expect(isHlsSource(undefined)).toBe(false);
    expect(isHlsSource(null)).toBe(false);
    expect(isHlsSource('')).toBe(false);
  });

  it('is not fooled by a playlist named in some other query parameter', () => {
    // Only the proxy's own `url` parameter names an upstream we will fetch.
    expect(isHlsSource('https://api.mention.earth/media/proxy?poster=a/playlist.m3u8&url=https%3A%2F%2Fcdn.example%2Fclip.mp4')).toBe(false);
  });
});
