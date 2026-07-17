import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Network-neutral identity bridge (`resolveOxyExternalUser`) — asserts the EXACT
 * `PUT /users/resolve` body sent to oxy-api for each protocol.
 *
 * Regression guard: oxy-api binds the federated `username` to `domain` (the
 * username domain after `@` MUST equal `domain`) and requires a `local@domain`
 * username. A Bluesky actor's bare DNS handle (`alice.bsky.social`) is NOT a
 * valid federated username — sending it (and a guessed domain) made
 * `PUT /users/resolve` 400, so the actor never resolved to an Oxy user, no posts
 * imported, and the only media that ever surfaced was hot-loaded through
 * `/media/proxy`. The connector now supplies the canonical `federatedUsername`
 * (`<handle>@<instance-domain>`) and `instanceDomain`, which this bridge passes
 * through verbatim.
 */

const mocks = vi.hoisted(() => ({
  makeServiceRequest: vi.fn(),
  persistRemoteMedia: vi.fn(),
  userSettingsUpdateOne: vi.fn(),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    makeServiceRequest: mocks.makeServiceRequest,
  }),
}));

vi.mock('../../services/mediaCache/cacheWorker', () => ({
  persistRemoteMediaForFederatedOwnerDetailed: mocks.persistRemoteMedia,
}));

vi.mock('../../models/UserSettings', () => ({
  default: {
    updateOne: mocks.userSettingsUpdateOne,
  },
}));

import {
  deleteFederatedActorIdentity,
  reportFederatedActorGone,
  resolveOxyExternalUser,
} from '../../connectors/identity';
import type { NormalizedExternalActor } from '../../connectors/types';

/** Build an HTTP-style rejection carrying the flat `.status` shape `getErrorStatus` reads. */
function httpError(status: number, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { status });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.makeServiceRequest.mockResolvedValue({ _id: 'oxy-resolved' });
  mocks.persistRemoteMedia.mockResolvedValue({ ok: false, permanent: false, reason: 'disabled' });
  mocks.userSettingsUpdateOne.mockResolvedValue({ acknowledged: true });
});

describe('resolveOxyExternalUser', () => {
  it('sends the canonical handle@domain username + instance domain for an atproto (did:) actor', async () => {
    const actor: NormalizedExternalActor = {
      network: 'atproto',
      externalId: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz',
      handle: 'alice.bsky.social',
      federatedUsername: 'alice.bsky.social@bsky.social',
      instanceDomain: 'bsky.social',
      displayName: 'Alice',
      avatarUrl: 'https://cdn.bsky.app/img/avatar/plain/did/cid@jpeg',
      bio: 'hello from bluesky',
    };

    const oxyId = await resolveOxyExternalUser(actor);

    expect(oxyId).toBe('oxy-resolved');
    expect(mocks.makeServiceRequest).toHaveBeenCalledWith('PUT', '/users/resolve', {
      type: 'federated',
      // The canonical Oxy username — NOT the bare handle, which oxy-api rejects.
      username: 'alice.bsky.social@bsky.social',
      // The DID is stored verbatim as the dedup key (oxy-api skips host binding).
      actorUri: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz',
      // The instance domain — equals the username domain, so the binding holds.
      domain: 'bsky.social',
      displayName: 'Alice',
      avatar: 'https://cdn.bsky.app/img/avatar/plain/did/cid@jpeg',
      bio: 'hello from bluesky',
      refresh: false,
      forceAvatarRefresh: false,
    });
  });

  it('passes the AP acct through as both username and (via instanceDomain) domain', async () => {
    const actor: NormalizedExternalActor = {
      network: 'activitypub',
      externalId: 'https://mastodon.social/users/alice',
      handle: 'alice@mastodon.social',
      federatedUsername: 'alice@mastodon.social',
      instanceDomain: 'mastodon.social',
      displayName: 'Alice',
      avatarUrl: 'https://files.mastodon.social/avatar.png',
    };

    await resolveOxyExternalUser(actor, { forceAvatarRefresh: true });

    expect(mocks.makeServiceRequest).toHaveBeenCalledWith('PUT', '/users/resolve', expect.objectContaining({
      type: 'federated',
      username: 'alice@mastodon.social',
      actorUri: 'https://mastodon.social/users/alice',
      domain: 'mastodon.social',
      refresh: true,
      forceAvatarRefresh: true,
    }));
  });

  it('returns null (caller skips, no orphan) when Oxy returns no id', async () => {
    mocks.makeServiceRequest.mockResolvedValue(null);
    const actor: NormalizedExternalActor = {
      network: 'atproto',
      externalId: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz',
      handle: 'alice.bsky.social',
      federatedUsername: 'alice.bsky.social@bsky.social',
      instanceDomain: 'bsky.social',
    };
    expect(await resolveOxyExternalUser(actor)).toBeNull();
  });

  it('mirrors the actor banner as a public federated asset and stores its file id', async () => {
    mocks.persistRemoteMedia.mockResolvedValue({
      ok: true,
      media: { oxyFileId: 'banner_file_1', contentType: 'image/png', sizeBytes: 1234 },
    });
    const actor: NormalizedExternalActor = {
      network: 'activitypub',
      externalId: 'https://mastodon.social/users/alice',
      handle: 'alice@mastodon.social',
      federatedUsername: 'alice@mastodon.social',
      instanceDomain: 'mastodon.social',
      bannerUrl: 'https://files.mastodon.social/banner.png',
    };

    await resolveOxyExternalUser(actor);

    // The banner mirrors through the SAME service-token public-upload path as
    // federated post media (`persistRemoteMediaForFederatedOwnerDetailed`), NOT
    // the user-authenticated SDK `uploadProfileBanner` (which 401s here).
    expect(mocks.persistRemoteMedia).toHaveBeenCalledWith(
      'https://files.mastodon.social/banner.png',
      'oxy-resolved',
      expect.objectContaining({
        role: 'banner',
        actorUri: 'https://mastodon.social/users/alice',
        remoteHost: 'files.mastodon.social',
      }),
    );
    expect(mocks.userSettingsUpdateOne).toHaveBeenCalledWith(
      { oxyUserId: 'oxy-resolved' },
      { $set: { profileHeaderImage: 'banner_file_1' } },
      { upsert: true },
    );
  });

  it('does not store a profile header image when banner mirroring fails', async () => {
    mocks.persistRemoteMedia.mockResolvedValue({ ok: false, permanent: true, reason: 'not-media' });
    const actor: NormalizedExternalActor = {
      network: 'activitypub',
      externalId: 'https://mastodon.social/users/bob',
      handle: 'bob@mastodon.social',
      federatedUsername: 'bob@mastodon.social',
      instanceDomain: 'mastodon.social',
      bannerUrl: 'https://files.mastodon.social/banner.txt',
    };

    await resolveOxyExternalUser(actor);

    expect(mocks.persistRemoteMedia).toHaveBeenCalledWith(
      'https://files.mastodon.social/banner.txt',
      'oxy-resolved',
      expect.objectContaining({ role: 'banner' }),
    );
    expect(mocks.userSettingsUpdateOne).not.toHaveBeenCalled();
  });

  it('skips banner mirroring when the actor has no banner', async () => {
    const actor: NormalizedExternalActor = {
      network: 'activitypub',
      externalId: 'https://mastodon.social/users/carol',
      handle: 'carol@mastodon.social',
      federatedUsername: 'carol@mastodon.social',
      instanceDomain: 'mastodon.social',
    };

    await resolveOxyExternalUser(actor);

    expect(mocks.persistRemoteMedia).not.toHaveBeenCalled();
    expect(mocks.userSettingsUpdateOne).not.toHaveBeenCalled();
  });
});

describe('reportFederatedActorGone', () => {
  it('posts to /federation/actor-gone with the oxyUserId and returns "archived"', async () => {
    mocks.makeServiceRequest.mockResolvedValue({
      oxyUserId: '6981c9178fcdefaf81988ffb',
      accountStatus: 'archived',
      alreadyArchived: false,
    });

    const outcome = await reportFederatedActorGone('6981c9178fcdefaf81988ffb');

    expect(outcome).toBe('archived');
    expect(mocks.makeServiceRequest).toHaveBeenCalledWith('POST', '/federation/actor-gone', {
      oxyUserId: '6981c9178fcdefaf81988ffb',
    });
  });

  it('returns "already" when Oxy reports the identity was already archived (idempotent 200)', async () => {
    mocks.makeServiceRequest.mockResolvedValue({
      oxyUserId: '6981c9178fcdefaf81988ffb',
      accountStatus: 'archived',
      alreadyArchived: true,
    });

    expect(await reportFederatedActorGone('6981c9178fcdefaf81988ffb')).toBe('already');
  });

  it('returns "skipped" without any network call for an empty id', async () => {
    expect(await reportFederatedActorGone('   ')).toBe('skipped');
    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
  });

  it.each([400, 403, 404, 409])(
    'log-and-swallows the permanent %i to "skipped" (non-retryable)',
    async (status) => {
      mocks.makeServiceRequest.mockRejectedValue(httpError(status));
      expect(await reportFederatedActorGone('6981c9178fcdefaf81988ffb')).toBe('skipped');
    },
  );

  it.each([500, 502, 503])('surfaces the transient %i as "failed" (retryable)', async (status) => {
    mocks.makeServiceRequest.mockRejectedValue(httpError(status));
    expect(await reportFederatedActorGone('6981c9178fcdefaf81988ffb')).toBe('failed');
  });

  it.each([408, 429])('treats the retryable 4xx %i as "failed", not permanent', async (status) => {
    mocks.makeServiceRequest.mockRejectedValue(httpError(status));
    expect(await reportFederatedActorGone('6981c9178fcdefaf81988ffb')).toBe('failed');
  });

  it('treats a statusless network error as transient "failed"', async () => {
    mocks.makeServiceRequest.mockRejectedValue(new Error('socket hang up'));
    expect(await reportFederatedActorGone('6981c9178fcdefaf81988ffb')).toBe('failed');
  });

  it('never throws — a permanent rejection resolves to a discriminant instead', async () => {
    mocks.makeServiceRequest.mockRejectedValue(httpError(409));
    await expect(reportFederatedActorGone('6981c9178fcdefaf81988ffb')).resolves.toBe('skipped');
  });
});

describe('deleteFederatedActorIdentity', () => {
  it('posts to /federation/actor-delete and returns "deleted" when Oxy removed a live identity', async () => {
    mocks.makeServiceRequest.mockResolvedValue({
      oxyUserId: '6981c9178fcdefaf81988ffb',
      deleted: true,
      followEdgesRemoved: 3,
    });

    const outcome = await deleteFederatedActorIdentity('6981c9178fcdefaf81988ffb');

    expect(outcome).toBe('deleted');
    expect(mocks.makeServiceRequest).toHaveBeenCalledWith('POST', '/federation/actor-delete', {
      oxyUserId: '6981c9178fcdefaf81988ffb',
    });
  });

  it('returns "absent" on the idempotent no-op (200 with deleted:false — Oxy side already clean)', async () => {
    mocks.makeServiceRequest.mockResolvedValue({
      oxyUserId: '6981c9178fcdefaf81988ffb',
      deleted: false,
      followEdgesRemoved: 0,
    });

    expect(await deleteFederatedActorIdentity('6981c9178fcdefaf81988ffb')).toBe('absent');
  });

  it('returns "skipped" without any network call for an empty id', async () => {
    expect(await deleteFederatedActorIdentity('   ')).toBe('skipped');
    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
  });

  it.each([400, 403, 409])(
    'log-and-swallows the permanent %i to "skipped" (non-retryable — keep the anchor)',
    async (status) => {
      mocks.makeServiceRequest.mockRejectedValue(httpError(status));
      expect(await deleteFederatedActorIdentity('6981c9178fcdefaf81988ffb')).toBe('skipped');
    },
  );

  it.each([500, 502, 503])('surfaces the transient %i as "failed" (retryable — keep the anchor)', async (status) => {
    mocks.makeServiceRequest.mockRejectedValue(httpError(status));
    expect(await deleteFederatedActorIdentity('6981c9178fcdefaf81988ffb')).toBe('failed');
  });

  it.each([408, 429])('treats the retryable 4xx %i as "failed", not permanent', async (status) => {
    mocks.makeServiceRequest.mockRejectedValue(httpError(status));
    expect(await deleteFederatedActorIdentity('6981c9178fcdefaf81988ffb')).toBe('failed');
  });

  it('treats a statusless network error as transient "failed"', async () => {
    mocks.makeServiceRequest.mockRejectedValue(new Error('socket hang up'));
    expect(await deleteFederatedActorIdentity('6981c9178fcdefaf81988ffb')).toBe('failed');
  });

  it('never throws — a permanent rejection resolves to a discriminant instead', async () => {
    mocks.makeServiceRequest.mockRejectedValue(httpError(409));
    await expect(deleteFederatedActorIdentity('6981c9178fcdefaf81988ffb')).resolves.toBe('skipped');
  });
});
