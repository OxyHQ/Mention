import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'stream';

/**
 * The server-side oEmbed provider layer (`linkMetadataProviders`) sits in front
 * of the generic Open Graph scraper. These tests cover:
 *  - `matches()` host gating per provider (positive + negative),
 *  - YouTube video-id extraction across every canonical URL shape,
 *  - oEmbed JSON → `LinkMetadataResult` mapping (incl. Vimeo's description),
 *  - non-2xx / unparseable oEmbed → `resolve` returns null (generic fallback),
 *  - the orchestrator preferring a matching provider over the generic scrape,
 *  - off-response-path best-effort description enrichment.
 *
 * The SSRF-safe fetcher and the image cache are mocked so no network or S3 is
 * touched.
 */

const mocks = vi.hoisted(() => ({
  fetchUpstreamSingleHop: vi.fn(),
  getCachedImage: vi.fn(),
  cacheImage: vi.fn(),
}));

vi.mock('../../utils/safeUpstreamFetch', async () => {
  const actual = await vi.importActual<typeof import('../../utils/safeUpstreamFetch')>('../../utils/safeUpstreamFetch');
  return {
    ...actual,
    fetchUpstreamSingleHop: mocks.fetchUpstreamSingleHop,
  };
});

vi.mock('../../services/imageCacheService', () => ({
  imageCacheService: {
    getCachedImage: mocks.getCachedImage,
    cacheImage: mocks.cacheImage,
  },
}));

import { linkMetadataProviders, type LinkMetadataProvider } from '../../services/linkMetadataProviders';
import { linkMetadataService } from '../../services/linkMetadataService';

/** Look a provider up by id without a non-null assertion. */
function provider(id: string): LinkMetadataProvider {
  const found = linkMetadataProviders.find((p) => p.id === id);
  if (!found) throw new Error(`provider not registered: ${id}`);
  return found;
}

/** Build a single-use upstream JSON response. */
function jsonResponse(body: unknown, status = 200) {
  return {
    response: Readable.from([Buffer.from(JSON.stringify(body))]),
    status,
    headers: { 'content-type': 'application/json' },
  };
}

/** Build a single-use upstream HTML response. */
function htmlResponse(html: string, status = 200) {
  return {
    response: Readable.from([Buffer.from(html)]),
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  };
}

const VIDEO_ID = 'dQw4w9WgXcQ';
const CANONICAL_WATCH = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

const YT_OEMBED = {
  title: 'Rick Astley - Never Gonna Give You Up',
  author_name: 'Rick Astley',
  thumbnail_url: `https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg`,
};

const VIMEO_OEMBED = {
  title: 'A Short Film',
  description: 'A description straight from the Vimeo oEmbed payload.',
  thumbnail_url: 'https://i.vimeocdn.com/video/123456_640.jpg',
};

const SPOTIFY_OEMBED = {
  title: 'Some Great Track',
  thumbnail_url: 'https://i.scdn.co/image/ab67616d0000b273abcdef',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCachedImage.mockResolvedValue(null);
  mocks.cacheImage.mockResolvedValue(null);
});

describe('LinkMetadataProvider.matches', () => {
  it('youtube matches every youtube host', () => {
    const youtube = provider('youtube');
    for (const url of [
      'https://youtube.com/watch?v=x',
      'https://www.youtube.com/watch?v=x',
      'https://m.youtube.com/watch?v=x',
      'https://music.youtube.com/watch?v=x',
      'https://youtu.be/x',
    ]) {
      expect(youtube.matches(new URL(url))).toBe(true);
    }
  });

  it('youtube does not match unrelated or look-alike hosts', () => {
    const youtube = provider('youtube');
    for (const url of [
      'https://example.com/watch?v=x',
      'https://vimeo.com/123',
      'https://open.spotify.com/track/1',
      'https://notyoutube.com/watch?v=x',
      'https://youtube.com.evil.test/watch?v=x',
    ]) {
      expect(youtube.matches(new URL(url))).toBe(false);
    }
  });

  it('vimeo matches its hosts and nothing else', () => {
    const vimeo = provider('vimeo');
    expect(vimeo.matches(new URL('https://vimeo.com/123'))).toBe(true);
    expect(vimeo.matches(new URL('https://www.vimeo.com/123'))).toBe(true);
    expect(vimeo.matches(new URL('https://player.vimeo.com/video/123'))).toBe(true);
    expect(vimeo.matches(new URL('https://example.com/123'))).toBe(false);
    expect(vimeo.matches(new URL('https://youtu.be/x'))).toBe(false);
  });

  it('spotify matches open.spotify.com only', () => {
    const spotify = provider('spotify');
    expect(spotify.matches(new URL('https://open.spotify.com/track/1'))).toBe(true);
    expect(spotify.matches(new URL('https://spotify.com/track/1'))).toBe(false);
    expect(spotify.matches(new URL('https://www.spotify.com/track/1'))).toBe(false);
    expect(spotify.matches(new URL('https://example.com/track/1'))).toBe(false);
  });
});

describe('youtube video-id extraction', () => {
  beforeEach(() => {
    mocks.fetchUpstreamSingleHop.mockImplementation(async () => jsonResponse(YT_OEMBED));
  });

  const cases: Array<[label: string, url: string]> = [
    ['youtu.be short link', `https://youtu.be/${VIDEO_ID}`],
    ['youtu.be with ?si=', `https://youtu.be/${VIDEO_ID}?si=abc123&t=30`],
    ['watch?v=', `https://www.youtube.com/watch?v=${VIDEO_ID}`],
    ['watch?v= with extra params', `https://www.youtube.com/watch?v=${VIDEO_ID}&t=42s&list=PL1`],
    ['m.youtube watch', `https://m.youtube.com/watch?v=${VIDEO_ID}`],
    ['music.youtube watch', `https://music.youtube.com/watch?v=${VIDEO_ID}`],
    ['/shorts/', `https://www.youtube.com/shorts/${VIDEO_ID}`],
    ['/shorts/ with params', `https://www.youtube.com/shorts/${VIDEO_ID}?feature=share`],
    ['/embed/', `https://www.youtube.com/embed/${VIDEO_ID}`],
    ['/live/', `https://www.youtube.com/live/${VIDEO_ID}`],
  ];

  for (const [label, url] of cases) {
    it(`extracts the id and builds the canonical watch URL (${label})`, async () => {
      const result = await provider('youtube').resolve(new URL(url));
      expect(result?.url).toBe(CANONICAL_WATCH);
    });
  }

  it('returns null and makes NO oEmbed call for a non-video youtube URL', async () => {
    for (const url of [
      'https://www.youtube.com/feed/subscriptions',
      'https://www.youtube.com/@somechannel',
      'https://www.youtube.com/results?search_query=test',
      'https://youtu.be/',
    ]) {
      expect(await provider('youtube').resolve(new URL(url))).toBeNull();
    }
    expect(mocks.fetchUpstreamSingleHop).not.toHaveBeenCalled();
  });
});

describe('oEmbed → LinkMetadataResult mapping', () => {
  it('youtube maps title + thumbnail and has no description', async () => {
    mocks.fetchUpstreamSingleHop.mockImplementation(async () => jsonResponse(YT_OEMBED));

    const result = await provider('youtube').resolve(new URL(`https://youtu.be/${VIDEO_ID}`));

    expect(result).not.toBeNull();
    expect(result?.url).toBe(CANONICAL_WATCH);
    expect(result?.title).toBe(YT_OEMBED.title);
    expect(result?.image).toBe(YT_OEMBED.thumbnail_url);
    expect(result?.siteName).toBe('YouTube');
    expect(result?.description).toBeUndefined();
  });

  it('vimeo maps title + description + thumbnail', async () => {
    mocks.fetchUpstreamSingleHop.mockImplementation(async () => jsonResponse(VIMEO_OEMBED));

    const result = await provider('vimeo').resolve(new URL('https://vimeo.com/123456789'));

    expect(result?.url).toBe('https://vimeo.com/123456789');
    expect(result?.title).toBe(VIMEO_OEMBED.title);
    expect(result?.description).toBe(VIMEO_OEMBED.description);
    expect(result?.image).toBe(VIMEO_OEMBED.thumbnail_url);
    expect(result?.siteName).toBe('Vimeo');
  });

  it('spotify maps title + thumbnail and has no description', async () => {
    mocks.fetchUpstreamSingleHop.mockImplementation(async () => jsonResponse(SPOTIFY_OEMBED));

    const result = await provider('spotify').resolve(
      new URL('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'),
    );

    expect(result?.url).toBe('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
    expect(result?.title).toBe(SPOTIFY_OEMBED.title);
    expect(result?.image).toBe(SPOTIFY_OEMBED.thumbnail_url);
    expect(result?.siteName).toBe('Spotify');
    expect(result?.description).toBeUndefined();
  });

  it('builds the oEmbed endpoint with the canonical watch URL encoded', async () => {
    mocks.fetchUpstreamSingleHop.mockImplementation(async () => jsonResponse(YT_OEMBED));

    await provider('youtube').resolve(new URL(`https://youtu.be/${VIDEO_ID}?si=abc`));

    expect(mocks.fetchUpstreamSingleHop).toHaveBeenCalledTimes(1);
    const endpoint = String(mocks.fetchUpstreamSingleHop.mock.calls[0][0]);
    expect(endpoint.startsWith('https://www.youtube.com/oembed?')).toBe(true);
    expect(endpoint).toContain(encodeURIComponent(CANONICAL_WATCH));
    expect(endpoint).toContain('format=json');
  });
});

describe('oEmbed failure → null (generic fallback)', () => {
  it('returns null on a non-2xx oEmbed response', async () => {
    mocks.fetchUpstreamSingleHop.mockImplementation(async () => jsonResponse({}, 404));
    expect(await provider('youtube').resolve(new URL(`https://youtu.be/${VIDEO_ID}`))).toBeNull();
    expect(await provider('vimeo').resolve(new URL('https://vimeo.com/1'))).toBeNull();
    expect(await provider('spotify').resolve(new URL('https://open.spotify.com/track/1'))).toBeNull();
  });

  it('returns null when the oEmbed body is not valid JSON', async () => {
    mocks.fetchUpstreamSingleHop.mockImplementation(async () => htmlResponse('<html>not json</html>'));
    expect(await provider('youtube').resolve(new URL(`https://youtu.be/${VIDEO_ID}`))).toBeNull();
  });

  it('returns null when the oEmbed body is a JSON non-object', async () => {
    mocks.fetchUpstreamSingleHop.mockImplementation(async () => jsonResponse('a bare string'));
    expect(await provider('youtube').resolve(new URL(`https://youtu.be/${VIDEO_ID}`))).toBeNull();
  });
});

describe('orchestrator: provider chain in fetchMetadata', () => {
  it('prefers a matching provider over the generic scraper', async () => {
    // Only the oEmbed endpoint is consulted — no generic HTML scrape on the
    // default response path (awaitImageCache omitted → false).
    mocks.fetchUpstreamSingleHop.mockImplementation(async (reqUrl: string) => {
      if (reqUrl.includes('/oembed')) return jsonResponse(YT_OEMBED);
      throw new Error(`unexpected generic scrape of ${reqUrl}`);
    });

    const result = await linkMetadataService.fetchMetadata(`https://youtu.be/${VIDEO_ID}`);

    expect(result.url).toBe(CANONICAL_WATCH);
    expect(result.title).toBe(YT_OEMBED.title);
    expect(result.siteName).toBe('YouTube');
    // Raw thumbnail flows through (image cache miss, fire-and-forget downscale).
    expect(result.image).toBe(YT_OEMBED.thumbnail_url);

    // Exactly one upstream call, and it is the oEmbed endpoint (not a page scrape).
    expect(mocks.fetchUpstreamSingleHop).toHaveBeenCalledTimes(1);
    expect(String(mocks.fetchUpstreamSingleHop.mock.calls[0][0])).toContain('/oembed');
    // Provider thumbnails are NOT bypassed — they still go through the image cache.
    expect(mocks.getCachedImage).toHaveBeenCalledWith(YT_OEMBED.thumbnail_url);
  });

  it('falls through to the generic scraper when the provider yields null', async () => {
    const GENERIC_HTML =
      '<!DOCTYPE html><html><head>' +
      '<meta property="og:title" content="Generic Title">' +
      '<meta property="og:description" content="Generic description">' +
      '</head><body>page</body></html>';

    // oEmbed 404 → provider null → generic scrape of the watch page succeeds.
    mocks.fetchUpstreamSingleHop.mockImplementation(async (reqUrl: string) => {
      if (reqUrl.includes('/oembed')) return jsonResponse({}, 404);
      return htmlResponse(GENERIC_HTML);
    });

    const result = await linkMetadataService.fetchMetadata(`https://youtu.be/${VIDEO_ID}`);

    expect(result.title).toBe('Generic Title');
    expect(result.description).toBe('Generic description');
    // oEmbed preflight + generic scrape.
    expect(mocks.fetchUpstreamSingleHop).toHaveBeenCalledTimes(2);
  });

  it('enriches a provider description best-effort ONLY off the response path', async () => {
    const WATCH_OG_HTML =
      '<!DOCTYPE html><html><head>' +
      '<meta property="og:description" content="Enriched from OG scrape">' +
      '</head><body>video</body></html>';

    mocks.fetchUpstreamSingleHop.mockImplementation(async (reqUrl: string) => {
      if (reqUrl.includes('/oembed')) return jsonResponse(YT_OEMBED);
      return htmlResponse(WATCH_OG_HTML);
    });

    // Off the response path (warm/backfill): description is filled from OG.
    const warm = await linkMetadataService.fetchMetadata(`https://youtu.be/${VIDEO_ID}`, {
      awaitImageCache: true,
    });
    expect(warm.title).toBe(YT_OEMBED.title);
    expect(warm.description).toBe('Enriched from OG scrape');
    // oEmbed + the enrichment scrape.
    expect(mocks.fetchUpstreamSingleHop).toHaveBeenCalledTimes(2);

    vi.clearAllMocks();
    mocks.getCachedImage.mockResolvedValue(null);
    mocks.cacheImage.mockResolvedValue(null);
    mocks.fetchUpstreamSingleHop.mockImplementation(async (reqUrl: string) => {
      if (reqUrl.includes('/oembed')) return jsonResponse(YT_OEMBED);
      throw new Error(`unexpected generic scrape of ${reqUrl}`);
    });

    // On the response path: NO enrichment scrape, description stays undefined.
    const fast = await linkMetadataService.fetchMetadata(`https://youtu.be/${VIDEO_ID}`);
    expect(fast.description).toBeUndefined();
    expect(mocks.fetchUpstreamSingleHop).toHaveBeenCalledTimes(1);
  });

  it('does not fail the provider result when description enrichment throws', async () => {
    // oEmbed succeeds; the enrichment scrape 302s into the /sorry wall (rejected).
    mocks.fetchUpstreamSingleHop.mockImplementation(async (reqUrl: string) => {
      if (reqUrl.includes('/oembed')) return jsonResponse(YT_OEMBED);
      return {
        response: Readable.from([Buffer.from('')]),
        status: 302,
        headers: { location: 'https://www.google.com/sorry/index?continue=x' },
      };
    });

    const result = await linkMetadataService.fetchMetadata(`https://youtu.be/${VIDEO_ID}`, {
      awaitImageCache: true,
    });

    // The provider result survives intact; description is simply absent.
    expect(result.title).toBe(YT_OEMBED.title);
    expect(result.image).toBe(YT_OEMBED.thumbnail_url);
    expect(result.description).toBeUndefined();
  });
});
