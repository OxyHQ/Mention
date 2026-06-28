import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'stream';

/**
 * Regression: an anti-bot / consent / login interstitial must NEVER yield a
 * positive (usable) link preview.
 *
 * A backfill that fired ~7 req/s from a single datacenter IP tripped Google's
 * `/sorry` anti-bot wall: rate-limited YouTube/`youtu.be` links 302'd to
 * `https://www.google.com/sorry/index?continue=...`. The fetcher FOLLOWED that
 * redirect, parsed the wall page (whose `<title>` is the original URL), and the
 * warm path cached it as a POSITIVE preview for 24h.
 *
 * The fix rejects such redirects/pages in `fetchMetadataDocument` (transient
 * throw → hostname fallback, not parsed junk) and the shared `isUsablePreview`
 * predicate refuses to store a hollow result as positive.
 *
 * NOTE: `youtu.be`/`youtube.com` URLs now hit the oEmbed provider chain FIRST
 * (see `linkMetadataProviders`). When that mocked endpoint also 302s (as here),
 * the provider returns null and the generic scrape runs as the fallback — so the
 * interstitial protection on the generic path is still exercised. The invariant
 * is that the `/sorry` (or consent) wall is NEVER fetched or parsed, regardless
 * of how many preflight calls precede it.
 *
 * The upstream fetch and image cache are mocked so no network or S3 is touched.
 */

const YOUTU_BE_URL = 'https://youtu.be/mYDSSRS-B5U';
const GOOGLE_SORRY_URL =
  'https://www.google.com/sorry/index?continue=https://www.youtube.com/watch%3Fv%3DmYDSSRS-B5U&hl=en';
const CONSENT_URL = 'https://consent.youtube.com/m?continue=https://www.youtube.com/watch?v=x';

// The wall page Google would serve — its <title> is the original request URL,
// which is exactly the junk that previously got cached as a positive preview.
const WALL_HTML =
  '<!DOCTYPE html><html><head><title>https://www.youtube.com/watch?v=mYDSSRS-B5U&feature=youtu.be</title>' +
  '<meta property="og:site_name" content="google.com"></head><body>sorry</body></html>';

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
import { isUsablePreview } from '../../services/linkPreviewCache';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCachedImage.mockResolvedValue(null);
  mocks.cacheImage.mockResolvedValue(null);
});

describe('linkMetadataService interstitial rejection', () => {
  it('does NOT follow a redirect into the Google /sorry anti-bot wall', async () => {
    // First (and only) upstream call: 302 → google.com/sorry. If the code were
    // to follow it, a SECOND call would be made for the wall page.
    mocks.fetchUpstreamSingleHop.mockImplementation(async () => ({
      response: Readable.from([Buffer.from('')]),
      status: 302,
      headers: { location: GOOGLE_SORRY_URL },
    }));

    const result = await linkMetadataService.fetchMetadata(YOUTU_BE_URL);

    // The wall was rejected before being fetched/parsed: the /sorry URL only ever
    // appears as a redirect Location and is NEVER itself requested.
    const fetchedUrls = mocks.fetchUpstreamSingleHop.mock.calls.map((call) => String(call[0]));
    expect(fetchedUrls.some((u) => u.includes('/sorry'))).toBe(false);
    // fetchMetadata's catch returns the bare-host fallback for the ORIGINAL url,
    // NOT the parsed wall junk (title would have been the youtube URL string).
    expect(result.title).toBe('youtu.be');
    expect(result.title).not.toContain('youtube.com/watch');
    // ...and that hollow fallback is not a usable preview → warm path negatives it.
    expect(isUsablePreview(result)).toBe(false);
  });

  it('does NOT follow a redirect into a consent.* cookie gate', async () => {
    mocks.fetchUpstreamSingleHop.mockImplementation(async () => ({
      response: Readable.from([Buffer.from('')]),
      status: 302,
      headers: { location: CONSENT_URL },
    }));

    const result = await linkMetadataService.fetchMetadata(YOUTU_BE_URL);

    // The consent gate appears only as a redirect Location and is never fetched.
    const fetchedUrls = mocks.fetchUpstreamSingleHop.mock.calls.map((call) => String(call[0]));
    expect(fetchedUrls.some((u) => u.includes('consent.'))).toBe(false);
    expect(isUsablePreview(result)).toBe(false);
  });

  it('rejects a wall URL even when requested directly (200, no redirect)', async () => {
    // Direct 200 from the wall — the resolved-URL guard must reject before parse.
    mocks.fetchUpstreamSingleHop.mockImplementation(async () => ({
      response: Readable.from([Buffer.from(WALL_HTML)]),
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }));

    const result = await linkMetadataService.fetchMetadata(GOOGLE_SORRY_URL);

    // The wall's <title> (the youtube URL) must never become the preview title.
    expect(result.title).not.toContain('youtube.com/watch');
    expect(isUsablePreview(result)).toBe(false);
  });
});

describe('isUsablePreview', () => {
  it('rejects the parsed /sorry wall shape (title is a URL)', () => {
    expect(
      isUsablePreview({
        title: 'https://www.youtube.com/watch?v=mYDSSRS-B5U&feature=youtu.be',
        url: GOOGLE_SORRY_URL,
      }),
    ).toBe(false);
  });

  it('rejects a hostname-only fallback (title equals host)', () => {
    expect(isUsablePreview({ title: 'youtu.be', url: 'https://youtu.be/x' })).toBe(false);
    expect(
      isUsablePreview({ title: 'www.youtube.com', url: 'https://www.youtube.com/watch?v=x' }),
    ).toBe(false);
  });

  it('rejects a title that starts like a URL', () => {
    expect(isUsablePreview({ title: 'www.example.com/path' })).toBe(false);
    expect(isUsablePreview({ title: 'http://example.com' })).toBe(false);
  });

  it('rejects an entirely empty result', () => {
    expect(isUsablePreview({})).toBe(false);
    expect(isUsablePreview({ title: '   ' })).toBe(false);
  });

  it('accepts a result with a real image, description, or meaningful title', () => {
    expect(isUsablePreview({ image: 'https://i.ytimg.com/vi/x/hq.jpg', url: 'https://youtu.be/x' })).toBe(true);
    expect(isUsablePreview({ description: 'A real description', url: 'https://youtu.be/x' })).toBe(true);
    expect(isUsablePreview({ title: 'Rick Astley - Never Gonna Give You Up', url: 'https://youtu.be/x' })).toBe(true);
  });
});
