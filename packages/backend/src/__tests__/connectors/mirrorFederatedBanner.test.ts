import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `mirrorFederatedBanner` — the extracted, network-neutral banner-mirror helper
 * shared by the live actor-resolution path (`resolveOxyExternalUser`) and the
 * one-shot `backfillFederatedBanners` script. Asserts it goes through the SAME
 * service-token public-upload path as federated post media
 * (`persistRemoteMediaForFederatedOwnerDetailed`) and writes
 * `UserSettings.profileHeaderImage` only on success.
 */

const mocks = vi.hoisted(() => ({
  persistRemoteMedia: vi.fn(),
  userSettingsUpdateOne: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('../../services/mediaCache/cacheWorker', () => ({
  persistRemoteMediaForFederatedOwnerDetailed: mocks.persistRemoteMedia,
}));

vi.mock('../../models/UserSettings', () => ({
  default: {
    updateOne: mocks.userSettingsUpdateOne,
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: mocks.loggerWarn, error: vi.fn(), debug: vi.fn() },
}));

import { mirrorFederatedBanner } from '../../connectors/identity';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userSettingsUpdateOne.mockResolvedValue({ acknowledged: true });
});

describe('mirrorFederatedBanner', () => {
  it('mirrors the banner and stores its file id on success', async () => {
    mocks.persistRemoteMedia.mockResolvedValue({
      ok: true,
      media: { oxyFileId: 'banner_file_1', contentType: 'image/png', sizeBytes: 1234 },
    });

    const result = await mirrorFederatedBanner(
      'https://files.mastodon.social/banner.png',
      'oxy-user-1',
      'https://mastodon.social/users/alice',
    );

    expect(result).toEqual({ ok: true, permanent: false });
    // Goes through the SAME service-token public-upload path as federated post
    // media — NOT the user-authenticated SDK `uploadProfileBanner` (which 401s).
    expect(mocks.persistRemoteMedia).toHaveBeenCalledWith(
      'https://files.mastodon.social/banner.png',
      'oxy-user-1',
      expect.objectContaining({
        role: 'banner',
        actorUri: 'https://mastodon.social/users/alice',
        remoteHost: 'files.mastodon.social',
      }),
    );
    expect(mocks.userSettingsUpdateOne).toHaveBeenCalledWith(
      { oxyUserId: 'oxy-user-1' },
      { $set: { profileHeaderImage: 'banner_file_1' } },
      { upsert: true },
    );
  });

  it('warns and reports a transient (retryable) failure (no header stored)', async () => {
    mocks.persistRemoteMedia.mockResolvedValue({ ok: false, permanent: false, reason: 'upstream-error' });

    const result = await mirrorFederatedBanner(
      'https://files.mastodon.social/banner.png',
      'oxy-user-2',
      'https://mastodon.social/users/bob',
    );

    // `permanent: false` tells the backfill caller this is worth a retry.
    expect(result).toEqual({ ok: false, permanent: false });
    expect(mocks.userSettingsUpdateOne).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      'Failed to mirror banner for https://mastodon.social/users/bob',
      expect.objectContaining({ reason: 'upstream-error', remoteHost: 'files.mastodon.social' }),
    );
  });

  it('stays quiet and reports a permanent failure', async () => {
    mocks.persistRemoteMedia.mockResolvedValue({ ok: false, permanent: true, reason: 'not-media' });

    const result = await mirrorFederatedBanner(
      'https://files.mastodon.social/banner.txt',
      'oxy-user-3',
      'https://mastodon.social/users/carol',
    );

    // `permanent: true` tells the backfill caller NOT to retry.
    expect(result).toEqual({ ok: false, permanent: true });
    expect(mocks.userSettingsUpdateOne).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  it('swallows a throw from the media persist and reports a transient failure', async () => {
    // The helper documents itself as best-effort ("failures are logged, not
    // propagated") — a rejected persist must NOT throw, or on the live path it
    // would discard an already-successful user resolution.
    mocks.persistRemoteMedia.mockRejectedValue(new Error('S3 upload timeout'));

    const result = await mirrorFederatedBanner(
      'https://files.mastodon.social/banner.png',
      'oxy-user-5',
      'https://mastodon.social/users/erin',
    );

    // A throw is treated as transient so the backfill still retries.
    expect(result).toEqual({ ok: false, permanent: false });
    expect(mocks.userSettingsUpdateOne).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      'Failed to mirror banner for https://mastodon.social/users/erin',
      expect.objectContaining({ error: expect.any(Error), remoteHost: 'files.mastodon.social' }),
    );
  });

  it('swallows a throw from the UserSettings write after a successful upload', async () => {
    mocks.persistRemoteMedia.mockResolvedValue({
      ok: true,
      media: { oxyFileId: 'banner_file_6', contentType: 'image/png', sizeBytes: 1234 },
    });
    mocks.userSettingsUpdateOne.mockRejectedValue(new Error('Mongo write conflict'));

    const result = await mirrorFederatedBanner(
      'https://files.mastodon.social/banner.png',
      'oxy-user-6',
      'https://mastodon.social/users/frank',
    );

    expect(result).toEqual({ ok: false, permanent: false });
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      'Failed to mirror banner for https://mastodon.social/users/frank',
      expect.objectContaining({ error: expect.any(Error), remoteHost: 'files.mastodon.social' }),
    );
  });

  it('guards a non-http url as a permanent failure without touching the media path', async () => {
    const result = await mirrorFederatedBanner(
      'data:image/png;base64,iVBORw0KGgo=',
      'oxy-user-4',
      'https://mastodon.social/users/dave',
    );

    // A non-http url will never become valid → permanent, no retry.
    expect(result).toEqual({ ok: false, permanent: true });
    expect(mocks.persistRemoteMedia).not.toHaveBeenCalled();
    expect(mocks.userSettingsUpdateOne).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });
});
