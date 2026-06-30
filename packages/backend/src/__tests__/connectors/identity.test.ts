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
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    makeServiceRequest: mocks.makeServiceRequest,
  }),
}));

import { resolveOxyExternalUser } from '../../connectors/identity';
import type { NormalizedExternalActor } from '../../connectors/types';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.makeServiceRequest.mockResolvedValue({ _id: 'oxy-resolved' });
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
});
