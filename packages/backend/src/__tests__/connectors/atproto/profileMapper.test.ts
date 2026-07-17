import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getNormalizedUserHandle } from '@oxyhq/core';

/**
 * atproto profile mapping: `app.bsky.actor.getProfile` → normalized actor →
 * `FederatedActor` upsert (`protocol:'atproto'`) → Oxy identity resolution.
 * Verifies the no-orphan fail-soft contract: when Oxy cannot resolve the actor's
 * `did:` (oxy-api dependency), the actor returns WITHOUT an `oxyUserId` and never
 * throws.
 */

const mocks = vi.hoisted(() => ({
  xrpcGet: vi.fn(),
  findOneAndUpdate: vi.fn(),
  updateOne: vi.fn(),
  resolveOxyExternalUser: vi.fn(),
}));

vi.mock('../../../connectors/atproto/xrpcClient', () => ({ xrpcGet: mocks.xrpcGet }));

vi.mock('../../../models/FederatedActor', () => ({
  default: {
    findOneAndUpdate: mocks.findOneAndUpdate,
    updateOne: mocks.updateOne,
  },
}));

vi.mock('../../../connectors/identity', () => ({
  resolveOxyExternalUser: mocks.resolveOxyExternalUser,
}));

import {
  fetchAndUpsertAtprotoProfile,
  mapProfileToNormalizedActor,
  splitHandle,
} from '../../../connectors/atproto/profile.mapper';

const DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findOneAndUpdate.mockResolvedValue({ _id: 'fa1', oxyUserId: undefined });
  mocks.updateOne.mockResolvedValue({ modifiedCount: 1 });
  mocks.resolveOxyExternalUser.mockResolvedValue('oxy-alice');
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

  it('omits a whitespace-only display name and bio rather than storing blanks', () => {
    const actor = mapProfileToNormalizedActor({ ...PROFILE, displayName: '   \n ', description: '  \n\n ' });
    expect(actor?.displayName).toBeUndefined();
    expect(actor?.bio).toBeUndefined();
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
    // Upsert keyed on the DID, carrying protocol + uri (the DID) + handle acct.
    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      { uri: DID },
      expect.objectContaining({
        $set: expect.objectContaining({
          protocol: 'atproto',
          uri: DID,
          acct: 'alice.bsky.social',
          headerUrl: PROFILE.banner,
        }),
      }),
      expect.objectContaining({ upsert: true }),
    );
    // Oxy resolution is handed the canonical federated identity (`handle@domain`
    // username + instance domain) — the exact shape oxy-api's username↔domain
    // binding requires for a `did:` actor. Passing the bare handle here would
    // make `PUT /users/resolve` 400 → no oxyUserId → no posts and proxied media.
    expect(mocks.resolveOxyExternalUser).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: DID,
        federatedUsername: 'alice@bsky.social',
        instanceDomain: 'bsky.social',
        avatarUrl: PROFILE.avatar,
        bannerUrl: PROFILE.banner,
      }),
    );
    // Oxy user resolved + stamped (the upsert returned no prior oxyUserId).
    expect(mocks.updateOne).toHaveBeenCalledWith({ _id: 'fa1' }, { $set: { oxyUserId: 'oxy-alice' } });
    expect(actor?.oxyUserId).toBe('oxy-alice');
  });

  it('fails soft (no oxyUserId, no throw, no stamp) when Oxy cannot resolve the did:', async () => {
    mocks.xrpcGet.mockResolvedValue(PROFILE);
    mocks.resolveOxyExternalUser.mockResolvedValue(null);

    const actor = await fetchAndUpsertAtprotoProfile(DID);

    expect(actor).not.toBeNull();
    expect(actor?.oxyUserId).toBeUndefined();
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it('returns null when the profile cannot be fetched', async () => {
    mocks.xrpcGet.mockRejectedValue(new Error('not found'));
    const actor = await fetchAndUpsertAtprotoProfile('ghost.example');
    expect(actor).toBeNull();
  });
});
