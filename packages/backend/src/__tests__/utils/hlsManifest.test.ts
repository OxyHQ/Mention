import { describe, it, expect } from 'vitest';
import { isHlsManifestBody, rewriteHlsManifest } from '../../utils/hlsManifest';

/**
 * The manifest rewriter is the piece that makes federated HLS video playable
 * through `/media/proxy`: without it a client resolves a playlist's relative
 * URIs against OUR proxy url and fetches nothing that exists.
 *
 * These assertions are about the property that matters — every URI a player
 * would follow comes back through the proxy, and nothing else in the document
 * changes — rather than about exact output strings.
 */

const PROXY_PATH = '/media/proxy';

/** Stand-in for the route's builder, minus the provenance signature. */
const buildProxyUrl = (absoluteUrl: string): string => `${PROXY_PATH}?url=${encodeURIComponent(absoluteUrl)}`;
const MANIFEST_URL = 'https://video.example/watch/did%3Aplc%3Aabc/cid/playlist.m3u8';

/** Every proxied url a rewritten playlist points at, in document order. */
function proxiedTargets(manifest: string): string[] {
  const targets: string[] = [];
  const pattern = new RegExp(`${PROXY_PATH}\\?url=([^"\\s,]+)`, 'g');
  for (const match of manifest.matchAll(pattern)) {
    targets.push(decodeURIComponent(match[1] ?? ''));
  }
  return targets;
}

describe('isHlsManifestBody', () => {
  it('accepts a playlist', () => {
    expect(isHlsManifestBody('#EXTM3U\n#EXT-X-VERSION:3\n')).toBe(true);
  });

  it('accepts a playlist behind a byte-order mark', () => {
    expect(isHlsManifestBody('﻿#EXTM3U\n')).toBe(true);
  });

  it('rejects a body that is not a playlist', () => {
    expect(isHlsManifestBody('<!doctype html><html>nope</html>')).toBe(false);
    expect(isHlsManifestBody('')).toBe(false);
  });
});

describe('rewriteHlsManifest — media playlist', () => {
  const MEDIA_PLAYLIST = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-TARGETDURATION:6',
    '#EXTINF:6.000,',
    'video0.ts?session_id=abc&dur=6.000000',
    '#EXTINF:0.833,',
    'video1.ts?session_id=abc&dur=0.833333',
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');

  it('routes every segment back through the proxy, resolved against the playlist url', () => {
    const out = rewriteHlsManifest(MEDIA_PLAYLIST, MANIFEST_URL, buildProxyUrl);

    expect(proxiedTargets(out)).toEqual([
      'https://video.example/watch/did%3Aplc%3Aabc/cid/video0.ts?session_id=abc&dur=6.000000',
      'https://video.example/watch/did%3Aplc%3Aabc/cid/video1.ts?session_id=abc&dur=0.833333',
    ]);
  });

  it('leaves no bare segment reference behind for the client to fetch directly', () => {
    const out = rewriteHlsManifest(MEDIA_PLAYLIST, MANIFEST_URL, buildProxyUrl);

    const uriLines = out
      .split('\n')
      .filter((line) => line.trim().length > 0 && !line.startsWith('#'));
    expect(uriLines).not.toHaveLength(0);
    for (const line of uriLines) {
      expect(line.startsWith(`${PROXY_PATH}?url=`)).toBe(true);
    }
  });

  it('preserves tags, ordering and structure verbatim', () => {
    const out = rewriteHlsManifest(MEDIA_PLAYLIST, MANIFEST_URL, buildProxyUrl);

    const tags = out.split('\n').filter((line) => line.startsWith('#'));
    expect(tags).toEqual([
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-TARGETDURATION:6',
      '#EXTINF:6.000,',
      '#EXTINF:0.833,',
      '#EXT-X-ENDLIST',
    ]);
    expect(out.split('\n')).toHaveLength(MEDIA_PLAYLIST.split('\n').length);
  });

  it('rewrites an absolute segment url too (it would otherwise bypass the proxy)', () => {
    const playlist = ['#EXTM3U', '#EXTINF:6.000,', 'https://cdn.example/other/video0.ts', ''].join('\n');

    expect(proxiedTargets(rewriteHlsManifest(playlist, MANIFEST_URL, buildProxyUrl))).toEqual([
      'https://cdn.example/other/video0.ts',
    ]);
  });

  it('preserves CRLF line endings without sweeping the CR into a URI', () => {
    const playlist = '#EXTM3U\r\n#EXTINF:6.000,\r\nvideo0.ts\r\n';
    const out = rewriteHlsManifest(playlist, MANIFEST_URL, buildProxyUrl);

    expect(proxiedTargets(out)).toEqual(['https://video.example/watch/did%3Aplc%3Aabc/cid/video0.ts']);
    expect(out.includes('%0D')).toBe(false);
    expect(out.split('\n').every((line) => line.length === 0 || line.endsWith('\r'))).toBe(true);
  });
});

describe('rewriteHlsManifest — master playlist with nested variants', () => {
  const MASTER_PLAYLIST = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-STREAM-INF:PROGRAM-ID=0,BANDWIDTH=987125,CODECS="avc1.4d401e,mp4a.40.2",RESOLUTION=360x640',
    '360p/video.m3u8?session_id=abc',
    '#EXT-X-STREAM-INF:PROGRAM-ID=0,BANDWIDTH=1802794,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=720x1280',
    '720p/video.m3u8?session_id=abc',
    '',
  ].join('\n');

  it('rewrites the nested variant playlists, not just segments', () => {
    const out = rewriteHlsManifest(MASTER_PLAYLIST, MANIFEST_URL, buildProxyUrl);

    expect(proxiedTargets(out)).toEqual([
      'https://video.example/watch/did%3Aplc%3Aabc/cid/360p/video.m3u8?session_id=abc',
      'https://video.example/watch/did%3Aplc%3Aabc/cid/720p/video.m3u8?session_id=abc',
    ]);
  });

  it('leaves attributes it does not rewrite exactly as they were', () => {
    const out = rewriteHlsManifest(MASTER_PLAYLIST, MANIFEST_URL, buildProxyUrl);

    expect(out).toContain('CODECS="avc1.4d401e,mp4a.40.2"');
    expect(out).toContain('CODECS="avc1.4d401f,mp4a.40.2"');
    expect(out).toContain('RESOLUTION=360x640');
  });

  it('still rewrites a URI whose own value contains a comma', () => {
    // The comma-aware attribute split earns its keep here: a naive split on `,`
    // cuts `URI="a,b.ts"` into two fragments, neither of which parses as a
    // quoted-string, so the URI would silently survive un-rewritten and the
    // client would fetch it straight from the remote CDN.
    const playlist = ['#EXTM3U', '#EXT-X-MAP:URI="init,part.mp4",BYTERANGE="1@0"', ''].join('\n');

    const out = rewriteHlsManifest(playlist, MANIFEST_URL, buildProxyUrl);
    expect(proxiedTargets(out)).toEqual(['https://video.example/watch/did%3Aplc%3Aabc/cid/init,part.mp4']);
    expect(out).toContain('BYTERANGE="1@0"');
  });

  it('rewrites the URI attribute of EXT-X-MEDIA and EXT-X-I-FRAME-STREAM-INF', () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",URI="audio/en.m3u8"',
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="iframe/video.m3u8"',
      '',
    ].join('\n');

    expect(proxiedTargets(rewriteHlsManifest(playlist, MANIFEST_URL, buildProxyUrl))).toEqual([
      'https://video.example/watch/did%3Aplc%3Aabc/cid/audio/en.m3u8',
      'https://video.example/watch/did%3Aplc%3Aabc/cid/iframe/video.m3u8',
    ]);
  });

  it('rewrites the URI attribute of EXT-X-KEY and EXT-X-MAP', () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/key.bin",IV=0x0f',
      '#EXT-X-MAP:URI="init.mp4"',
      '',
    ].join('\n');

    const out = rewriteHlsManifest(playlist, MANIFEST_URL, buildProxyUrl);
    expect(proxiedTargets(out)).toEqual([
      'https://keys.example/key.bin',
      'https://video.example/watch/did%3Aplc%3Aabc/cid/init.mp4',
    ]);
    expect(out).toContain('METHOD=AES-128');
    expect(out).toContain('IV=0x0f');
  });
});

describe('rewriteHlsManifest — things it must leave alone', () => {
  it('does not touch a client attribute whose name merely ends in URI', () => {
    const playlist = ['#EXTM3U', '#EXT-X-DATERANGE:ID="ad",X-COM-EXAMPLE-URI="https://ads.example/a"', ''].join('\n');

    const out = rewriteHlsManifest(playlist, MANIFEST_URL, buildProxyUrl);
    expect(out).toContain('X-COM-EXAMPLE-URI="https://ads.example/a"');
    expect(proxiedTargets(out)).toEqual([]);
  });

  it('does not proxy a non-http scheme such as a data: key', () => {
    const playlist = ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA"', ''].join('\n');

    const out = rewriteHlsManifest(playlist, MANIFEST_URL, buildProxyUrl);
    expect(out).toContain('URI="data:text/plain;base64,AAAA"');
    expect(proxiedTargets(out)).toEqual([]);
  });

  it('leaves plain comment lines untouched', () => {
    const playlist = ['#EXTM3U', '# just a comment, not a tag', '#EXTINF:6.0,', 'a.ts', ''].join('\n');

    expect(rewriteHlsManifest(playlist, MANIFEST_URL, buildProxyUrl)).toContain('# just a comment, not a tag');
  });

  it('emits urls that keep the quoted-string and attribute list well formed', () => {
    // `encodeURIComponent` escapes both `"` and `,`, so a rewritten value can
    // never terminate its own quoted string or split its own attribute list.
    const playlist = ['#EXTM3U', '#EXT-X-MAP:URI="init.mp4?a=1,2&q=%22x%22",BYTERANGE="1@0"', ''].join('\n');

    const out = rewriteHlsManifest(playlist, MANIFEST_URL, buildProxyUrl);
    const attributes = out.split('\n')[1]?.slice('#EXT-X-MAP:'.length) ?? '';
    expect(attributes.split(',')).toHaveLength(2);
    expect(out).toContain('BYTERANGE="1@0"');
  });
});
