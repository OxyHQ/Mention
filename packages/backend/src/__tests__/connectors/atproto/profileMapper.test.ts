import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closePostgres, connectPostgres } from '../../../db/postgres';
import {
  clearFederationScope,
  federationScope,
  readActor,
} from '../../helpers/federationFixtures';

const scope = federationScope('atproto-profile-mapper');
import { getNormalizedUserHandle } from '@oxyhq/core';

/**
 * atproto profile mapping: `app.bsky.actor.getProfile` → normalized actor →
 * `federated_actors` upsert (`protocol:'atproto'`) → Oxy identity resolution.
 * Verifies the no-orphan fail-soft contract: when Oxy cannot resolve the actor's
 * `did:` (oxy-api dependency), the actor returns WITHOUT an `oxyUserId` and never
 * throws.
 */

const mocks = vi.hoisted(() => ({
  xrpcGet: vi.fn(),
  resolveFederatedActorIdentity: vi.fn(),
}));

vi.mock('../../../connectors/atproto/xrpcClient', () => ({ xrpcGet: mocks.xrpcGet }));

vi.mock('../../../connectors/identity', () => ({
  // The atproto path resolves through the shared MERGE, not straight at the
  // identity bridge: the same Bluesky account can also arrive over ActivityPub
  // through Bridgy Fed, and whichever lands second must adopt the first's Oxy
  // user rather than mint a twin.
  resolveFederatedActorIdentity: mocks.resolveFederatedActorIdentity,
}));

import {
  ACTOR_UPSERT_FAILED_METRIC,
  atprotoIdentityHandle,
  fetchAndUpsertAtprotoProfile,
  mapProfileToNormalizedActor,
  splitHandle,
} from '../../../connectors/atproto/profile.mapper';
import { metrics } from '../../../utils/metrics';

const DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
/**
 * A second, distinct DID whose handle is ALSO unresolved — the only fixture that
 * can see the constraint, since the first account of its kind never collides.
 */
const DID_TWO = 'did:plc:hcn5qmsrdmaiubq36lgy7ptm';

const PROFILE = {
  did: DID,
  handle: 'alice.bsky.social',
  displayName: 'Alice',
  description: 'hello from bluesky',
  avatar: 'https://cdn.bsky.app/img/avatar/plain/did/cid@jpeg',
  banner: 'https://cdn.bsky.app/img/banner/plain/did/cid@jpeg',
  followersCount: 12,
  followsCount: 7,
  postsCount: 99,
};

beforeEach(async () => {
  await clearFederationScope(scope, [DID, DID_TWO]);
  vi.clearAllMocks();
  mocks.resolveFederatedActorIdentity.mockResolvedValue('oxy-alice');
});

describe('mapProfileToNormalizedActor', () => {
  it('maps a getProfile response to the network-neutral actor shape', () => {
    const actor = mapProfileToNormalizedActor(PROFILE);
    expect(actor).toEqual({
      network: 'atproto',
      externalId: DID,
      handle: 'alice.bsky.social',
      // The canonical `local@domain` Oxy username: a default Bluesky handle drops its
      // redundant `.bsky.social` suffix (`alice.bsky.social` → `alice`) — the exact
      // value oxy-api's `PUT /users/resolve` binds for an atproto actor.
      federatedUsername: 'alice@bsky.social',
      instanceDomain: 'bsky.social',
      displayName: 'Alice',
      avatarUrl: PROFILE.avatar,
      bannerUrl: PROFILE.banner,
      bio: 'hello from bluesky',
      followersCount: 12,
      followingCount: 7,
      postsCount: 99,
    });
  });

  it('normalizes the display name to one line and the bio as a body', () => {
    // Bluesky profile text used to be stored with zero trimming. A display name
    // is one line (every break collapses); a bio is a body (the author's own
    // blank line survives, the noise around it does not).
    const actor = mapProfileToNormalizedActor({
      ...PROFILE,
      displayName: '  Alice\n  Cooper  ',
      description: '  línea uno   \r\n \r\n \r\n  línea dos  ',
    });
    expect(actor?.displayName).toBe('Alice Cooper');
    expect(actor?.bio).toBe('línea uno\n\nlínea dos');
  });

  it('omits a whitespace-only display name rather than storing a blank', () => {
    const actor = mapProfileToNormalizedActor({ ...PROFILE, displayName: '   \n ' });
    expect(actor?.displayName).toBeUndefined();
  });

  /**
   * An empty bio is an ANSWER, and the one shape that cannot be sent as an
   * omission.
   *
   * `PUT /users/resolve` writes `bio` only when the key is a string, and
   * `undefined` does not survive `JSON.stringify` — so an omitted bio means
   * "leave whatever you already have". For a field the author can DELETE that is
   * the wrong default: this used to send `undefined` for an emptied bio, and the
   * bio Oxy had stored on some earlier resolve stayed on the profile forever, no
   * matter how often the actor was re-resolved.
   */
  it.each([
    ['a bio the author cleared', ''],
    ['a bio that is only whitespace', '  \n\n '],
  ])('sends %s as an empty CLEAR, not as an omission', (_label, description) => {
    const actor = mapProfileToNormalizedActor({ ...PROFILE, description });

    expect(actor?.bio).toBe('');
    // Pin the wire shape, not just the value: the key has to survive JSON, which
    // is the whole difference between clearing the field and leaving it alone.
    expect(Object.keys(JSON.parse(JSON.stringify(actor)))).toContain('bio');
  });

  it('reads a profile carrying no description at all as an empty bio', () => {
    // `getProfile` omits `description` for an account that has never set one, and
    // for one that cleared it — Bluesky does not distinguish the two, so neither
    // can we. Empty is the honest reading of both: this account has no bio.
    const { description: _omitted, ...withoutBio } = PROFILE;
    expect(mapProfileToNormalizedActor(withoutBio)?.bio).toBe('');
  });

  // Every atproto handle keys to the Bluesky network host. A DEFAULT Bluesky handle
  // drops its redundant `.bsky.social` suffix from the username (so it renders
  // `@skylee1@bsky.social`, not the doubled `@skylee1.bsky.social@bsky.social`); a
  // CUSTOM domain keeps its whole handle as the username (`.bsky.team`/`.app`/apex
  // are NOT `.bsky.social`, so they are kept in full). The `handle` field always
  // preserves the actor's real atproto handle. Deriving the instance from the
  // handle's own parent domain was the original bug: `mayor.nyc.gov` rendered
  // `@mayor.nyc.gov@nyc.gov` instead of `@mayor.nyc.gov@bsky.social`.
  it.each([
    { handle: 'skylee1.bsky.social', username: 'skylee1', rendered: 'skylee1@bsky.social' },
    { handle: 'carnage4life.bsky.social', username: 'carnage4life', rendered: 'carnage4life@bsky.social' },
    { handle: 'gothamist.com', username: 'gothamist.com', rendered: 'gothamist.com@bsky.social' },
    { handle: 'mayor.nyc.gov', username: 'mayor.nyc.gov', rendered: 'mayor.nyc.gov@bsky.social' },
    { handle: 'jay.bsky.team', username: 'jay.bsky.team', rendered: 'jay.bsky.team@bsky.social' },
    { handle: 'bsky.app', username: 'bsky.app', rendered: 'bsky.app@bsky.social' },
  ])('keys handle $handle to $rendered on the Bluesky network host', ({ handle, username, rendered: expected }) => {
    const actor = mapProfileToNormalizedActor({ ...PROFILE, handle });
    // The `handle` field always preserves the real atproto handle (full DNS name).
    expect(actor?.handle).toBe(handle);
    expect(actor?.instanceDomain).toBe('bsky.social');
    // `federatedUsername` carries the stored `local@domain` — the exact rendered
    // handle, with a default handle's `.bsky.social` suffix already stripped.
    expect(actor?.federatedUsername).toBe(expected);

    // Rendering from the stored username + instance domain (the shape hydration
    // reads off the Oxy user) reproduces the same handle.
    const rendered = getNormalizedUserHandle({
      username,
      isFederated: true,
      federation: { domain: actor?.instanceDomain },
    });
    expect(rendered).toBe(expected);
    // The pre-fix doubled/bogus instance must never re-appear.
    expect(rendered).not.toBe(`${handle}@${handle}`);
  });

  it('returns null when did or handle is missing', () => {
    expect(mapProfileToNormalizedActor({ handle: 'a.b' })).toBeNull();
    expect(mapProfileToNormalizedActor({ did: DID })).toBeNull();
  });

  // `handle.invalid` is the AppView's ERROR STRING for a failed handle↔DID
  // verification, identical for every affected account — so it identifies
  // nobody, and every key derived from it collides.
  it('identifies an unresolved-handle actor by its DID, never by the sentinel', () => {
    const actor = mapProfileToNormalizedActor({ ...PROFILE, handle: 'handle.invalid' });
    expect(actor).toMatchObject({
      externalId: DID,
      handle: DID,
      // oxy-api's `normalizeFederatedResolveUsername` splits on the FIRST `@`, so
      // the DID's colons ride in the local part and the binding still resolves to
      // `bsky.social`.
      federatedUsername: `${DID}@bsky.social`,
      instanceDomain: 'bsky.social',
    });
    // The sentinel must not survive anywhere on the DTO — a copy left in one
    // field is a copy some future derivation reads.
    expect(JSON.stringify(actor)).not.toContain('handle.invalid');
  });

  it('leaves a real handle alone (the substitution is not a blanket rewrite)', () => {
    expect(mapProfileToNormalizedActor(PROFILE)?.handle).toBe('alice.bsky.social');
    expect(atprotoIdentityHandle('alice.bsky.social', DID)).toBe('alice.bsky.social');
    // Case and surrounding space are the same failed verification, so they are
    // the same sentinel.
    expect(atprotoIdentityHandle('Handle.Invalid', DID)).toBe(DID);
    expect(atprotoIdentityHandle(' handle.invalid ', DID)).toBe(DID);
  });
});

describe('splitHandle', () => {
  // The instance domain for an atproto actor is ALWAYS the Bluesky network domain.
  // A DEFAULT Bluesky handle drops its redundant `.bsky.social` suffix from the
  // username; a CUSTOM domain (apex, `.bsky.team`, `.app`, or multi-label) keeps its
  // whole handle. These are the exact prod actors the old derivations mis-rendered.
  it.each([
    { handle: 'skylee1.bsky.social', username: 'skylee1' },
    { handle: 'carnage4life.bsky.social', username: 'carnage4life' },
    { handle: 'mayor.nyc.gov', username: 'mayor.nyc.gov' },
    { handle: 'gothamist.com', username: 'gothamist.com' },
    { handle: 'jay.bsky.team', username: 'jay.bsky.team' },
    { handle: 'bsky.app', username: 'bsky.app' },
  ])('derives $handle → username $username on the Bluesky network host', ({ handle, username }) => {
    expect(splitHandle(handle)).toEqual({
      username,
      domain: 'bsky.social',
      federatedUsername: `${username}@bsky.social`,
    });
  });

  // Guard the degenerate case: the bare network domain would strip to an empty
  // username, so it is kept whole.
  it('keeps the bare network domain whole rather than stripping to an empty username', () => {
    expect(splitHandle('bsky.social')).toEqual({
      username: 'bsky.social',
      domain: 'bsky.social',
      federatedUsername: 'bsky.social@bsky.social',
    });
  });
});

describe('fetchAndUpsertAtprotoProfile', () => {
  it('upserts the FederatedActor (atproto) and stamps the resolved Oxy user', async () => {
    mocks.xrpcGet.mockResolvedValue(PROFILE);

    const actor = await fetchAndUpsertAtprotoProfile(DID);

    expect(mocks.xrpcGet).toHaveBeenCalledWith('public.api.bsky.app', 'app.bsky.actor.getProfile', { actor: DID });
    // The ROW is keyed on the DID and carries protocol + acct + banner.
    const stored = await readActor(DID);
    expect(stored).toMatchObject({
      protocol: 'atproto',
      uri: DID,
      acct: 'alice.bsky.social',
      headerUrl: PROFILE.banner,
    });
    // Oxy resolution is handed the canonical federated identity (`handle@domain`
    // username + instance domain) — the exact shape oxy-api's username↔domain
    // binding requires for a `did:` actor. Passing the bare handle here would
    // make `PUT /users/resolve` 400 → no oxyUserId → no posts and proxied media.
    expect(mocks.resolveFederatedActorIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: DID,
        federatedUsername: 'alice@bsky.social',
        instanceDomain: 'bsky.social',
        avatarUrl: PROFILE.avatar,
        bannerUrl: PROFILE.banner,
      }),
    );
    // Oxy user resolved + stamped ON THE ROW (the upsert carried no prior one).
    expect((await readActor(DID))?.oxyUserId).toBe('oxy-alice');
    expect(actor?.oxyUserId).toBe('oxy-alice');
  });

  it('fails soft (no oxyUserId, no throw, no stamp) when Oxy cannot resolve the did:', async () => {
    await clearFederationScope(scope, [DID]);
    mocks.xrpcGet.mockResolvedValue(PROFILE);
    mocks.resolveFederatedActorIdentity.mockResolvedValue(null);

    const actor = await fetchAndUpsertAtprotoProfile(DID);

    expect(actor).not.toBeNull();
    expect(actor?.oxyUserId).toBeUndefined();
    expect((await readActor(DID))?.oxyUserId).toBeUndefined();
  });

  it('returns null when the profile cannot be fetched', async () => {
    mocks.xrpcGet.mockRejectedValue(new Error('not found'));
    const actor = await fetchAndUpsertAtprotoProfile('ghost.example');
    expect(actor).toBeNull();
  });

  /**
   * The SECOND unresolved-handle account is the whole test.
   *
   * The first always succeeds — there is nothing for it to collide with — so a
   * single-account fixture passes with the bug fully present and proves nothing.
   * `federated_actors_acct_key` and `federated_actors_domain_username_key` only
   * fire on the second, and this is what they used to do to it: `upsertActor`
   * raises, `upsertAtprotoActor` catches, `fedActor` stays null, no row is
   * written, no `oxyUserId` is stamped, and the no-orphan rule then drops every
   * post that account ever made — at `warn`, from a detached ingest path.
   *
   * Production held 21 rows sharing `acct: 'handle.invalid'`, written in one
   * 38-minute window on 2026-07-17 while Mongo had no unique index to refuse
   * them. Under the Postgres constraints, 20 of those 21 accounts would simply
   * not exist.
   */
  it('stores a SECOND unresolved-handle account rather than losing it to the acct constraint', async () => {
    await clearFederationScope(scope, [DID, DID_TWO]);
    metrics.reset();

    mocks.resolveFederatedActorIdentity.mockImplementation(
      (actor: { externalId: string }) => Promise.resolve(`oxy-${actor.externalId}`),
    );

    mocks.xrpcGet.mockResolvedValue({ ...PROFILE, did: DID, handle: 'handle.invalid' });
    const first = await fetchAndUpsertAtprotoProfile(DID);
    mocks.xrpcGet.mockResolvedValue({ ...PROFILE, did: DID_TWO, handle: 'handle.invalid' });
    const second = await fetchAndUpsertAtprotoProfile(DID_TWO);

    // FIRST, and on its own line, the claim this test exists for: the second
    // account EXISTS. Asserted before anything about its columns, because with
    // the sentinel restored the row is simply absent and an assertion about its
    // `acct` would fail one step too early — reporting a wrong value where the
    // actual defect is a missing account, which is a different and much smaller
    // bug than the one being guarded.
    const secondRow = await readActor(DID_TWO);
    expect(secondRow, 'the second unresolved-handle account was not stored at all').not.toBeNull();

    // Both rows are keyed on their own DID — the identity that is actually
    // unique — and neither carries the sentinel.
    expect(await readActor(DID)).toMatchObject({ protocol: 'atproto', acct: DID, username: DID });
    expect(secondRow).toMatchObject({ protocol: 'atproto', acct: DID_TWO, username: DID_TWO });

    // Both resolve an Oxy user. Half a fix would stop here: Oxy's own unique
    // username index refuses a second `handle.invalid@bsky.social` just as the
    // acct constraint does, so the two must reach oxy-api under DISTINCT
    // federated usernames or the account is still unmintable. In production only
    // 1 of the 21 ever got an `oxyUserId`, which is that half failing.
    expect(await readActor(DID)).toMatchObject({ oxyUserId: `oxy-${DID}` });
    expect(await readActor(DID_TWO)).toMatchObject({ oxyUserId: `oxy-${DID_TWO}` });
    expect(second?.oxyUserId).toBe(`oxy-${DID_TWO}`);
    expect(first?.oxyUserId).toBe(`oxy-${DID}`);
    expect(mocks.resolveFederatedActorIdentity.mock.calls.map(([a]) => a.federatedUsername)).toEqual([
      `${DID}@bsky.social`,
      `${DID_TWO}@bsky.social`,
    ]);

    // And nothing was swallowed on the way. Asserted rather than assumed,
    // because a row can also go missing without an exception — this separates
    // "the constraint refused it" from "the write never happened".
    expect(metrics.getCounter(ACTOR_UPSERT_FAILED_METRIC, { protocol: 'atproto', reason: 'federated_actors_acct_key' })).toBe(0);
  });
});

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await clearFederationScope(scope, [DID, DID_TWO]);
});

afterAll(async () => {
  await closePostgres();
});
