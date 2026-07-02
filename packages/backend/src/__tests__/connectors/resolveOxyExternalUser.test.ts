import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `resolveOxyExternalUser` — the network-neutral identity bridge that upserts a
 * federated actor into Oxy (`PUT /users/resolve`) and then mirrors its banner.
 *
 * The banner mirror is best-effort: a failure there must NEVER discard an
 * already-successful user resolution. These tests pin that a throw out of the
 * banner path still returns the resolved Oxy id, while a genuine resolution
 * failure still returns `null`.
 */

const mocks = vi.hoisted(() => ({
  makeServiceRequest: vi.fn(),
  getServiceOxyClient: vi.fn(),
  persistRemoteMedia: vi.fn(),
  userSettingsUpdateOne: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: mocks.getServiceOxyClient,
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

import { resolveOxyExternalUser } from '../../connectors/identity';
import type { NormalizedExternalActor } from '../../connectors/types';

const actor: NormalizedExternalActor = {
  network: 'activitypub',
  externalId: 'https://mastodon.social/users/grace',
  handle: 'grace@mastodon.social',
  federatedUsername: 'grace@mastodon.social',
  instanceDomain: 'mastodon.social',
  displayName: 'Grace',
  avatarUrl: 'https://files.mastodon.social/avatar.png',
  bannerUrl: 'https://files.mastodon.social/banner.png',
  bio: 'hi',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getServiceOxyClient.mockReturnValue({ makeServiceRequest: mocks.makeServiceRequest });
  mocks.userSettingsUpdateOne.mockResolvedValue({ acknowledged: true });
});

describe('resolveOxyExternalUser', () => {
  it('returns the resolved Oxy id even when the banner persist throws', async () => {
    mocks.makeServiceRequest.mockResolvedValue({ _id: 'oxy-user-1' });
    mocks.persistRemoteMedia.mockRejectedValue(new Error('S3 upload timeout'));

    const result = await resolveOxyExternalUser(actor);

    // The user was resolved; a banner-mirror failure must not drop it.
    expect(result).toBe('oxy-user-1');
    expect(mocks.makeServiceRequest).toHaveBeenCalledWith('PUT', '/users/resolve', expect.any(Object));
  });

  it('returns the resolved Oxy id even when the UserSettings banner write throws', async () => {
    mocks.makeServiceRequest.mockResolvedValue({ _id: 'oxy-user-2' });
    mocks.persistRemoteMedia.mockResolvedValue({
      ok: true,
      media: { oxyFileId: 'banner_file', contentType: 'image/png', sizeBytes: 10 },
    });
    mocks.userSettingsUpdateOne.mockRejectedValue(new Error('Mongo write conflict'));

    const result = await resolveOxyExternalUser(actor);

    expect(result).toBe('oxy-user-2');
  });

  it('returns null when the Oxy resolve request itself fails', async () => {
    mocks.makeServiceRequest.mockRejectedValue(new Error('oxy-api unreachable'));

    const result = await resolveOxyExternalUser(actor);

    expect(result).toBeNull();
    expect(mocks.persistRemoteMedia).not.toHaveBeenCalled();
  });
});
