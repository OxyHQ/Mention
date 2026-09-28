import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchUpstreamFollowingRedirects: vi.fn(),
  uploadFederatedMedia: vi.fn(),
  uploadCachedMedia: vi.fn(),
  deleteCachedMedia: vi.fn(),
  reviveFederatedFiles: vi.fn(async () => []),
  OwnedElsewhere: class OxyMediaOwnedElsewhereError extends Error {},
  reencodeFirstFrame: vi.fn(),
}));

// ffmpeg is the re-encoder's only dependency; its argument array and sandbox are
// asserted in `utils/imageReencode.test.ts`. Here it is the boundary.
vi.mock('../../utils/imageReencode', () => ({ reencodeFirstFrame: mocks.reencodeFirstFrame }));

vi.mock('../../utils/safeUpstreamFetch', async () => {
  class SsrfRejection extends Error {}
  const contentTypeFamilyFromString = (raw: string | undefined) =>
    typeof raw === 'string' ? (raw.split(';')[0]?.trim().toLowerCase() ?? '') : '';
  return {
    SsrfRejection,
    fetchUpstreamFollowingRedirects: mocks.fetchUpstreamFollowingRedirects,
    contentTypeFamilyFromString,
    contentTypeFamily: (headers: Record<string, unknown>) =>
      contentTypeFamilyFromString(
        typeof headers['content-type'] === 'string' ? (headers['content-type'] as string) : undefined,
      ),
  };
});

vi.mock('../../db/federation/mediaDeletionRepository', () => ({
  recordFederatedPoster: vi.fn(async () => undefined),
  reviveFederatedFiles: mocks.reviveFederatedFiles,
  databaseNow: vi.fn(async () => new Date()),
}));

vi.mock('../../services/mediaCache/oxyMediaStore', () => ({
  MediaStoreUnavailableError: class MediaStoreUnavailableError extends Error {},
  OxyMediaOwnedElsewhereError: mocks.OwnedElsewhere,
  isMediaCacheEnabled: () => true,
  uploadFederatedMedia: mocks.uploadFederatedMedia,
  uploadCachedMedia: mocks.uploadCachedMedia,
  deleteCachedMedia: mocks.deleteCachedMedia,
}));

// No cache-table stub. `persistRemoteMediaForFederatedOwnerDetailed` never
// touches `federated_media_cache` — it classifies an upstream response and
// uploads, nothing more — so the `updateOne` stub that used to sit here was
// keeping a store out of the way that this path does not reach. It was never
// asserted against, and once the cache moved to Postgres it named a module the
// file under test no longer imports.

// The first import of the cache worker loads its whole module graph, and on a CI
// runner that alone takes about five seconds — the entire budget of a test. Left
// to the tests, whichever one ran first timed out on the import, not on anything
// it asserts. Pay it once here, under a hook budget sized for it; every test's
// own `import()` then resolves from the module cache. The mocks above are
// hoisted, so they apply to this import exactly as they do to the tests'.
beforeAll(async () => {
  await import('../../services/mediaCache/cacheWorker');
}, 60_000);

function upstreamResponse(statusCode: number, headers: Record<string, unknown>) {
  return {
    response: {
      statusCode,
      headers,
      resume: vi.fn(),
      destroy: vi.fn(),
      setTimeout: vi.fn(),
    },
  };
}

describe('durable federated media failure classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('treats non-cacheable content types as cache-policy failures, not unavailable media', async () => {
    mocks.fetchUpstreamFollowingRedirects.mockResolvedValue(
      upstreamResponse(200, { 'content-type': 'text/html', 'content-length': '42' }),
    );
    const { persistRemoteMediaForFederatedOwnerDetailed } = await import(
      '../../services/mediaCache/cacheWorker'
    );

    await expect(
      persistRemoteMediaForFederatedOwnerDetailed('https://remote.example/media', 'oxy_user'),
    ).resolves.toMatchObject({ ok: false, reason: 'not-media', permanent: false });
  });

  it('treats over-cap media as a cache-policy failure, not unavailable media', async () => {
    mocks.fetchUpstreamFollowingRedirects.mockResolvedValue(
      upstreamResponse(200, { 'content-type': 'image/jpeg', 'content-length': String(100 * 1024 * 1024) }),
    );
    const { persistRemoteMediaForFederatedOwnerDetailed } = await import(
      '../../services/mediaCache/cacheWorker'
    );

    await expect(
      persistRemoteMediaForFederatedOwnerDetailed('https://remote.example/huge.jpg', 'oxy_user'),
    ).resolves.toMatchObject({ ok: false, reason: 'too-large', permanent: false });
  });

  it('treats 409 FEDERATED_MEDIA_OWNED_ELSEWHERE as PERMANENT for the item, never a transient upload failure', async () => {
    const { Readable } = await import('node:stream');
    const body = Object.assign(Readable.from([Buffer.from('abcd')]), {
      statusCode: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': '4' },
      setTimeout: vi.fn(),
    });
    mocks.fetchUpstreamFollowingRedirects.mockResolvedValue({ response: body });
    mocks.uploadFederatedMedia.mockRejectedValue(new mocks.OwnedElsewhere());
    const { persistRemoteMediaForFederatedOwnerDetailed } = await import('../../services/mediaCache/cacheWorker');

    await expect(
      persistRemoteMediaForFederatedOwnerDetailed('https://remote.example/theirs.jpg', 'oxy_user'),
    ).resolves.toMatchObject({ ok: false, reason: 'owned-elsewhere', permanent: true });
  });

  it('still treats upstream 404/410 as permanently unavailable media', async () => {
    mocks.fetchUpstreamFollowingRedirects.mockResolvedValue(upstreamResponse(410, {}));
    const { persistRemoteMediaForFederatedOwnerDetailed } = await import(
      '../../services/mediaCache/cacheWorker'
    );

    await expect(
      persistRemoteMediaForFederatedOwnerDetailed('https://remote.example/gone.jpg', 'oxy_user'),
    ).resolves.toMatchObject({ ok: false, reason: 'upstream-error', status: 410, permanent: true });
  });
});

/**
 * The banner download policy (`FEDERATED_BANNER_DOWNLOAD_POLICY`).
 *
 * `mirrorFederatedBanner` runs on EVERY successful federated actor resolve with no
 * per-URL dedup or change detection, and a ~2 KB inbound activity is enough to
 * trigger one. Without a policy a banner inherited the generic federated-media
 * rules — `image/`+`video/`+`audio/` up to the 200 MiB VIDEO cap — so an actor
 * advertising a video as its `image` turned each resolve into a video-sized
 * download, an S3 upload, a poster-extraction pass and a second S3 upload.
 *
 * These assert the POLICY IS ENFORCED, not merely passed: they call the download
 * path with the real policy and require the reject to happen before any upload.
 * The companion tests in `connectors/mirrorFederatedBanner.test.ts` +
 * `connectors/identity.test.ts` assert the banner call site actually supplies it.
 */
describe('federated banner download policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.uploadFederatedMedia.mockResolvedValue({ oxyFileId: 'banner-file' });
  });

  const MIB = 1024 * 1024;
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('....IHDR'), Buffer.alloc(40, 2), Buffer.from('....IDAT')]);
  const ANIMATED_GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20, 0), Buffer.from([0x21, 0xf9, 0x04, 0, 0, 0, 0, 0]), Buffer.alloc(10, 0), Buffer.from([0x21, 0xf9, 0x04, 0, 0, 0, 0, 0])]);
  const HTML = Buffer.from('<!doctype html><html><body>Not found</body></html>');
  const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(40, 0)]);

  async function bodyResponse(bytes: Buffer, headers: Record<string, string>) {
    const { Readable } = await import('node:stream');
    return {
      response: Object.assign(Readable.from([bytes]), { statusCode: 200, headers, setTimeout: vi.fn() }),
    };
  }

  async function mirror(url = 'https://files.example/header.png') {
    const [{ persistRemoteMediaForFederatedOwnerDetailed }, { FEDERATED_BANNER_DOWNLOAD_POLICY }] = await Promise.all([
      import('../../services/mediaCache/cacheWorker'),
      import('../../services/mediaCache/policy'),
    ]);
    return persistRemoteMediaForFederatedOwnerDetailed(url, 'oxy_user', { role: 'banner' }, FEDERATED_BANNER_DOWNLOAD_POLICY);
  }

  it.each([
    ['text/plain', JPEG, 'image/jpeg'],
    ['binary/octet-stream', JPEG, 'image/jpeg'],
    ['text/html', PNG, 'image/png'],
    ['(no Content-Type)', JPEG, 'image/jpeg'],
  ])('stores a REAL image the host labels %s, typed by its bytes', async (declared, bytes, stored) => {
    const headers: Record<string, string> = { 'content-length': String(bytes.length) };
    if (!declared.startsWith('(')) headers['content-type'] = declared;
    mocks.fetchUpstreamFollowingRedirects.mockResolvedValue(await bodyResponse(bytes, headers));

    await expect(mirror()).resolves.toMatchObject({ ok: true, media: { oxyFileId: 'banner-file', contentType: stored } });
    expect(mocks.uploadFederatedMedia).toHaveBeenCalledWith(expect.objectContaining({
      contentType: stored,
      originalName: `header.${stored.split('/')[1]}`,
    }));
    expect(mocks.reencodeFirstFrame).not.toHaveBeenCalled();
  });

  it.each([
    ['HTML labelled image/jpeg', HTML, 'image/jpeg'],
    ['SVG labelled image/svg+xml', SVG, 'image/svg+xml'],
    ['SVG labelled image/png', SVG, 'image/png'],
    ['a video', MP4, 'video/mp4'],
  ])('refuses %s: not a raster image, whatever the label — permanent, nothing uploaded', async (_case, bytes, declared) => {
    mocks.fetchUpstreamFollowingRedirects.mockResolvedValue(
      await bodyResponse(bytes, { 'content-type': declared, 'content-length': String(bytes.length) }),
    );

    await expect(mirror()).resolves.toMatchObject({ ok: false, reason: 'not-media', permanent: true });
    expect(mocks.uploadFederatedMedia).not.toHaveBeenCalled();
    expect(mocks.reencodeFirstFrame).not.toHaveBeenCalled();
  });

  it('stores an OVERSIZED banner as a re-encoded first-frame WebP instead of dropping it', async () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(12 * MIB, 7)]);
    mocks.fetchUpstreamFollowingRedirects.mockResolvedValue(
      await bodyResponse(big, { 'content-type': 'image/jpeg', 'content-length': String(big.length) }),
    );
    mocks.reencodeFirstFrame.mockResolvedValue({ ok: true, buffer: Buffer.from('RIFF....WEBPVP8 '), contentType: 'image/webp' });

    await expect(mirror()).resolves.toMatchObject({ ok: true, media: { contentType: 'image/webp', sizeBytes: 16 } });
    expect(mocks.uploadFederatedMedia).toHaveBeenCalledWith(expect.objectContaining({
      contentType: 'image/webp',
      sizeBytes: 16,
      originalName: 'header.webp',
    }));
  });

  it('stores an ANIMATED banner as its first frame', async () => {
    mocks.fetchUpstreamFollowingRedirects.mockResolvedValue(
      await bodyResponse(ANIMATED_GIF, { 'content-type': 'image/gif', 'content-length': String(ANIMATED_GIF.length) }),
    );
    mocks.reencodeFirstFrame.mockResolvedValue({ ok: true, buffer: Buffer.from('webp-still'), contentType: 'image/webp' });

    await expect(mirror('https://files.example/header.gif')).resolves.toMatchObject({ ok: true, media: { contentType: 'image/webp' } });
    expect(mocks.reencodeFirstFrame).toHaveBeenCalledTimes(1);
  });

  it('keeps an animated banner within the cap as-is when its first frame cannot be taken (it still renders)', async () => {
    mocks.fetchUpstreamFollowingRedirects.mockResolvedValue(
      await bodyResponse(ANIMATED_GIF, { 'content-type': 'image/gif', 'content-length': String(ANIMATED_GIF.length) }),
    );
    mocks.reencodeFirstFrame.mockResolvedValue({ ok: false, reason: 'undecodable' });

    await expect(mirror('https://files.example/header.gif')).resolves.toMatchObject({ ok: true, media: { contentType: 'image/gif' } });
  });

  it('an oversized banner the re-encoder cannot run on is TRANSIENT (retried), one it cannot decode is permanent', async () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(11 * MIB, 7)]);
    mocks.fetchUpstreamFollowingRedirects.mockImplementation(async () =>
      bodyResponse(big, { 'content-type': 'image/jpeg', 'content-length': String(big.length) }));

    mocks.reencodeFirstFrame.mockResolvedValueOnce({ ok: false, reason: 'timeout' });
    await expect(mirror()).resolves.toMatchObject({ ok: false, reason: 'reencode-failed', permanent: false });
    mocks.reencodeFirstFrame.mockResolvedValueOnce({ ok: false, reason: 'undecodable' });
    await expect(mirror()).resolves.toMatchObject({ ok: false, reason: 'undecodable', permanent: true });
    expect(mocks.uploadFederatedMedia).not.toHaveBeenCalled();
  });

  it('downloads up to the 25 MiB hard cap and refuses beyond it before reading the body', async () => {
    mocks.fetchUpstreamFollowingRedirects.mockResolvedValue(
      // 20 MiB was refused under the old 10 MiB ceiling; 30 MiB is over the new download cap.
      upstreamResponse(200, { 'content-type': 'image/jpeg', 'content-length': String(30 * MIB) }),
    );

    await expect(mirror()).resolves.toMatchObject({ ok: false, reason: 'too-large', permanent: true });
    expect(mocks.uploadFederatedMedia).not.toHaveBeenCalled();
  });

  it('keeps a transient upstream failure transient', async () => {
    mocks.fetchUpstreamFollowingRedirects.mockResolvedValue(upstreamResponse(503, {}));
    await expect(mirror()).resolves.toMatchObject({ ok: false, reason: 'upstream-error', status: 503, permanent: false });
  });

  it('leaves federated POST media on the generic, header-typed rules (the policy is opt-in)', async () => {
    mocks.fetchUpstreamFollowingRedirects.mockResolvedValue(
      await bodyResponse(JPEG, { 'content-type': 'text/plain', 'content-length': String(JPEG.length) }),
    );
    const { persistRemoteMediaForFederatedOwnerDetailed } = await import('../../services/mediaCache/cacheWorker');

    await expect(
      persistRemoteMediaForFederatedOwnerDetailed('https://remote.example/post.jpg', 'oxy_user'),
    ).resolves.toMatchObject({ ok: false, reason: 'not-media', permanent: false });

    mocks.fetchUpstreamFollowingRedirects.mockResolvedValue(
      upstreamResponse(200, { 'content-type': 'video/mp4', 'content-length': String(1024) }),
    );
    // No policy → `video/` is NOT rejected as non-media.
    await expect(
      persistRemoteMediaForFederatedOwnerDetailed('https://remote.example/clip.mp4', 'oxy_user'),
    ).resolves.not.toMatchObject({ reason: 'not-media' });
  });
});

/**
 * The narrowing primitives themselves, exercised directly: a caller policy must
 * only ever INTERSECT with the generic rules, never widen them.
 */
describe('media download policy intersection', () => {
  it('cannot re-admit a type the generic policy rejects, nor raise a per-type cap', async () => {
    const { isAllowedByDownloadPolicy, maxBytesForDownload } = await import(
      '../../services/mediaCache/policy'
    );
    const permissive = {
      allowedContentTypePrefixes: ['image/', 'video/', 'text/'],
      maxBytes: Number.MAX_SAFE_INTEGER,
    };

    // SVG matches the caller's `image/` prefix but stays rejected generically.
    expect(isAllowedByDownloadPolicy('image/svg+xml', permissive)).toBe(false);
    // `text/html` is not an allowed media family, whatever the caller asks for.
    expect(isAllowedByDownloadPolicy('text/html', permissive)).toBe(false);
    // An HLS playlist spelled under an allowed prefix is the other generic
    // rejection, and a caller policy cannot re-admit it either. It matters here
    // specifically: the media proxy DOES admit playlists, but only on its own
    // rewrite path — never as bytes to store, and never through a policy.
    expect(isAllowedByDownloadPolicy('video/mpegurl', permissive)).toBe(false);
    expect(isAllowedByDownloadPolicy('application/vnd.apple.mpegurl', permissive)).toBe(false);
    // A huge caller ceiling cannot raise the generic per-type caps.
    expect(maxBytesForDownload('image/jpeg', permissive)).toBe(32 * 1024 * 1024);
    expect(maxBytesForDownload('video/mp4', permissive)).toBe(200 * 1024 * 1024);
  });
});
