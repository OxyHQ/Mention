import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchUpstreamFollowingRedirects: vi.fn(),
  uploadFederatedMedia: vi.fn(),
  uploadCachedMedia: vi.fn(),
  deleteCachedMedia: vi.fn(),
  updateOne: vi.fn(),
}));

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

vi.mock('../../services/mediaCache/oxyMediaStore', () => ({
  MediaStoreUnavailableError: class MediaStoreUnavailableError extends Error {},
  isMediaCacheEnabled: () => true,
  uploadFederatedMedia: mocks.uploadFederatedMedia,
  uploadCachedMedia: mocks.uploadCachedMedia,
  deleteCachedMedia: mocks.deleteCachedMedia,
}));

vi.mock('../../models/FederatedMediaCache', () => ({
  default: {
    updateOne: mocks.updateOne,
  },
}));

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
  });

  it('rejects a video banner as non-media before any download or upload', async () => {
    mocks.fetchUpstreamFollowingRedirects.mockResolvedValue(
      // Under the generic policy this passes both gates: `video/` is allowed and
      // 199 MiB is under the 200 MiB video cap.
      upstreamResponse(200, {
        'content-type': 'video/mp4',
        'content-length': String(199 * 1024 * 1024),
      }),
    );
    const [{ persistRemoteMediaForFederatedOwnerDetailed }, { FEDERATED_BANNER_DOWNLOAD_POLICY }] =
      await Promise.all([
        import('../../services/mediaCache/cacheWorker.js'),
        import('../../services/mediaCache/policy.js'),
      ]);

    await expect(
      persistRemoteMediaForFederatedOwnerDetailed(
        'https://attacker.example/banner.mp4',
        'oxy_user',
        { role: 'banner' },
        FEDERATED_BANNER_DOWNLOAD_POLICY,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'not-media' });
    expect(mocks.uploadFederatedMedia).not.toHaveBeenCalled();
  });

  it('rejects an audio banner as non-media before any download or upload', async () => {
    mocks.fetchUpstreamFollowingRedirects.mockResolvedValue(
      upstreamResponse(200, { 'content-type': 'audio/mpeg', 'content-length': String(1024) }),
    );
    const [{ persistRemoteMediaForFederatedOwnerDetailed }, { FEDERATED_BANNER_DOWNLOAD_POLICY }] =
      await Promise.all([
        import('../../services/mediaCache/cacheWorker.js'),
        import('../../services/mediaCache/policy.js'),
      ]);

    await expect(
      persistRemoteMediaForFederatedOwnerDetailed(
        'https://attacker.example/banner.mp3',
        'oxy_user',
        { role: 'banner' },
        FEDERATED_BANNER_DOWNLOAD_POLICY,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'not-media' });
    expect(mocks.uploadFederatedMedia).not.toHaveBeenCalled();
  });

  it('applies the banner byte ceiling to an image that the generic image cap allows', async () => {
    mocks.fetchUpstreamFollowingRedirects.mockResolvedValue(
      // 20 MiB is under the generic 32 MiB image cap but over the banner ceiling.
      upstreamResponse(200, {
        'content-type': 'image/jpeg',
        'content-length': String(20 * 1024 * 1024),
      }),
    );
    const [{ persistRemoteMediaForFederatedOwnerDetailed }, { FEDERATED_BANNER_DOWNLOAD_POLICY }] =
      await Promise.all([
        import('../../services/mediaCache/cacheWorker.js'),
        import('../../services/mediaCache/policy.js'),
      ]);

    await expect(
      persistRemoteMediaForFederatedOwnerDetailed(
        'https://attacker.example/banner.jpg',
        'oxy_user',
        { role: 'banner' },
        FEDERATED_BANNER_DOWNLOAD_POLICY,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'too-large' });
    expect(mocks.uploadFederatedMedia).not.toHaveBeenCalled();
  });

  it('leaves federated POST media able to carry video (the policy is opt-in)', async () => {
    mocks.fetchUpstreamFollowingRedirects.mockResolvedValue(
      upstreamResponse(200, { 'content-type': 'video/mp4', 'content-length': String(1024) }),
    );
    const { persistRemoteMediaForFederatedOwnerDetailed } = await import(
      '../../services/mediaCache/cacheWorker'
    );

    // No policy → generic rules → `video/` is NOT rejected as non-media.
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
