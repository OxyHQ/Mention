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
  return {
    SsrfRejection,
    fetchUpstreamFollowingRedirects: mocks.fetchUpstreamFollowingRedirects,
    contentTypeFamily: (headers: Record<string, unknown>) => String(headers['content-type'] ?? '').split(';')[0],
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
      '../../services/mediaCache/cacheWorker',
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
      '../../services/mediaCache/cacheWorker',
    );

    await expect(
      persistRemoteMediaForFederatedOwnerDetailed('https://remote.example/huge.jpg', 'oxy_user'),
    ).resolves.toMatchObject({ ok: false, reason: 'too-large', permanent: false });
  });

  it('still treats upstream 404/410 as permanently unavailable media', async () => {
    mocks.fetchUpstreamFollowingRedirects.mockResolvedValue(upstreamResponse(410, {}));
    const { persistRemoteMediaForFederatedOwnerDetailed } = await import(
      '../../services/mediaCache/cacheWorker',
    );

    await expect(
      persistRemoteMediaForFederatedOwnerDetailed('https://remote.example/gone.jpg', 'oxy_user'),
    ).resolves.toMatchObject({ ok: false, reason: 'upstream-error', status: 410, permanent: true });
  });
});
