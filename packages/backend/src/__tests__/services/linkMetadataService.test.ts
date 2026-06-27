import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'stream';

/**
 * Verifies the `awaitImageCache` option on `linkMetadataService.fetchMetadata`.
 *
 * The og:image parsed from the page HTML is full-res. On a cache MISS:
 *  - default (no option / response path): `result.image` is the RAW absolute
 *    image url and the downscale runs fire-and-forget (cacheImage still invoked).
 *  - `{ awaitImageCache: true }` (off-response-path): `result.image` is the
 *    AWAITED downscaled CDN url returned by `cacheImage`.
 *
 * The upstream HTML fetch (`fetchUpstreamSingleHop`, the SSRF-safe fetcher the
 * service now parses metadata from directly) and `imageCacheService` are mocked
 * so no real network or S3 is touched. `getCachedImage` returns null to force
 * the MISS branch.
 */

const OG_IMAGE = 'https://example.com/og-image-1200.png';
const PAGE_URL = 'https://example.com/article';
const DOWNSCALED_CDN_URL = 'https://cdn.mention.earth/link-previews/abc123.webp';

const PAGE_HTML = [
  '<!DOCTYPE html><html><head>',
  '<title>Example Article</title>',
  '<meta property="og:description" content="A description">',
  `<meta property="og:image" content="${OG_IMAGE}">`,
  '<meta property="og:site_name" content="Example">',
  '</head><body>page</body></html>',
].join('\n');

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

import { linkMetadataService } from '../../services/linkMetadataService';

beforeEach(() => {
  vi.clearAllMocks();
  // A fresh single-use HTML stream per call (a Readable can only be drained once).
  mocks.fetchUpstreamSingleHop.mockImplementation(async () => ({
    response: Readable.from([Buffer.from(PAGE_HTML)]),
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  }));
  // Force the cache-MISS branch in every test.
  mocks.getCachedImage.mockResolvedValue(null);
  mocks.cacheImage.mockResolvedValue(DOWNSCALED_CDN_URL);
});

describe('linkMetadataService.fetchMetadata image resolution', () => {
  it('awaitImageCache: true returns the downscaled CDN image on a cache miss', async () => {
    const result = await linkMetadataService.fetchMetadata(PAGE_URL, { awaitImageCache: true });

    expect(mocks.cacheImage).toHaveBeenCalledTimes(1);
    expect(mocks.cacheImage).toHaveBeenCalledWith(OG_IMAGE);
    // The persisted image is the optimized CDN url, NOT the raw og:image.
    expect(result.image).toBe(DOWNSCALED_CDN_URL);
  });

  it('default (no option) returns the raw og:image and downscales fire-and-forget', async () => {
    const result = await linkMetadataService.fetchMetadata(PAGE_URL);

    // Response-path callers get the raw url immediately...
    expect(result.image).toBe(OG_IMAGE);
    // ...but caching is still kicked off in the background.
    expect(mocks.cacheImage).toHaveBeenCalledTimes(1);
    expect(mocks.cacheImage).toHaveBeenCalledWith(OG_IMAGE);
  });

  it('awaitImageCache: true falls back to the raw url when caching returns null', async () => {
    mocks.cacheImage.mockResolvedValue(null);

    const result = await linkMetadataService.fetchMetadata(PAGE_URL, { awaitImageCache: true });

    expect(mocks.cacheImage).toHaveBeenCalledTimes(1);
    // Caching failed → fall back to the raw absolute url (still renderable).
    expect(result.image).toBe(OG_IMAGE);
  });

  it('uses the already-cached CDN image and never downloads (awaitImageCache irrelevant)', async () => {
    mocks.getCachedImage.mockResolvedValue(DOWNSCALED_CDN_URL);

    const result = await linkMetadataService.fetchMetadata(PAGE_URL, { awaitImageCache: true });

    expect(result.image).toBe(DOWNSCALED_CDN_URL);
    // Already cached → no (re)caching work.
    expect(mocks.cacheImage).not.toHaveBeenCalled();
  });
});
