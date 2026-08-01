import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `FEDERATION_BLOCKED_DOMAINS` must stop a suspended instance syncing INTO
 * Mention — not merely stop Mention fetching from it.
 *
 * Before this gate existed the setting was effectively inert for every instance
 * that had ever reached us: enforcement lived only on the FETCH path
 * (`fetchRemoteActor`, webfinger, `matches`), and both inbound transports skip
 * that path entirely when an actor row is already cached —
 *
 *   - inbound PUSH: the inbox verifies the HTTP signature against the CACHED
 *     public key and dispatches the activity; no handler consults the policy.
 *   - outbox PULL: the scheduler and the profile-view refresh load the actor
 *     straight from Mongo and hand it to `syncOutboxPostsDetailed`.
 *
 * So the load-bearing case here is deliberately the CACHED one — a test that
 * only covered an unknown actor would have passed before the fix and proved
 * nothing. Each blocked-domain assertion is paired with an allowed-domain
 * control that produces the side effect, so a harness that silently stopped
 * working could not read as a pass.
 *
 * The blocklist is set through the REAL env var, so this also proves the whole
 * chain — `FEDERATION_BLOCKED_DOMAINS` → `config.federation.blockedDomains` →
 * `createDomainPolicy` → the engine — is actually connected.
 */

const mocks = vi.hoisted(() => {
  // Set BEFORE any import: `config` parses `process.env` once at module load,
  // and `constants.ts` freezes the domain policy from it at import time.
  process.env.FEDERATION_BLOCKED_DOMAINS = 'spam.example';

  return {
    getPublicKey: vi.fn(),
    signViaOxy: vi.fn(),
    signRequest: vi.fn(),
    actorFind: vi.fn(),
    actorFindOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn(),
    postFind: vi.fn(),
    postFindOne: vi.fn(),
    postFindById: vi.fn(),
    postUpdateOne: vi.fn(),
    postCreate: vi.fn(),
    postInsertMany: vi.fn(),
    postExists: vi.fn(),
    postDeleteOne: vi.fn(),
    materializeEngagementRelationship: vi.fn(),
    materializeEngagementTombstone: vi.fn(),
    getServiceOxyClient: vi.fn(),
    makeServiceRequest: vi.fn(),
    persistRemoteMedia: vi.fn(),
    recordAccess: vi.fn(),
    postCreatorCreate: vi.fn(),
    followExists: vi.fn(),
    followFindOneAndUpdate: vi.fn(),
    followDeleteOne: vi.fn(),
    resolveOxyUser: vi.fn(),
    createNotification: vi.fn(),
    isFediverseSharingEnabledFromUser: vi.fn(),
    fetchUpstreamSingleHop: vi.fn(),
    loggerWarn: vi.fn(),
    loggerInfo: vi.fn(),
    loggerError: vi.fn(),
    loggerDebug: vi.fn(),
  };
});

vi.mock('../../../utils/logger', () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    debug: mocks.loggerDebug,
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock('../../../connectors/activitypub/crypto', () => ({
  getPublicKey: mocks.getPublicKey,
  signViaOxy: mocks.signViaOxy,
  signRequest: mocks.signRequest,
}));

vi.mock('../../../models/FederatedActor', () => ({
  default: {
    findOne: mocks.actorFindOne,
    find: mocks.actorFind,
    findOneAndUpdate: mocks.findOneAndUpdate,
    updateOne: mocks.updateOne,
  },
}));

vi.mock('../../../models/FederatedFollow', () => ({
  default: {
    exists: mocks.followExists,
    findOneAndUpdate: mocks.followFindOneAndUpdate,
    deleteOne: mocks.followDeleteOne,
    updateOne: mocks.updateOne,
  },
}));

vi.mock('../../../models/FederationDeliveryQueue', () => ({
  default: {},
  getNextRetryTime: vi.fn(),
}));

vi.mock('../../../models/Post', () => ({
  POST_CLASSIFICATION_PENDING: 'pending',
  Post: {
    find: mocks.postFind,
    findOne: mocks.postFindOne,
    findById: mocks.postFindById,
    updateOne: mocks.postUpdateOne,
    exists: mocks.postExists,
    deleteOne: mocks.postDeleteOne,
    collection: { insertMany: mocks.postInsertMany },
  },
}));

vi.mock('../../../services/PostEngagementCommandService', () => ({
  materializeEngagementRelationship: (...args: unknown[]) =>
    mocks.materializeEngagementRelationship(...args),
  materializeEngagementTombstone: (...args: unknown[]) =>
    mocks.materializeEngagementTombstone(...args),
}));

vi.mock('../../../models/UserSettings', () => ({
  default: { updateOne: vi.fn() },
}));

vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: mocks.getServiceOxyClient,
}));

vi.mock('../../../services/mediaCache/cacheWorker', () => ({
  persistRemoteMediaForFederatedOwnerDetailed: mocks.persistRemoteMedia,
}));

vi.mock('../../../services/mediaCache/cacheStore', () => ({
  recordAccessAndMaybeEnqueue: mocks.recordAccess,
}));

vi.mock('../../../services/serviceRegistry', () => ({
  getPostCreator: () => ({ create: mocks.postCreatorCreate }),
  registerPostFederator: vi.fn(),
  registerPostCreator: vi.fn(),
  getPostFederator: vi.fn(),
}));

vi.mock('../../../utils/notificationUtils', () => ({
  createNotification: mocks.createNotification,
  createMentionNotifications: vi.fn(),
  createWelcomeNotification: vi.fn(),
  createBatchNotifications: vi.fn(),
}));

vi.mock('../../../services/fediverseSharing', () => ({
  isFediverseSharingEnabled: vi.fn(),
  isFediverseSharingEnabledFromUser: (...args: unknown[]) =>
    mocks.isFediverseSharingEnabledFromUser(...args),
}));

// Override ONLY `resolveOxyUser` (it otherwise `require()`s the whole server) and
// keep every other constant real — `isBlockedDomain` in particular, which is the
// env-derived policy under test.
vi.mock('../../../connectors/activitypub/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../connectors/activitypub/constants')>();
  return { ...actual, resolveOxyUser: mocks.resolveOxyUser };
});

// `signedFetch` reaches the network through the IP-pinned single-hop fetch. Spy
// on it so "no outbound request was made" is a direct egress assertion rather
// than an inference from a missing side effect.
vi.mock('../../../utils/safeUpstreamFetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/safeUpstreamFetch')>();
  return { ...actual, fetchUpstreamSingleHop: mocks.fetchUpstreamSingleHop };
});

import { activityPubConnector } from '../../../connectors/activitypub/ActivityPubConnector';
import { deliveryService } from '../../../connectors/activitypub/delivery.service';
import { isBlockedDomain } from '../../../connectors/activitypub/constants';

const BLOCKED_ACTOR = 'https://spam.example/users/mallory';
const ALLOWED_ACTOR = 'https://mastodon.social/users/bob';
const LOCAL_ACTOR = 'https://mention.earth/ap/users/alice';

/** A cached, non-stale actor row already resolved to an Oxy user — the hole's precondition. */
function cacheActor(uri: string, oxyUserId: string) {
  mocks.actorFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue({
      _id: 'actor_1',
      uri,
      acct: `mallory@${new URL(uri).hostname}`,
      oxyUserId,
      outboxUrl: `${uri}/outbox`,
      publicKeyPem: 'cached-pem',
      lastFetchedAt: new Date(),
    }),
  });
}

function createNote(actorUri: string) {
  return {
    id: `${actorUri}/statuses/1/activity`,
    type: 'Create',
    actor: actorUri,
    published: '2026-07-01T10:00:00Z',
    object: {
      id: `${actorUri}/statuses/1`,
      type: 'Note',
      attributedTo: actorUri,
      content: '<p>spam</p>',
      published: '2026-07-01T10:00:00Z',
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    },
  };
}

const sendAcceptSpy = vi.spyOn(deliveryService, 'sendAccept');

beforeEach(() => {
  vi.clearAllMocks();

  mocks.resolveOxyUser.mockResolvedValue({ _id: 'oxy_alice' });
  mocks.isFediverseSharingEnabledFromUser.mockReturnValue(true);
  mocks.createNotification.mockResolvedValue(undefined);
  sendAcceptSpy.mockResolvedValue(undefined);
  mocks.getPublicKey.mockResolvedValue({
    keyId: 'https://mention.earth/ap/users/instance#main-key',
    publicKeyPem: 'public',
  });
  mocks.signViaOxy.mockResolvedValue('signature');
  mocks.signRequest.mockResolvedValue({ Signature: 'signature' });
  mocks.findOneAndUpdate.mockImplementation(async (_query, update) => ({ _id: 'actor_1', ...update?.$set }));
  mocks.updateOne.mockResolvedValue({ modifiedCount: 1 });
  mocks.followFindOneAndUpdate.mockResolvedValue({ _id: 'follow_1' });
  mocks.followDeleteOne.mockResolvedValue({ deletedCount: 1 });
  mocks.actorFind.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
  mocks.actorFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
  mocks.postFind.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
  mocks.postFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
  mocks.postFindById.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
  mocks.postUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  mocks.postDeleteOne.mockResolvedValue({ deletedCount: 1 });
  mocks.postInsertMany.mockResolvedValue({ insertedCount: 0 });
  mocks.postExists.mockResolvedValue(null);
  mocks.followExists.mockResolvedValue({ _id: 'follow_1' });
  mocks.materializeEngagementRelationship.mockResolvedValue({ changed: true });
  mocks.materializeEngagementTombstone.mockResolvedValue({ changed: true });
  mocks.persistRemoteMedia.mockResolvedValue({ ok: false, permanent: false });
  mocks.recordAccess.mockResolvedValue(undefined);
  mocks.postCreatorCreate.mockResolvedValue({ _id: 'created_post_1' });
  mocks.makeServiceRequest.mockResolvedValue({ id: 'oxy_user_1' });
  mocks.getServiceOxyClient.mockReturnValue({ makeServiceRequest: mocks.makeServiceRequest });
});

describe('FEDERATION_BLOCKED_DOMAINS reaches the domain policy', () => {
  it('blocks the configured domain and leaves an unconfigured one alone', () => {
    expect(isBlockedDomain('spam.example')).toBe(true);
    expect(isBlockedDomain('mastodon.social')).toBe(false);
  });
});

describe('inbound PUSH from a blocked domain', () => {
  /**
   * A refused activity is refused BEFORE dispatch, so it reads no storage at all
   * — no actor cache, no post lookup, no follow row. That is what separates "the
   * policy rejected it" from "a handler happened to find nothing to do", which
   * several of these verbs would otherwise do under these mocks and which would
   * make the assertion below unable to fail.
   */
  function expectRefusedBeforeAnyStoreRead() {
    expect(mocks.actorFindOne).not.toHaveBeenCalled();
    expect(mocks.postFindOne).not.toHaveBeenCalled();
    expect(mocks.followFindOneAndUpdate).not.toHaveBeenCalled();
  }

  it('drops a Create whose actor is ALREADY CACHED — no post is created', async () => {
    cacheActor(BLOCKED_ACTOR, 'oxy_mallory');

    await activityPubConnector.processInboxActivity(createNote(BLOCKED_ACTOR), BLOCKED_ACTOR);

    expect(mocks.postCreatorCreate).not.toHaveBeenCalled();
    expect(mocks.postInsertMany).not.toHaveBeenCalled();
    expectRefusedBeforeAnyStoreRead();
  });

  it('control: the same Create from an allowed domain with a cached actor IS imported', async () => {
    cacheActor(ALLOWED_ACTOR, 'oxy_bob');

    await activityPubConnector.processInboxActivity(createNote(ALLOWED_ACTOR), ALLOWED_ACTOR);

    expect(mocks.postCreatorCreate).toHaveBeenCalledTimes(1);
    expect(mocks.actorFindOne).toHaveBeenCalled();
  });

  it('drops a Follow — no Oxy edge is bridged and no follow row is written', async () => {
    cacheActor(BLOCKED_ACTOR, 'oxy_mallory');

    await activityPubConnector.processInboxActivity(
      { id: `${BLOCKED_ACTOR}/follows/1`, type: 'Follow', actor: BLOCKED_ACTOR, object: LOCAL_ACTOR },
      BLOCKED_ACTOR,
    );

    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
    expect(sendAcceptSpy).not.toHaveBeenCalled();
    expectRefusedBeforeAnyStoreRead();
  });

  it('control: the same Follow from an allowed domain DOES bridge and Accept', async () => {
    cacheActor(ALLOWED_ACTOR, 'oxy_bob');

    await activityPubConnector.processInboxActivity(
      { id: `${ALLOWED_ACTOR}/follows/1`, type: 'Follow', actor: ALLOWED_ACTOR, object: LOCAL_ACTOR },
      ALLOWED_ACTOR,
    );

    expect(mocks.makeServiceRequest).toHaveBeenCalledWith('POST', '/federation/follow', {
      followerUserId: 'oxy_bob',
      targetUserId: 'oxy_alice',
      action: 'follow',
    });
    expect(sendAcceptSpy).toHaveBeenCalled();
  });

  it('drops a Like — no engagement is materialized', async () => {
    cacheActor(BLOCKED_ACTOR, 'oxy_mallory');

    await activityPubConnector.processInboxActivity(
      {
        id: `${BLOCKED_ACTOR}/likes/1`,
        type: 'Like',
        actor: BLOCKED_ACTOR,
        object: `${LOCAL_ACTOR}/posts/post_1`,
      },
      BLOCKED_ACTOR,
    );

    expect(mocks.materializeEngagementRelationship).not.toHaveBeenCalled();
    expectRefusedBeforeAnyStoreRead();
  });

  it('drops an Announce — no boost post is created', async () => {
    cacheActor(BLOCKED_ACTOR, 'oxy_mallory');

    await activityPubConnector.processInboxActivity(
      {
        id: `${BLOCKED_ACTOR}/announces/1`,
        type: 'Announce',
        actor: BLOCKED_ACTOR,
        object: `${LOCAL_ACTOR}/posts/post_1`,
      },
      BLOCKED_ACTOR,
    );

    expect(mocks.postCreatorCreate).not.toHaveBeenCalled();
    expect(mocks.materializeEngagementRelationship).not.toHaveBeenCalled();
    expectRefusedBeforeAnyStoreRead();
  });

  it('drops a Delete — an existing local copy is not mutated by a blocked origin', async () => {
    cacheActor(BLOCKED_ACTOR, 'oxy_mallory');

    await activityPubConnector.processInboxActivity(
      {
        id: `${BLOCKED_ACTOR}/deletes/1`,
        type: 'Delete',
        actor: BLOCKED_ACTOR,
        object: `${BLOCKED_ACTOR}/statuses/1`,
      },
      BLOCKED_ACTOR,
    );

    expect(mocks.postDeleteOne).not.toHaveBeenCalled();
    expect(mocks.postUpdateOne).not.toHaveBeenCalled();
    expectRefusedBeforeAnyStoreRead();
  });
});

describe('outbox PULL from a blocked domain', () => {
  const blockedActorRow = {
    uri: BLOCKED_ACTOR,
    acct: 'mallory@spam.example',
    outboxUrl: `${BLOCKED_ACTOR}/outbox`,
    oxyUserId: 'oxy_mallory',
  };

  it('refuses the sync without any outbound request', async () => {
    const result = await activityPubConnector.syncOutboxPostsDetailed(blockedActorRow, 20);

    expect(result.reason).toBe('blocked-domain');
    expect(result.syncedCount).toBe(0);
    expect(mocks.fetchUpstreamSingleHop).not.toHaveBeenCalled();
  });

  it('does not stamp a cooldown or mark the outbox unavailable, so unblocking resumes cleanly', async () => {
    const { isPermanentlyUnavailableOutboxReason } = await import(
      '../../../connectors/activitypub/outbox.service'
    );
    const result = await activityPubConnector.syncOutboxPostsDetailed(blockedActorRow, 20);

    // The reason is asserted here too: without it this test passes on ANY failure
    // path (a refused fetch also declines the cooldown), so it could not tell a
    // policy refusal from an unrelated error.
    expect(result.reason).toBe('blocked-domain');
    expect(result.shouldStampCooldown).toBe(false);
    expect(isPermanentlyUnavailableOutboxReason(result.reason)).toBe(false);
  });

  it('control: an allowed domain still reaches the outbox fetch', async () => {
    await activityPubConnector.syncOutboxPostsDetailed(
      {
        uri: ALLOWED_ACTOR,
        acct: 'bob@mastodon.social',
        outboxUrl: `${ALLOWED_ACTOR}/outbox`,
        oxyUserId: 'oxy_bob',
      },
      20,
    );

    expect(mocks.fetchUpstreamSingleHop).toHaveBeenCalled();
  });
});

describe('cached actors on a blocked domain are no longer served', () => {
  it('getOrFetchActor returns null even though a row is cached', async () => {
    cacheActor(BLOCKED_ACTOR, 'oxy_mallory');

    await expect(activityPubConnector.getOrFetchActor(BLOCKED_ACTOR)).resolves.toBeNull();
  });

  it('control: a cached actor on an allowed domain is still returned', async () => {
    cacheActor(ALLOWED_ACTOR, 'oxy_bob');

    const actor = await activityPubConnector.getOrFetchActor(ALLOWED_ACTOR);
    expect(actor?.uri).toBe(ALLOWED_ACTOR);
  });
});
