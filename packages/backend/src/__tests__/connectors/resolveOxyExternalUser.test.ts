import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Oxy supplies canonical identity; Mention imports source content and renders that exact profile. */

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

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: mocks.loggerWarn, error: vi.fn(), debug: vi.fn() },
}));

import { resolveOxyExternalUser } from '../../connectors/identity';
import type { NormalizedExternalActor } from '@oxy.so/federation';
import { oxyIdentityFixture } from '../helpers/oxyIdentityFixtures';

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
  it('uses Oxy profile ownership without running Mention banner persistence', async () => {
    mocks.makeServiceRequest.mockResolvedValue(oxyIdentityFixture({ actorUri: actor.externalId, transportAcct: actor.handle, canonicalAcct: actor.federatedUsername, network: actor.instanceDomain, userId: 'oxy-user-1' }));
    mocks.persistRemoteMedia.mockRejectedValue(new Error('S3 upload timeout'));

    const result = await resolveOxyExternalUser(actor);

    // The user was resolved; a banner-mirror failure must not drop it.
    expect(result).toBe('oxy-user-1');
    expect(mocks.makeServiceRequest).toHaveBeenCalledWith('POST', '/federation/identities/resolve', { actorUri: actor.externalId, transportAcct: actor.handle, protocol: 'activitypub' });
  });

  it('resolves without writing Mention profile settings', async () => {
    mocks.makeServiceRequest.mockResolvedValue(oxyIdentityFixture({ actorUri: actor.externalId, transportAcct: actor.handle, canonicalAcct: actor.federatedUsername, network: actor.instanceDomain, userId: 'oxy-user-2' }));
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
