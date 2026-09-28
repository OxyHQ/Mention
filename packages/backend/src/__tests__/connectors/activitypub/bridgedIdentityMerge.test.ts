import { beforeEach, describe, expect, it, vi } from 'vitest';
import { oxyIdentityFixture } from '../../helpers/oxyIdentityFixtures';

const mocks = vi.hoisted(() => ({ serviceRequest: vi.fn() }));
vi.mock('../../../utils/oxyHelpers', () => ({ getServiceOxyClient: () => ({ serviceRequest: mocks.serviceRequest }) }));
vi.mock('../../../services/userSummaryCache', () => ({ invalidate: vi.fn() }));

import { resolveOxyExternalUser } from '../../../connectors/identity';
import type { NormalizedExternalActor } from '@oxy.so/federation';

const actor: NormalizedExternalActor = {
  network: 'activitypub', externalId: 'https://mastox.eu/users/WIRED', handle: 'wired@mastox.eu',
  federatedUsername: 'wired@x.com', instanceDomain: 'x.com',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Oxy owns external identity across transports and networks', () => {
  it('takes the current Oxy mapping even when a cached network handle points to another user', async () => {
    mocks.serviceRequest.mockResolvedValue(oxyIdentityFixture({ actorUri: actor.externalId,
      transportAcct: actor.handle, canonicalAcct: 'wired@x.com', network: 'x.com', userId: 'oxy-current-owner' }));
    expect(await resolveOxyExternalUser(actor)).toBe('oxy-current-owner');
    expect(mocks.serviceRequest).toHaveBeenCalledWith('POST', '/federation/identities/resolve', {
      actorUri: actor.externalId, transportAcct: actor.handle, protocol: 'activitypub',
    });
  });

  it('refuses cached adoption when Oxy cannot verify the source', async () => {
    mocks.serviceRequest.mockRejectedValue(new Error('Oxy unavailable'));
    expect(await resolveOxyExternalUser(actor)).toBeNull();
  });

  it('keeps matching Instagram and Threads handles separate when Oxy returns different people', async () => {
    mocks.serviceRequest.mockResolvedValueOnce(oxyIdentityFixture({
      actorUri: 'https://kilogram.makeup/users/person', transportAcct: 'person@kilogram.makeup',
      canonicalAcct: 'person@instagram.com', network: 'instagram.com', userId: 'instagram-owner',
    })).mockResolvedValueOnce(oxyIdentityFixture({
      actorUri: 'https://threads.net/ap/users/person', transportAcct: 'person@threads.net',
      canonicalAcct: 'person@threads.net', network: 'threads.net', userId: 'threads-owner',
    }));
    expect(await resolveOxyExternalUser({ ...actor, externalId: 'https://kilogram.makeup/users/person',
      handle: 'person@kilogram.makeup', federatedUsername: 'person@instagram.com' })).toBe('instagram-owner');
    expect(await resolveOxyExternalUser({ ...actor, externalId: 'https://threads.net/ap/users/person',
      handle: 'person@threads.net', federatedUsername: 'person@threads.net' })).toBe('threads-owner');
  });

  it('accepts Oxy revocation on the next resolve instead of retaining an earlier shared user', async () => {
    const source = { actorUri: actor.externalId, transportAcct: actor.handle, canonicalAcct: 'wired@x.com', network: 'x.com' };
    mocks.serviceRequest.mockResolvedValueOnce(oxyIdentityFixture({ ...source, userId: 'shared-user' }))
      .mockResolvedValueOnce(oxyIdentityFixture({ ...source, userId: 'source-user' }));
    expect(await resolveOxyExternalUser(actor)).toBe('shared-user');
    expect(await resolveOxyExternalUser({ ...actor, oxyUserId: 'shared-user' })).toBe('source-user');
  });

  it('rejects a response for a different source actor', async () => {
    mocks.serviceRequest.mockResolvedValue(oxyIdentityFixture({ actorUri: 'https://mastox.eu/users/OTHER',
      transportAcct: actor.handle, canonicalAcct: 'wired@x.com', network: 'x.com' }));
    expect(await resolveOxyExternalUser(actor)).toBeNull();
  });
});
