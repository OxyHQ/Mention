import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'stream';

/**
 * Regression: link metadata must survive a HEAVY `<head>`.
 *
 * YouTube `watch` pages serve correct `og:title` / `og:image` / `og:description`
 * in their static `<head>`, but those tags sit ~630 KB into the document while
 * the old reader capped the HTML read at 512 KB and REJECTED on overflow — so it
 * aborted ~120 KB before the tags and returned the hostname-only fallback.
 *
 * The fix reads up to {@link LINK_METADATA_MAX_BYTES} (default 1 MB) and stops at
 * `</head>` (boundary-safe), and on the byte cap it RESOLVES the truncated buffer
 * instead of rejecting. These tests synthesize a >512 KB head whose og tags sit
 * PAST the old cap but before `</head>` and assert all three are extracted —
 * including across a chunk boundary that splits the `</head>` marker.
 *
 * NOTE: YouTube URLs now resolve via the oEmbed provider chain (see
 * `linkMetadataProviders`) and never reach this generic reader. The heavy-head
 * reader is host-agnostic and still backs every other heavy-`<head>` site (and
 * the oEmbed-failure fallback), so a non-provider host is used here.
 *
 * The upstream fetch and image cache are mocked so no network or S3 is touched.
 */

const OG_TITLE = 'Heavy Head Video Title';
const OG_DESC = 'A description that lives deep inside a very large head element.';
const OG_IMAGE = 'https://images.example.com/vi/dQw4w9WgXcQ/maxresdefault.jpg';
const PAGE_URL = 'https://blog.example.com/watch?v=dQw4w9WgXcQ';

// ~600 KB of filler INSIDE the head, before the og tags, so the tags land well
// past the old 512 KB cap. Wrapped in an HTML comment (no `<` other than `<!--`)
// so the tag scanner never trips on it.
const HEAD_FILLER = `<!--${'x'.repeat(600 * 1024)}-->`;

const OG_TAGS = [
  `<title>${OG_TITLE}</title>`,
  `<meta property="og:title" content="${OG_TITLE}">`,
  `<meta property="og:description" content="${OG_DESC}">`,
  `<meta property="og:image" content="${OG_IMAGE}">`,
  '<meta property="og:site_name" content="YouTube">',
].join('');

// og tags sit AFTER the 600 KB filler but BEFORE </head>.
const HEAVY_HTML = `<!DOCTYPE html><html><head>${HEAD_FILLER}${OG_TAGS}</head><body>video</body></html>`;

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

function respondWith(chunks: Buffer[]): void {
  // A Readable can only be drained once, so build a fresh stream per call.
  mocks.fetchUpstreamSingleHop.mockImplementationOnce(async () => ({
    response: Readable.from(chunks),
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  // Force the image cache-MISS branch; downscale returns nothing so the raw
  // absolute og:image flows through unchanged (response-path fast path).
  mocks.getCachedImage.mockResolvedValue(null);
  mocks.cacheImage.mockResolvedValue(null);
});

describe('linkMetadataService heavy-head extraction', () => {
  it('extracts og:title/description/image that sit past the old 512 KB cap', async () => {
    expect(HEAVY_HTML.indexOf('og:title')).toBeGreaterThan(512 * 1024);
    respondWith([Buffer.from(HEAVY_HTML)]);

    const result = await linkMetadataService.fetchMetadata(PAGE_URL);

    expect(result.title).toBe(OG_TITLE);
    expect(result.description).toBe(OG_DESC);
    expect(result.image).toBe(OG_IMAGE);
    // Hostname fallback would have produced the bare host as the title.
    expect(result.title).not.toBe('blog.example.com');
  });

  it('still detects </head> when the marker is split across a chunk boundary', async () => {
    const full = Buffer.from(HEAVY_HTML);
    const markerStart = full.indexOf('</head>');
    expect(markerStart).toBeGreaterThan(0);
    // Split INSIDE the marker (after "</he") so detection must rely on the
    // carryover from the previous chunk.
    const splitAt = markerStart + 4;
    respondWith([full.subarray(0, splitAt), full.subarray(splitAt)]);

    const result = await linkMetadataService.fetchMetadata(PAGE_URL);

    expect(result.title).toBe(OG_TITLE);
    expect(result.description).toBe(OG_DESC);
    expect(result.image).toBe(OG_IMAGE);
  });

  it('resolves (does not reject) when the byte cap is hit before </head>', async () => {
    // og tags at the very start (within the parser fallback window), then >1 MB
    // of filler and NO </head> — the byte cap fires first. The old code rejected
    // ("Metadata response too large") → hostname fallback; the fix resolves the
    // truncated buffer so the leading og tags are still extracted.
    const noHeadClose =
      `<!DOCTYPE html><html><head>${OG_TAGS}<!--${'x'.repeat(1024 * 1024 + 64 * 1024)}-->`;
    respondWith([Buffer.from(noHeadClose)]);

    const result = await linkMetadataService.fetchMetadata(PAGE_URL);

    expect(result.title).toBe(OG_TITLE);
    expect(result.image).toBe(OG_IMAGE);
  });
});
