import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Two bridges' copies of the same upstream person resolve to ONE Oxy identity.
 *
 * This is the half of the bridge relabel that has teeth: the derivation decides
 * what an account is CALLED, this decides whose account it IS. Measured on
 * production, 17 of 458 X handles are mirrored by both bird.makeup and mastox.eu,
 * and 79 of 815 Bridgy Fed Bluesky actors are accounts the atproto connector
 * already holds — so without this, every one of those would try to mint a second
 * Oxy user under a username that carries a unique index, and be refused.
 *
 * The other direction matters just as much: an ordinary federated actor must not
 * be dragged into a merge, so the pass-through case is asserted too.
 */

const mocks = vi.hoisted(() => ({
  resolveOxyExternalUser: vi.fn(),
  reportFederatedActorGone: vi.fn(),
  actorFindOne: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('../../../connectors/identity', () => ({
  resolveOxyExternalUser: mocks.resolveOxyExternalUser,
  reportFederatedActorGone: mocks.reportFederatedActorGone,
}));

vi.mock('../../../models/FederatedActor', () => ({
  default: { findOne: mocks.actorFindOne },
  FederatedActor: { findOne: mocks.actorFindOne },
}));

vi.mock('../../../connectors/activitypub/constants', () => ({
  FEDERATION_ENABLED: true,
  isBlockedDomain: () => false,
}));

vi.mock('../../../utils/logger', () => ({
  logger: { info: mocks.loggerInfo, warn: mocks.loggerWarn, error: vi.fn(), debug: vi.fn() },
}));

import { resolveFederatedActorIdentity } from '../../../connectors/activitypub/actor.service';
import type { NormalizedExternalActor } from '@oxyhq/federation';

/** A bridged actor: its identity (`federatedUsername`) differs from its acct (`handle`). */
function bridged(overrides: Partial<NormalizedExternalActor> = {}): NormalizedExternalActor {
  return {
    network: 'activitypub',
    externalId: 'https://mastox.eu/users/WIRED',
    handle: 'wired@mastox.eu',
    federatedUsername: 'wired@x.com',
    instanceDomain: 'x.com',
    displayName: 'WIRED',
    ...overrides,
  };
}

/** An ordinary actor: identity and acct are the same value. */
function ordinary(): NormalizedExternalActor {
  return {
    network: 'activitypub',
    externalId: 'https://mastodon.social/users/grace',
    handle: 'grace@mastodon.social',
    federatedUsername: 'grace@mastodon.social',
    instanceDomain: 'mastodon.social',
  };
}

/** `FederatedActor.findOne(...).lean()` returning `row`. */
function findOneReturns(row: unknown) {
  mocks.actorFindOne.mockReturnValue({ lean: () => Promise.resolve(row) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveOxyExternalUser.mockResolvedValue('minted-user');
  findOneReturns(null);
});

describe('resolveFederatedActorIdentity — merging bridged duplicates', () => {
  it('adopts the Oxy user of the row that already holds the same bridged identity', async () => {
    findOneReturns({ uri: 'https://bird.makeup/users/wired', oxyUserId: 'existing-user' });

    await expect(resolveFederatedActorIdentity(bridged())).resolves.toBe('existing-user');
    // The decisive assertion: no SECOND identity is minted for the same person.
    expect(mocks.resolveOxyExternalUser).not.toHaveBeenCalled();
  });

  it('looks the owner up by the bridged identity, excluding the actor itself', async () => {
    findOneReturns(null);
    await resolveFederatedActorIdentity(bridged());

    expect(mocks.actorFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        networkAcct: 'wired@x.com',
        uri: { $ne: 'https://mastox.eu/users/WIRED' },
      }),
      expect.anything(),
    );
  });

  it('mints normally when no other row holds the identity yet', async () => {
    findOneReturns(null);

    await expect(resolveFederatedActorIdentity(bridged())).resolves.toBe('minted-user');
    expect(mocks.resolveOxyExternalUser).toHaveBeenCalledTimes(1);
  });

  it('ignores a matching row that has no Oxy user to adopt', async () => {
    findOneReturns({ uri: 'https://bird.makeup/users/wired', oxyUserId: null });

    await expect(resolveFederatedActorIdentity(bridged())).resolves.toBe('minted-user');
    expect(mocks.resolveOxyExternalUser).toHaveBeenCalledTimes(1);
  });

  it('records the merge, so an attribution decision is never silent', async () => {
    findOneReturns({ uri: 'https://bird.makeup/users/wired', oxyUserId: 'existing-user' });
    await resolveFederatedActorIdentity(bridged());

    // Identifiers belong in the structured payload, not the message — the backend
    // logging policy scanner enforces that, so assert the shape it requires.
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('adopting its Oxy user'),
      {
        actor: 'https://mastox.eu/users/WIRED',
        networkAcct: 'wired@x.com',
        owner: 'https://bird.makeup/users/wired',
      },
    );
  });
});

describe('resolveFederatedActorIdentity — what it leaves alone', () => {
  it('never looks for a duplicate for an ordinary federated actor', async () => {
    await expect(resolveFederatedActorIdentity(ordinary())).resolves.toBe('minted-user');

    // An acct is already unique per host, so there is nothing to merge — and a
    // lookup here would be a per-actor DB round trip on the whole federation
    // ingest path, for every actor, to answer a question that cannot be yes.
    expect(mocks.actorFindOne).not.toHaveBeenCalled();
    expect(mocks.resolveOxyExternalUser).toHaveBeenCalledTimes(1);
  });

  it('passes the avatar-refresh option through unchanged', async () => {
    await resolveFederatedActorIdentity(ordinary(), { forceAvatarRefresh: true });
    expect(mocks.resolveOxyExternalUser).toHaveBeenCalledWith(
      expect.anything(),
      { forceAvatarRefresh: true },
    );
  });

  it('still resolves the actor when the duplicate lookup itself fails', async () => {
    mocks.actorFindOne.mockReturnValue({ lean: () => Promise.reject(new Error('mongo down')) });

    // Losing the actor would be a worse outcome than the duplicate this merge
    // exists to prevent, so a failed lookup degrades to an ordinary resolve.
    await expect(resolveFederatedActorIdentity(bridged())).resolves.toBe('minted-user');
    expect(mocks.loggerWarn).toHaveBeenCalled();
  });
});
