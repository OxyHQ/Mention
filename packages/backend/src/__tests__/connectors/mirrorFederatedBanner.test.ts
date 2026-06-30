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

    const stored = await mirrorFederatedBanner(
      'https://files.mastodon.social/banner.png',
      'oxy-user-1',
      'https://mastodon.social/users/alice',
    );

    expect(stored).toBe(true);
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

  it('warns and returns false on a transient mirror failure (no header stored)', async () => {
    mocks.persistRemoteMedia.mockResolvedValue({ ok: false, permanent: false, reason: 'upstream-error' });

    const stored = await mirrorFederatedBanner(
      'https://files.mastodon.social/banner.png',
      'oxy-user-2',
      'https://mastodon.social/users/bob',
    );

    expect(stored).toBe(false);
    expect(mocks.userSettingsUpdateOne).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      'Failed to mirror banner for https://mastodon.social/users/bob',
      expect.objectContaining({ reason: 'upstream-error', remoteHost: 'files.mastodon.social' }),
    );
  });

  it('stays quiet and returns false on a permanent mirror failure', async () => {
    mocks.persistRemoteMedia.mockResolvedValue({ ok: false, permanent: true, reason: 'not-media' });

    const stored = await mirrorFederatedBanner(
      'https://files.mastodon.social/banner.txt',
      'oxy-user-3',
      'https://mastodon.social/users/carol',
    );

    expect(stored).toBe(false);
    expect(mocks.userSettingsUpdateOne).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  it('guards a non-http url without touching the media path', async () => {
    const stored = await mirrorFederatedBanner(
      'data:image/png;base64,iVBORw0KGgo=',
      'oxy-user-4',
      'https://mastodon.social/users/dave',
    );

    expect(stored).toBe(false);
    expect(mocks.persistRemoteMedia).not.toHaveBeenCalled();
    expect(mocks.userSettingsUpdateOne).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });
});
