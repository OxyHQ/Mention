import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ONE PERSON, TWO NETWORKS — AGAINST A REAL DATABASE.
 *
 * The pure tests beside this one decide what counts as evidence. This one
 * decides what actually happens to an identity, over the two tables the claims
 * live in and the actor rows the merge looks across — because the failure this
 * layer risks is not a wrong verdict, it is a right verdict applied to the wrong
 * row. Handle equality must move nothing, ever; a proven pair must converge from
 * either arrival order; a released handle must not inherit its predecessor's
 * counterpart; and an identity that already minted its own Oxy user must not be
 * silently re-pointed away from the follows and moderation records attached to
 * it.
 *
 * Only the Oxy side is stubbed. The policy, the claim reader, the evaluator and
 * every query are the real ones.
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
vi.mock('@oxy.so/federation/node', async (importOriginal) => ({
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
import {
  federatedActors,
  federatedIdentityClaims,
  federatedIdentityLinks,
} from '../../../db/schema/federation';
import {
  findActorByUri,
  setActorOxyUserId,
  upsertActor,
} from '../../../db/federation/actorRepository';
import {
  findIdentityLink,
  loadIdentityLinkEvidence,
} from '../../../db/federation/identityEquivalenceRepository';
import { resolveFederatedActorIdentity } from '../../../connectors/identity';
import type { NormalizedExternalActor } from '@oxy.so/federation';

const IG_URI = 'https://kilogram.makeup/users/zuck';
const THREADS_URI = 'https://threads.net/ap/users/17841401746480004/';
const IG = 'zuck@instagram.com';
const THREADS = 'zuck@threads.net';

/** A verified `rel="me"` profile field, as the actor cache stores one. */
function verifiedLink(href: string): { name: string; value: string; verifiedAt: Date } {
  return {
    name: 'Link',
    value: `<a href="${href}" rel="me nofollow noopener noreferrer">${href}</a>`,
    verifiedAt: new Date('2026-09-01T00:00:00.000Z'),
  };
}

const seededUris: string[] = [];

/**
 * Seed one actor row the way the ingest would leave it.
 *
 * A BRIDGED Instagram actor carries its identity in `network_acct` while its
 * acct still addresses the bridge; a NATIVE Threads actor's identity IS its
 * acct. Both shapes are seeded for real, because the layer has to reach across
 * exactly that difference and neither survives a stand-in.
 */
async function seedActor(row: {
  uri: string;
  username: string;
  domain: string;
  networkAcct?: string;
  alsoKnownAs?: string[];
  fields?: { name: string; value: string; verifiedAt?: Date }[];
  oxyUserId?: string;
}): Promise<void> {
  await upsertActor(
    row.uri,
    {
      protocol: 'activitypub',
      username: row.username,
      domain: row.domain,
      acct: `${row.username}@${row.domain}`,
      ...(row.networkAcct ? { networkAcct: row.networkAcct } : {}),
      ...(row.alsoKnownAs ? { alsoKnownAs: row.alsoKnownAs } : {}),
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
    row.fields ?? [],
  );
  seededUris.push(row.uri);
  if (row.oxyUserId) {
    const stored = await findActorByUri(row.uri);
    if (stored) await setActorOxyUserId(stored.id, row.oxyUserId);
  }
}

/** The normalized actor the resolver hands to the identity bridge. */
function normalized(over: Partial<NormalizedExternalActor> = {}): NormalizedExternalActor {
  return {
    network: 'activitypub',
    externalId: IG_URI,
    handle: 'zuck@kilogram.makeup',
    federatedUsername: IG,
    instanceDomain: 'instagram.com',
    ...over,
  };
}

/** Seed the Instagram side of a mutually-asserting pair. */
async function seedInstagramAsserting(opts: { oxyUserId?: string } = {}): Promise<void> {
  await seedActor({
    uri: IG_URI,
    username: 'zuck',
    domain: 'kilogram.makeup',
    networkAcct: IG,
    alsoKnownAs: ['https://www.threads.net/@zuck'],
    ...opts,
  });
}

/** Seed the Threads side of a mutually-asserting pair. */
async function seedThreadsAsserting(opts: { oxyUserId?: string } = {}): Promise<void> {
  await seedActor({
    uri: THREADS_URI,
    username: 'zuck',
    domain: 'threads.net',
    fields: [verifiedLink('https://www.instagram.com/zuck')],
    ...opts,
  });
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.resolveOxyExternalUser.mockResolvedValue('minted-user');
  await getDb().delete(federatedIdentityClaims);
  await getDb().delete(federatedIdentityLinks);
});

afterEach(async () => {
  if (seededUris.length > 0) {
    await getDb().delete(federatedActors).where(inArray(federatedActors.uri, seededUris.splice(0)));
  }
  await getDb().delete(federatedIdentityClaims);
  await getDb().delete(federatedIdentityLinks);
});

describe('a verified Instagram + Threads pair', () => {
  it('shares the Threads side\'s Oxy user once both assert each other', async () => {
    await seedThreadsAsserting({ oxyUserId: 'oxy-zuck' });
    await seedInstagramAsserting();

    // The Threads side is resolved first so its claims are on record, which is
    // what the Instagram side then corroborates.
    await resolveFederatedActorIdentity(
      normalized({ externalId: THREADS_URI, handle: THREADS, federatedUsername: THREADS, instanceDomain: 'threads.net' }),
    );

    await expect(resolveFederatedActorIdentity(normalized())).resolves.toBe('oxy-zuck');
    expect(mocks.resolveOxyExternalUser).not.toHaveBeenCalledWith(
      expect.objectContaining({ externalId: IG_URI }),
      undefined,
    );
  });

  it('converges from the other arrival order too', async () => {
    await seedInstagramAsserting({ oxyUserId: 'oxy-zuck' });
    await seedThreadsAsserting();

    await resolveFederatedActorIdentity(normalized());

    await expect(
      resolveFederatedActorIdentity(
        normalized({ externalId: THREADS_URI, handle: THREADS, federatedUsername: THREADS, instanceDomain: 'threads.net' }),
      ),
    ).resolves.toBe('oxy-zuck');
  });

  it('records the link, its reason and the evidence that carried it', async () => {
    await seedThreadsAsserting({ oxyUserId: 'oxy-zuck' });
    await seedInstagramAsserting();
    await resolveFederatedActorIdentity(
      normalized({ externalId: THREADS_URI, handle: THREADS, federatedUsername: THREADS, instanceDomain: 'threads.net' }),
    );
    await resolveFederatedActorIdentity(normalized());

    const link = await findIdentityLink(THREADS, IG);
    expect(link).toMatchObject({
      identityA: IG,
      identityB: THREADS,
      status: 'linked',
      oxyUserId: 'oxy-zuck',
      reason: 'bidirectional-assertion',
    });

    // "Why are these two accounts one person?" has to be answerable from stored
    // rows alone, months later, without re-fetching either actor.
    const evidence = await loadIdentityLinkEvidence(link!.id);
    expect(evidence.map((claim) => `${claim.subject}->${claim.target}`).sort()).toEqual([
      'zuck@instagram.com->zuck@threads.net',
      'zuck@threads.net->zuck@instagram.com',
    ]);
  });

  it('leaves BOTH source actors addressable under their own identities', async () => {
    await seedThreadsAsserting({ oxyUserId: 'oxy-zuck' });
    await seedInstagramAsserting();
    await resolveFederatedActorIdentity(
      normalized({ externalId: THREADS_URI, handle: THREADS, federatedUsername: THREADS, instanceDomain: 'threads.net' }),
    );
    await resolveFederatedActorIdentity(normalized());

    // Only `oxy_user_id` is shared. Nothing is rewritten and nothing is deleted,
    // which is what keeps the link withdrawable.
    expect(await findActorByUri(IG_URI)).toMatchObject({
      acct: 'zuck@kilogram.makeup',
      domain: 'kilogram.makeup',
      networkAcct: IG,
    });
    expect(await findActorByUri(THREADS_URI)).toMatchObject({
      acct: THREADS,
      domain: 'threads.net',
    });
  });
});

describe('what must never merge', () => {
  it('refuses the same handle on both networks when NEITHER asserts anything', async () => {
    await seedActor({ uri: THREADS_URI, username: 'zuck', domain: 'threads.net', oxyUserId: 'oxy-threads' });
    await seedActor({
      uri: IG_URI,
      username: 'zuck',
      domain: 'kilogram.makeup',
      networkAcct: IG,
    });

    await expect(resolveFederatedActorIdentity(normalized())).resolves.toBe('minted-user');
    expect(await findIdentityLink(IG, THREADS)).toBeNull();
  });

  it('refuses a ONE-WAY assertion, which is the shape anybody can publish', async () => {
    await seedActor({ uri: THREADS_URI, username: 'zuck', domain: 'threads.net', oxyUserId: 'oxy-threads' });
    await seedInstagramAsserting();
    await resolveFederatedActorIdentity(
      normalized({ externalId: THREADS_URI, handle: THREADS, federatedUsername: THREADS, instanceDomain: 'threads.net' }),
    );

    await expect(resolveFederatedActorIdentity(normalized())).resolves.toBe('minted-user');
    expect(await findIdentityLink(IG, THREADS)).toBeNull();
  });

  it('refuses Instagram + X, however loudly both sides assert each other', async () => {
    const X_URI = 'https://bird.makeup/users/zuck';
    await seedActor({
      uri: X_URI,
      username: 'zuck',
      domain: 'bird.makeup',
      networkAcct: 'zuck@x.com',
      alsoKnownAs: ['https://www.instagram.com/zuck'],
      oxyUserId: 'oxy-x',
    });
    await seedActor({
      uri: IG_URI,
      username: 'zuck',
      domain: 'kilogram.makeup',
      networkAcct: IG,
      alsoKnownAs: ['https://x.com/zuck'],
    });

    await resolveFederatedActorIdentity(
      normalized({ externalId: X_URI, handle: 'zuck@bird.makeup', federatedUsername: 'zuck@x.com', instanceDomain: 'x.com' }),
    );

    await expect(resolveFederatedActorIdentity(normalized())).resolves.toBe('minted-user');
    expect(await findIdentityLink(IG, 'zuck@x.com')).toBeNull();
  });

  it('never looks at an actor on a network no reviewed pair mentions', async () => {
    await seedActor({
      uri: 'https://mastodon.social/users/grace',
      username: 'grace',
      domain: 'mastodon.social',
      alsoKnownAs: ['https://www.threads.net/@grace'],
    });

    await resolveFederatedActorIdentity(
      normalized({
        externalId: 'https://mastodon.social/users/grace',
        handle: 'grace@mastodon.social',
        federatedUsername: 'grace@mastodon.social',
        instanceDomain: 'mastodon.social',
      }),
    );

    // Not merely "did not merge": the actor never reached the claim tables at
    // all, which is the gate that keeps this layer off every ordinary actor.
    expect(await getDb().select().from(federatedIdentityClaims)).toEqual([]);
  });
});

describe('reversal', () => {
  it('withdraws the link when one side stops asserting the other', async () => {
    await seedThreadsAsserting({ oxyUserId: 'oxy-zuck' });
    await seedInstagramAsserting();
    await resolveFederatedActorIdentity(
      normalized({ externalId: THREADS_URI, handle: THREADS, federatedUsername: THREADS, instanceDomain: 'threads.net' }),
    );
    await resolveFederatedActorIdentity(normalized());
    expect(await findIdentityLink(IG, THREADS)).toMatchObject({ status: 'linked' });

    // The Instagram account drops the alias. The pass that re-reads its claims
    // is the pass that takes the link down — no separate sweep.
    await seedActor({
      uri: IG_URI,
      username: 'zuck',
      domain: 'kilogram.makeup',
      networkAcct: IG,
      alsoKnownAs: [],
    });
    await resolveFederatedActorIdentity(normalized());

    const link = await findIdentityLink(IG, THREADS);
    expect(link).toMatchObject({ status: 'revoked', revokedReason: 'evidence-withdrawn' });
    // The row survives, and so does the answer to "why were these two ever one
    // person?" — which is the question a revocation makes somebody ask.
    expect(await loadIdentityLinkEvidence(link!.id)).not.toHaveLength(0);
  });

  it('stops adopting the counterpart the moment the evidence is gone', async () => {
    await seedThreadsAsserting({ oxyUserId: 'oxy-zuck' });
    await seedInstagramAsserting();
    await resolveFederatedActorIdentity(
      normalized({ externalId: THREADS_URI, handle: THREADS, federatedUsername: THREADS, instanceDomain: 'threads.net' }),
    );
    await resolveFederatedActorIdentity(normalized());

    await seedActor({ uri: IG_URI, username: 'zuck', domain: 'kilogram.makeup', networkAcct: IG });
    await expect(resolveFederatedActorIdentity(normalized())).resolves.toBe('minted-user');
  });

  /**
   * Instagram releases abandoned handles. The next owner of `zuck` publishes
   * their own actor, which asserts nothing about the previous owner's Threads
   * account — so the link has to go, and the adoption with it. This is why the
   * verdict is recomputed from currently-published claims every time and never
   * read back off the link row.
   */
  it('does not let a recycled handle inherit its predecessor\'s counterpart', async () => {
    await seedThreadsAsserting({ oxyUserId: 'oxy-zuck' });
    await seedInstagramAsserting();
    await resolveFederatedActorIdentity(
      normalized({ externalId: THREADS_URI, handle: THREADS, federatedUsername: THREADS, instanceDomain: 'threads.net' }),
    );
    await resolveFederatedActorIdentity(normalized());
    expect(await findIdentityLink(IG, THREADS)).toMatchObject({ status: 'linked' });

    // Same handle, same bridge URI, different person — the residual the policy
    // records as `handleStability: 'recyclable'`.
    await seedActor({
      uri: IG_URI,
      username: 'zuck',
      domain: 'kilogram.makeup',
      networkAcct: IG,
      alsoKnownAs: ['https://www.threads.net/@someoneelse'],
    });

    await expect(resolveFederatedActorIdentity(normalized())).resolves.toBe('minted-user');
    expect(await findIdentityLink(IG, THREADS)).toMatchObject({ status: 'revoked' });
  });
});

describe('an identity that already minted its own Oxy user', () => {
  it('is recorded for reconciliation rather than silently re-pointed', async () => {
    await seedThreadsAsserting({ oxyUserId: 'oxy-threads' });
    await seedInstagramAsserting({ oxyUserId: 'oxy-instagram' });
    await resolveFederatedActorIdentity(
      normalized({ externalId: THREADS_URI, handle: THREADS, federatedUsername: THREADS, instanceDomain: 'threads.net' }),
    );

    // Not 'oxy-threads': re-pointing would strand the follows, blocks and
    // moderation records already attached to `oxy-instagram`.
    await expect(resolveFederatedActorIdentity(normalized())).resolves.toBe('minted-user');
    expect(await findIdentityLink(IG, THREADS)).toMatchObject({
      status: 'pending_reconciliation',
      oxyUserId: undefined,
      reason: 'bidirectional-assertion',
    });
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('provably one person'),
      expect.objectContaining({ counterpart: THREADS }),
    );
  });
});
