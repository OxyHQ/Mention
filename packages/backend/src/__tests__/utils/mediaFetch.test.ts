import { describe, expect, it } from 'vitest';
import type { SsrfCheckOk } from '@oxy.so/core/server';
import {
  MEDIA_FETCH_MAX_REDIRECTS,
  PROXY_USER_AGENT,
  mediaFetchOptions,
} from '../../utils/mediaFetch';

/**
 * What every remote media fetch asks `safeFetch` for. The transport's SSRF
 * contract (per-hop validation, pinned connections, `validated` reuse) is the
 * SDK's and is tested there; this pins Mention's request on top of it.
 */
describe('mediaFetchOptions', () => {
  const signal = new AbortController().signal;

  it('asks for raw media bytes as Mention, with at most three redirects', () => {
    const options = mediaFetchOptions(signal);

    expect(options.headers).toEqual({
      'User-Agent': PROXY_USER_AGENT,
      Accept: 'image/*,video/*,audio/*,*/*;q=0.8',
      // Byte caps measure wire bytes and ffmpeg gets the raw container.
      'Accept-Encoding': 'identity',
    });
    expect(options.maxRedirects).toBe(3);
    expect(MEDIA_FETCH_MAX_REDIRECTS).toBe(3);
    expect(options.signal).toBe(signal);
    expect(options).not.toHaveProperty('validated');
    // Redirects are followed (each re-validated by `safeFetch`), never manual.
    expect(options).not.toHaveProperty('redirect');
  });

  it('forwards only the range and validators the client sent', () => {
    expect(
      mediaFetchOptions(signal, {
        range: 'bytes=0-3',
        ifNoneMatch: '"etag"',
        ifModifiedSince: 'Wed, 21 Oct 2015 07:28:00 GMT',
      }).headers,
    ).toMatchObject({
      Range: 'bytes=0-3',
      'If-None-Match': '"etag"',
      'If-Modified-Since': 'Wed, 21 Oct 2015 07:28:00 GMT',
    });

    const headers = mediaFetchOptions(signal, { range: 'bytes=5-' }).headers ?? {};
    expect(headers.Range).toBe('bytes=5-');
    expect(headers).not.toHaveProperty('If-None-Match');
    expect(headers).not.toHaveProperty('If-Modified-Since');
  });

  it("hands the caller's own check of the URL to the first hop", () => {
    const check = { ok: true, ip: '203.0.113.10', family: 4 } as SsrfCheckOk;

    expect(mediaFetchOptions(signal, {}, check).validated).toBe(check);
  });
});
