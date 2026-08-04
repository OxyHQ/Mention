import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../../../utils/oxyHelpers', () => ({ getServiceOxyClient: vi.fn() }));
vi.mock('../../../services/userSummaryCache', () => ({ invalidate: vi.fn() }));
vi.mock('../../../services/mediaCache/cacheWorker', () => ({
  persistRemoteMediaForFederatedOwnerDetailed: vi.fn(),
}));
vi.mock('../../../db/userProfile/userSettingsRepository', () => ({ updateUserSettings: vi.fn() }));
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

import { inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { federatedActors } from '../../../db/schema/federation';
import {
  findActorByUri,
  setActorOxyUserId,
  upsertActor,
} from '../../../db/federation/actorRepository';
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

/**
 * The rows the merge looks across are REAL, because the two identity SHAPES are
 * the whole difficulty and neither survives a double.
 *
 * A bridged row carries the identity in `network_acct`; every other row's
 * identity IS `username@domain`, which is how the atproto connector stores a
 * Bluesky account without ever writing `network_acct`. The Mongo predicate
 * spelled the second as `{ networkAcct: { $exists: false } }` and the port has
 * to translate it to `is null` — a distinction a filter-shape assertion cannot
 * see, and which decides whether 10,066 natively-held rows are visible to the
 * merge at all.
 */
const seededUris: string[] = [];

async function seedActorRow(row: {
  uri: string;
  username: string;
  domain: string;
  networkAcct?: string;
  oxyUserId?: string | null;
}): Promise<void> {
  await upsertActor(
    row.uri,
    {
      protocol: row.uri.startsWith('did:') ? 'atproto' : 'activitypub',
      username: row.username,
      domain: row.domain,
      acct: `${row.username}@${row.domain}`,
      ...(row.networkAcct ? { networkAcct: row.networkAcct } : {}),
      type: 'Person',
      manuallyApprovesFollowers: false,
      discoverable: true,
      memorial: false,
      suspended: false,
      followersCount: 0,
      followingCount: 0,
      postsCount: 0,
      lastFetchedAt: new Date(),
    },
    [],
  );
  seededUris.push(row.uri);
  if (row.oxyUserId) {
    const stored = await findActorByUri(row.uri);
    if (stored) await setActorOxyUserId(stored.id, row.oxyUserId);
  }
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveOxyExternalUser.mockResolvedValue('minted-user');
});

afterEach(async () => {
  if (seededUris.length > 0) {
    await getDb().delete(federatedActors).where(inArray(federatedActors.uri, seededUris.splice(0)));
  }
});

describe('resolveFederatedActorIdentity — merging bridged duplicates', () => {
  it('adopts the Oxy user of the row that already holds the same bridged identity', async () => {
    await seedActorRow({
      uri: 'https://bird.makeup/users/wired',
      username: 'wired',
      domain: 'bird.makeup',
      networkAcct: 'wired@x.com',
      oxyUserId: 'existing-user',
    });

    await expect(resolveFederatedActorIdentity(bridged())).resolves.toBe('existing-user');
    // The decisive assertion: no SECOND identity is minted for the same person.
    expect(mocks.resolveOxyExternalUser).not.toHaveBeenCalled();
  });

  it('matches the OTHER identity shape too — a row with no network_acct', async () => {
    // The `is null` half of the predicate. A natively-held row stores its
    // identity as `username` + `domain` and carries no `network_acct`; matching
    // only the explicit column would miss every one of them, which is the
    // majority of the table.
    await seedActorRow({
      uri: 'https://bird.makeup/users/wired-native',
      username: 'wired',
      domain: 'x.com',
      oxyUserId: 'existing-user',
    });

    await expect(resolveFederatedActorIdentity(bridged())).resolves.toBe('existing-user');
    expect(mocks.resolveOxyExternalUser).not.toHaveBeenCalled();
  });

  it('never adopts from the actor ITSELF', async () => {
    // The row under resolution already holds an Oxy user; excluding it by uri is
    // what stops the merge answering with the identity it was asked to derive,
    // which would make the pass-through case indistinguishable from a merge.
    await seedActorRow({
      uri: 'https://mastox.eu/users/WIRED',
      username: 'wired',
      domain: 'mastox.eu',
      networkAcct: 'wired@x.com',
      oxyUserId: 'its-own-user',
    });

    await expect(resolveFederatedActorIdentity(bridged())).resolves.toBe('minted-user');
    expect(mocks.resolveOxyExternalUser).toHaveBeenCalledTimes(1);
  });

  it('mints normally when no other row holds the identity yet', async () => {
    await expect(resolveFederatedActorIdentity(bridged())).resolves.toBe('minted-user');
    expect(mocks.resolveOxyExternalUser).toHaveBeenCalledTimes(1);
  });

  it('ignores a matching row that has no Oxy user to adopt', async () => {
    await seedActorRow({
      uri: 'https://bird.makeup/users/wired',
      username: 'wired',
      domain: 'bird.makeup',
      networkAcct: 'wired@x.com',
    });

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
    await seedActorRow({
      uri: 'https://mastox.eu/users/someone-else',
      username: 'someone-else',
      domain: 'mastox.eu',
      networkAcct: 'wired@x.com',
      oxyUserId: 'existing-user',
    });

    await expect(resolveFederatedActorIdentity(bridged())).resolves.toBeNull();
    expect(mocks.resolveOxyExternalUser).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalled();
  });

  it('still merges across DIFFERENT bridge domains, which is the valid case', async () => {
    await seedActorRow({
      uri: 'https://bird.makeup/users/wired',
      username: 'wired',
      domain: 'bird.makeup',
      networkAcct: 'wired@x.com',
      oxyUserId: 'existing-user',
    });

    await expect(resolveFederatedActorIdentity(bridged())).resolves.toBe('existing-user');
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it('records the merge, so an attribution decision is never silent', async () => {
    await seedActorRow({
      uri: 'https://bird.makeup/users/wired',
      username: 'wired',
      domain: 'bird.makeup',
      networkAcct: 'wired@x.com',
      oxyUserId: 'existing-user',
    });
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
    expect(mocks.resolveOxyExternalUser).toHaveBeenCalledTimes(1);
  });

  it('passes the avatar-refresh option through unchanged', async () => {
    await resolveFederatedActorIdentity(ordinary(), { forceAvatarRefresh: true });
    expect(mocks.resolveOxyExternalUser).toHaveBeenCalledWith(
      expect.anything(),
      { forceAvatarRefresh: true },
    );
  });

  /**
   * NOT covered here: a duplicate lookup that THROWS.
   *
   * It degrades to an ordinary resolve — losing the actor would be a worse
   * outcome than the duplicate this merge exists to prevent — but staging a
   * failing query against a live database needs a hook that would itself be
   * fiction. The `catch` is one line above the `return resolveOxyExternalUser`
   * the pass-through cases already exercise.
   */
});

describe('resolveFederatedActorIdentity — the cross-PROTOCOL case', () => {
  /**
   * The largest duplicate population is not two bridges: it is one Bluesky
   * account held NATIVELY over atproto and AGAIN over ActivityPub through Bridgy
   * Fed. 79 of our 815 Bridgy actors are accounts we already hold. The native row
   * stores its identity as `username` + `domain` and carries no `networkAcct`, so
   * a merge that matched only `networkAcct` would never see it.
   */
  /**
   * The native row, as the atproto connector stores it: identity in `username` +
   * `domain`, and NO `network_acct`. That absence is the whole point — it is the
   * `is null` branch of the predicate, and the only thing that makes 10,066 rows
   * visible to the merge.
   */
  const seedNativeAtprotoRow = () => seedActorRow({
    uri: 'did:plc:codfx2epdduamfycuyi5fjpb',
    username: 'georgemonbiot',
    domain: 'bsky.social',
    oxyUserId: 'native-bluesky-user',
  });

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
    await seedNativeAtprotoRow();
    await expect(resolveFederatedActorIdentity(viaBridgy())).resolves.toBe('native-bluesky-user');
    expect(mocks.resolveOxyExternalUser).not.toHaveBeenCalled();
  });

  it('does not mistake the native row for a broken same-domain collision', async () => {
    // The native row's domain is `bsky.social`; the bridged actor arrived from
    // `bsky.brid.gy`. Different domains, so this is the VALID cross-source case
    // and the same-domain refusal must not fire.
    await seedNativeAtprotoRow();
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
    await seedActorRow({
      uri: 'did:plc:someone-else',
      username: 'georgemonbiot',
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
    await seedActorRow({
      uri: 'https://bsky.brid.gy/ap/did:plc:codfx2epdduamfycuyi5fjpb',
      username: 'georgemonbiot.bsky.social',
      domain: 'bsky.brid.gy',
      networkAcct: 'georgemonbiot@bsky.social',
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
