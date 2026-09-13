import { beforeEach, describe, expect, it, vi } from 'vitest';
import { oxyIdentityFixture } from '../../helpers/oxyIdentityFixtures';

const mocks = vi.hoisted(() => ({ makeServiceRequest: vi.fn(), findIdentityOwnerActor: vi.fn() }));
vi.mock('../../../utils/oxyHelpers', () => ({ getServiceOxyClient: () => ({ makeServiceRequest: mocks.makeServiceRequest }) }));
vi.mock('../../../services/userSummaryCache', () => ({ invalidate: vi.fn() }));
vi.mock('../../../db/federation/actorRepository', () => ({ findIdentityOwnerActor: mocks.findIdentityOwnerActor }));

import { resolveOxyExternalUser } from '../../../connectors/identity';
import type { NormalizedExternalActor } from '@oxy.so/federation';

const actor: NormalizedExternalActor = {
  network: 'activitypub', externalId: 'https://mastox.eu/users/WIRED', handle: 'wired@mastox.eu',
  federatedUsername: 'wired@x.com', instanceDomain: 'x.com',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findIdentityOwnerActor.mockResolvedValue({ oxyUserId: 'cached-previous-owner' });
});

describe('Oxy owns external identity across transports and networks', () => {
  it('takes the current Oxy mapping even when a cached network handle points to another user', async () => {
    mocks.makeServiceRequest.mockResolvedValue(oxyIdentityFixture({ actorUri: actor.externalId,
      transportAcct: actor.handle, canonicalAcct: 'wired@x.com', network: 'x.com', userId: 'oxy-current-owner' }));
    expect(await resolveOxyExternalUser(actor)).toBe('oxy-current-owner');
    expect(mocks.findIdentityOwnerActor).not.toHaveBeenCalled();
    expect(mocks.makeServiceRequest).toHaveBeenCalledWith('POST', '/federation/identities/resolve', {
      actorUri: actor.externalId, transportAcct: actor.handle, protocol: 'activitypub',
    });
  });

  it('refuses cached adoption when Oxy cannot verify the source', async () => {
    mocks.makeServiceRequest.mockRejectedValue(new Error('Oxy unavailable'));
    expect(await resolveOxyExternalUser(actor)).toBeNull();
    expect(mocks.findIdentityOwnerActor).not.toHaveBeenCalled();
  });

  it('keeps matching Instagram and Threads handles separate when Oxy returns different people', async () => {
    mocks.makeServiceRequest.mockResolvedValueOnce(oxyIdentityFixture({
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
    expect(mocks.findIdentityOwnerActor).not.toHaveBeenCalled();
  });

  it('accepts Oxy revocation on the next resolve instead of retaining an earlier shared user', async () => {
    const source = { actorUri: actor.externalId, transportAcct: actor.handle, canonicalAcct: 'wired@x.com', network: 'x.com' };
    mocks.makeServiceRequest.mockResolvedValueOnce(oxyIdentityFixture({ ...source, userId: 'shared-user' }))
      .mockResolvedValueOnce(oxyIdentityFixture({ ...source, userId: 'source-user' }));
    expect(await resolveOxyExternalUser(actor)).toBe('shared-user');
    expect(await resolveOxyExternalUser({ ...actor, oxyUserId: 'shared-user' })).toBe('source-user');
  });

  it('rejects a response for a different source actor', async () => {
    mocks.makeServiceRequest.mockResolvedValue(oxyIdentityFixture({ actorUri: 'https://mastox.eu/users/OTHER',
      transportAcct: actor.handle, canonicalAcct: 'wired@x.com', network: 'x.com' }));
    expect(await resolveOxyExternalUser(actor)).toBeNull();
  });
});
