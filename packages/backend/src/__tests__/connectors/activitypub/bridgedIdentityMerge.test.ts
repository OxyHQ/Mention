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
  loggerError: vi.fn(),
}));

vi.mock('../../../models/FederatedActor', () => ({
  default: { findOne: mocks.actorFindOne },
  FederatedActor: { findOne: mocks.actorFindOne },
}));

vi.mock('../../../utils/oxyHelpers', () => ({ getServiceOxyClient: vi.fn() }));
vi.mock('../../../services/userSummaryCache', () => ({ invalidate: vi.fn() }));
vi.mock('../../../services/mediaCache/cacheWorker', () => ({
  persistRemoteMediaForFederatedOwnerDetailed: vi.fn(),
}));
vi.mock('../../../models/UserSettings', () => ({ default: { updateOne: vi.fn() } }));
vi.mock('@oxyhq/federation/node', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createIdentityBridge: () => ({
    resolveExternalUser: mocks.resolveOxyExternalUser,
    reportActorGone: mocks.reportFederatedActorGone,
    deleteActorIdentity: vi.fn(),
  }),
}));

vi.mock('../../../utils/logger', () => ({
  logger: { info: mocks.loggerInfo, warn: mocks.loggerWarn, error: mocks.loggerError, debug: vi.fn() },
}));

import { resolveFederatedActorIdentity } from '../../../connectors/identity';
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
    findOneReturns({ uri: 'https://bird.makeup/users/wired', domain: 'bird.makeup', oxyUserId: 'existing-user' });

    await expect(resolveFederatedActorIdentity(bridged())).resolves.toBe('existing-user');
    // The decisive assertion: no SECOND identity is minted for the same person.
    expect(mocks.resolveOxyExternalUser).not.toHaveBeenCalled();
  });

  it('looks the owner up by the bridged identity, excluding the actor itself', async () => {
    findOneReturns(null);
    await resolveFederatedActorIdentity(bridged());

    expect(mocks.actorFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        uri: { $ne: 'https://mastox.eu/users/WIRED' },
        // BOTH identity shapes: a bridged row carries `networkAcct`, while every
        // other row's identity is `username@domain` — which is how the atproto
        // connector stores a Bluesky account. Matching only the first would miss
        // every natively-held account.
        $or: [
          { networkAcct: 'wired@x.com' },
          { networkAcct: { $exists: false }, username: 'wired', domain: 'x.com' },
        ],
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
    findOneReturns({ uri: 'https://bird.makeup/users/wired', domain: 'bird.makeup', oxyUserId: null });

    await expect(resolveFederatedActorIdentity(bridged())).resolves.toBe('minted-user');
    expect(mocks.resolveOxyExternalUser).toHaveBeenCalledTimes(1);
  });

  /**
   * A valid within-network collision has EXACTLY ONE actor per bridge domain: a
   * bridge holds one actor per upstream handle, so two actors on the same domain
   * deriving to one identity is impossible under a correct rule. It means the
   * derivation is broken — most likely returning a constant — and merging on it
   * would collapse every actor on that domain onto one person. The cheapest
   * guard against the worst outcome.
   */
  it('refuses outright when the colliding row is on the SAME bridge domain', async () => {
    findOneReturns({
      uri: 'https://mastox.eu/users/someone-else',
      domain: 'mastox.eu',
      oxyUserId: 'existing-user',
    });

    await expect(resolveFederatedActorIdentity(bridged())).resolves.toBeNull();
    expect(mocks.resolveOxyExternalUser).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalled();
  });

  it('still merges across DIFFERENT bridge domains, which is the valid case', async () => {
    findOneReturns({
      uri: 'https://bird.makeup/users/wired',
      domain: 'bird.makeup',
      oxyUserId: 'existing-user',
    });

    await expect(resolveFederatedActorIdentity(bridged())).resolves.toBe('existing-user');
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it('records the merge, so an attribution decision is never silent', async () => {
    findOneReturns({ uri: 'https://bird.makeup/users/wired', domain: 'bird.makeup', oxyUserId: 'existing-user' });
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

describe('resolveFederatedActorIdentity — the cross-PROTOCOL case', () => {
  /**
   * The largest duplicate population is not two bridges: it is one Bluesky
   * account held NATIVELY over atproto and AGAIN over ActivityPub through Bridgy
   * Fed. 79 of our 815 Bridgy actors are accounts we already hold. The native row
   * stores its identity as `username` + `domain` and carries no `networkAcct`, so
   * a merge that matched only `networkAcct` would never see it.
   */
  const nativeAtprotoRow = {
    uri: 'did:plc:codfx2epdduamfycuyi5fjpb',
    domain: 'bsky.social',
    oxyUserId: 'native-bluesky-user',
  };

  /** The same account arriving over ActivityPub through Bridgy Fed. */
  function viaBridgy(): NormalizedExternalActor {
    return {
      network: 'activitypub',
      externalId: 'https://bsky.brid.gy/ap/did:plc:codfx2epdduamfycuyi5fjpb',
      handle: 'georgemonbiot.bsky.social@bsky.brid.gy',
      federatedUsername: 'georgemonbiot@bsky.social',
      instanceDomain: 'bsky.social',
    };
  }

  it('adopts the natively-held account rather than minting a Bluesky twin', async () => {
    findOneReturns(nativeAtprotoRow);
    await expect(resolveFederatedActorIdentity(viaBridgy())).resolves.toBe('native-bluesky-user');
    expect(mocks.resolveOxyExternalUser).not.toHaveBeenCalled();
  });

  it('does not mistake the native row for a broken same-domain collision', async () => {
    // The native row's domain is `bsky.social`; the bridged actor arrived from
    // `bsky.brid.gy`. Different domains, so this is the VALID cross-source case
    // and the same-domain refusal must not fire.
    findOneReturns(nativeAtprotoRow);
    await resolveFederatedActorIdentity(viaBridgy());
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it('fires the same-domain refusal for two NATIVE atproto rows', async () => {
    // The positive direction, which the cross-source tests do not cover. An
    // atproto handle carries no `@`, so reading the source domain off the handle
    // left this guard permanently inert on that path — `georgemonbiot.bsky.social`
    // could never equal a stored `bsky.social`. Two native rows resolving to one
    // identity means the handle rule is broken, and merging them would attribute
    // one person's posts to another.
    findOneReturns({
      uri: 'did:plc:someone-else',
      domain: 'bsky.social',
      oxyUserId: 'other-user',
    });
    await expect(resolveFederatedActorIdentity({
      network: 'atproto',
      externalId: 'did:plc:codfx2epdduamfycuyi5fjpb',
      handle: 'georgemonbiot.bsky.social',
      federatedUsername: 'georgemonbiot@bsky.social',
      instanceDomain: 'bsky.social',
    })).resolves.toBeNull();
    expect(mocks.resolveOxyExternalUser).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalled();
  });

  it('merges in the other direction too, so arrival order cannot matter', async () => {
    // A Bluesky actor coming in over atproto, when the Bridgy copy landed first.
    findOneReturns({
      uri: 'https://bsky.brid.gy/ap/did:plc:codfx2epdduamfycuyi5fjpb',
      domain: 'bsky.brid.gy',
      oxyUserId: 'bridged-user',
    });
    await expect(resolveFederatedActorIdentity({
      network: 'atproto',
      externalId: 'did:plc:codfx2epdduamfycuyi5fjpb',
      handle: 'georgemonbiot.bsky.social',
      federatedUsername: 'georgemonbiot@bsky.social',
      instanceDomain: 'bsky.social',
    })).resolves.toBe('bridged-user');
    expect(mocks.resolveOxyExternalUser).not.toHaveBeenCalled();
  });
});
