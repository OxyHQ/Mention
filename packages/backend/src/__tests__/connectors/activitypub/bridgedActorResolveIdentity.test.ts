import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Resolving a BRIDGED actor must not undo the re-labelling that just happened.
 *
 * The registry falls back to `mapIdentity` whenever a resolved actor carries no
 * Oxy user — which is exactly the state a first-EVER ingest leaves it in, because
 * the shared resolver returns the row it upserted BEFORE stamping the resolved id
 * onto it. That fallback re-asks oxy-api to resolve the same actor URI, and
 * `PUT /users/resolve` keys on the actor URI while SETTING the username. So an
 * identity read off the wrong column there does not merely look wrong in the
 * response: it renames the Oxy user the ingest had just re-labelled, back to the
 * bridge handle, permanently.
 *
 * A bridged row keeps `acct`/`uri`/`domain` addressing the bridge on purpose —
 * the domain policy and every moderation consumer read those — so the identity
 * lives in `networkAcct` and nowhere else. This is the first discovery of a
 * bridged account, which is precisely the path a pasted profile URL takes.
 */

const mocks = vi.hoisted(() => ({
  resolveWebFinger: vi.fn(),
  fetchRemoteActor: vi.fn(),
  resolveFederatedActorIdentity: vi.fn(),
}));

vi.mock('../../../connectors/activitypub/actor.service', () => ({
  actorService: {
    resolveWebFinger: mocks.resolveWebFinger,
    fetchRemoteActor: mocks.fetchRemoteActor,
    getOrFetchActor: vi.fn(),
    refreshActorInBackground: vi.fn(),
    fetchPublicKey: vi.fn(),
  },
}));

vi.mock('../../../connectors/activitypub/outbox.service', () => ({
  outboxSyncService: {
    syncOutboxPostsDetailed: vi.fn(),
    syncOutboxPosts: vi.fn(),
    markOutboxBackfillUnavailable: vi.fn(),
  },
  isPermanentlyUnavailableOutboxReason: vi.fn().mockReturnValue(false),
  PERMANENTLY_UNAVAILABLE_OUTBOX_REASONS: [],
}));

vi.mock('../../../connectors/activitypub/follow.service', () => ({ followService: {} }));
vi.mock('../../../connectors/activitypub/inbox.service', () => ({
  inboxProcessingService: { processInboxActivity: vi.fn() },
}));
vi.mock('../../../connectors/activitypub/constants', () => ({
  FEDERATION_ENABLED: true,
  isBlockedDomain: () => false,
  // `actorObject.ts` binds the shared engine at module load, reached through
  // `delivery.service`, which the connector imports.
  FEDERATION_DOMAIN: 'mention.earth',
  AP_CONTENT_TYPE: 'application/activity+json',
  USER_AGENT: 'Mention/mention.earth (ActivityPub)',
  resolveOxyUser: vi.fn(),
  federationUrls: {
    actor: (u: string) => `https://mention.earth/ap/users/${u}`,
    inbox: (u: string) => `https://mention.earth/ap/users/${u}/inbox`,
    outbox: (u: string) => `https://mention.earth/ap/users/${u}/outbox`,
    featured: (u: string) => `https://mention.earth/ap/users/${u}/collections/featured`,
    followers: (u: string) => `https://mention.earth/ap/users/${u}/followers`,
    following: (u: string) => `https://mention.earth/ap/users/${u}/following`,
    sharedInbox: () => 'https://mention.earth/ap/inbox',
  },
}));

vi.mock('../../../connectors/identity', () => ({
  resolveFederatedActorIdentity: mocks.resolveFederatedActorIdentity,
}));

vi.mock('../../../services/fediverseSharing', () => ({
  isFediverseSharingEnabled: vi.fn(async () => true),
}));

import { activityPubConnector } from '../../../connectors/activitypub/ActivityPubConnector';
import { ConnectorRegistry } from '../../../connectors/ConnectorRegistry';

const ACTOR_URI = 'https://bird.makeup/users/elonmusk';

/** The row a FIRST ingest leaves behind: re-labelled, not yet stamped with an Oxy id. */
const FRESHLY_BRIDGED_ROW = {
  uri: ACTOR_URI,
  username: 'elonmusk',
  acct: 'elonmusk@bird.makeup',
  domain: 'bird.makeup',
  networkAcct: 'elonmusk@x.com',
  summary: '',
  oxyUserId: undefined,
};

const registry = new ConnectorRegistry([activityPubConnector]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveWebFinger.mockResolvedValue(ACTOR_URI);
  mocks.resolveFederatedActorIdentity.mockResolvedValue('oxy-user-1');
});

describe('resolving a bridged actor', () => {
  it('carries the re-labelled identity, not the bridge address', async () => {
    mocks.fetchRemoteActor.mockResolvedValue(FRESHLY_BRIDGED_ROW);

    const actor = await activityPubConnector.resolve('elonmusk@bird.makeup');

    expect(actor).toMatchObject({
      // The PROTOCOL address is unchanged — it is how the actor is reached, and
      // the domain policy reads it.
      externalId: ACTOR_URI,
      handle: 'elonmusk@bird.makeup',
      // The IDENTITY is on the network the account really belongs to.
      federatedUsername: 'elonmusk@x.com',
      instanceDomain: 'x.com',
    });
  });

  it('asks oxy-api for the network identity when the registry falls back', async () => {
    mocks.fetchRemoteActor.mockResolvedValue(FRESHLY_BRIDGED_ROW);

    const actor = await registry.resolve('elonmusk@bird.makeup');

    expect(mocks.resolveFederatedActorIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.resolveFederatedActorIdentity.mock.calls[0][0]).toMatchObject({
      externalId: ACTOR_URI,
      federatedUsername: 'elonmusk@x.com',
      instanceDomain: 'x.com',
    });
    expect(actor?.oxyUserId).toBe('oxy-user-1');
  });

  it('leaves an ordinary actor addressed and identified by its own acct', async () => {
    mocks.fetchRemoteActor.mockResolvedValue({
      uri: 'https://mastodon.social/users/alice',
      username: 'alice',
      acct: 'alice@mastodon.social',
      domain: 'mastodon.social',
      summary: '',
      oxyUserId: 'oxy-user-2',
    });

    const actor = await activityPubConnector.resolve('alice@mastodon.social');

    expect(actor).toMatchObject({
      handle: 'alice@mastodon.social',
      federatedUsername: 'alice@mastodon.social',
      instanceDomain: 'mastodon.social',
    });
  });

  it('falls back to the protocol acct when a row carries an unusable networkAcct', async () => {
    // A value with no domain cannot be bound to one, so it is not an identity.
    // Degrading to the actor's real acct is the pre-relabel behaviour and loses
    // nothing; inventing a domain for it would mint an identity nobody derived.
    mocks.fetchRemoteActor.mockResolvedValue({ ...FRESHLY_BRIDGED_ROW, networkAcct: 'elonmusk' });

    const actor = await activityPubConnector.resolve('elonmusk@bird.makeup');

    expect(actor).toMatchObject({
      federatedUsername: 'elonmusk@bird.makeup',
      instanceDomain: 'bird.makeup',
    });
  });
});
