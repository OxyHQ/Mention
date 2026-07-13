import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Inbound ActivityPub ingest validation gate.
 *
 * `processInboxActivity` now runs every untrusted remote activity through the
 * zod `parseInboundActivity` schema BEFORE dispatching. This suite proves:
 *
 *  1. A malformed/hostile activity (missing required id/type, garbage object) is
 *     DROPPED — no Post is created, no Like/boost side effect fires, and a warn
 *     is logged. The drop matches the existing fast-ack inbox semantics (no
 *     throw, no retry-loop).
 *  2. A valid `Create{Note}` carrying a PAST `published` is still processed AND
 *     the imported post's `createdAt` equals that past instant — i.e. the
 *     original-publish-date fix is preserved (no regression from wiring in zod).
 *  3. Valid `Announce` / `Like` / `Undo` activities are still processed.
 *
 * It drives the REAL `FederationService` → `InboxProcessingService` chain with
 * the same dependency mocks the sibling `federationService.test.ts` uses, so the
 * assertions exercise the production dispatch path, not a stub.
 */

const mocks = vi.hoisted(() => ({
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
  likeCreate: vi.fn(),
  likeFindOneAndDelete: vi.fn(),
  getServiceOxyClient: vi.fn(),
  makeServiceRequest: vi.fn(),
  persistRemoteMedia: vi.fn(),
  recordAccess: vi.fn(),
  postCreatorCreate: vi.fn(),
  followExists: vi.fn(),
  followFindOneAndUpdate: vi.fn(),
  followDeleteOne: vi.fn(),
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
  loggerDebug: vi.fn(),
}));

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
    collection: {
      insertMany: mocks.postInsertMany,
    },
  },
}));

vi.mock('../../../models/Like', () => ({
  default: {
    create: mocks.likeCreate,
    findOneAndDelete: mocks.likeFindOneAndDelete,
  },
}));

vi.mock('../../../models/UserSettings', () => ({
  default: {
    updateOne: vi.fn(),
  },
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

// The service registry breaks the FederationService <-> PostCreationService
// circular import. Stub the post-creator accessor so federated note/boost
// imports don't pull in the real PostCreationService graph.
vi.mock('../../../services/serviceRegistry', () => ({
  getPostCreator: () => ({ create: mocks.postCreatorCreate }),
  registerPostFederator: vi.fn(),
  registerPostCreator: vi.fn(),
  getPostFederator: vi.fn(),
}));

import { activityPubConnector as federationService } from '../../../connectors/activitypub/ActivityPubConnector';

const actorUri = 'https://mastodon.social/users/bob';

/**
 * Make `getOrFetchActor`/`resolveActorOxyUserId` resolve a remote actor to a
 * fresh (non-stale) federated Oxy user so no background refresh fires.
 */
function stubResolvedActor(oxyUserId: string | null) {
  mocks.actorFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue(
      oxyUserId
        ? { uri: actorUri, oxyUserId, lastFetchedAt: new Date() }
        : null,
    ),
  });
}

/** Make `resolvePostIdFromObjectUri` resolve a remote object URI to a local id. */
function stubResolvedPost(localId: string | null) {
  mocks.postFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue(localId ? { _id: localId } : null),
  });
}

beforeEach(() => {
  vi.clearAllMocks();

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
  mocks.likeCreate.mockResolvedValue({ _id: 'like_1' });
  mocks.likeFindOneAndDelete.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
  mocks.persistRemoteMedia.mockResolvedValue({ ok: false, permanent: false });
  mocks.recordAccess.mockResolvedValue(undefined);
  mocks.postCreatorCreate.mockResolvedValue({ _id: 'created_post_1' });
  mocks.makeServiceRequest.mockResolvedValue({ id: 'oxy_user_1' });
  mocks.getServiceOxyClient.mockReturnValue({ makeServiceRequest: mocks.makeServiceRequest });
});

// ---------------------------------------------------------------------------
// 1. Malformed / hostile activities are dropped (no side effects, warn logged)
// ---------------------------------------------------------------------------

describe('processInboxActivity validation gate — invalid activities are dropped', () => {
  function expectNoSideEffects() {
    expect(mocks.postCreatorCreate).not.toHaveBeenCalled();
    expect(mocks.postInsertMany).not.toHaveBeenCalled();
    expect(mocks.likeCreate).not.toHaveBeenCalled();
    expect(mocks.postUpdateOne).not.toHaveBeenCalled();
    expect(mocks.postDeleteOne).not.toHaveBeenCalled();
    expect(mocks.followFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.followDeleteOne).not.toHaveBeenCalled();
  }

  it('drops an activity with no type (and logs a warn)', async () => {
    await federationService.processInboxActivity(
      { id: `${actorUri}/statuses/1/activity`, actor: actorUri, object: { id: 'x', type: 'Note' } },
      actorUri,
    );
    expectNoSideEffects();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('dropping invalid inbound activity'),
    );
  });

  it('drops a recognized activity type that is missing its required id (Create without id)', async () => {
    await federationService.processInboxActivity(
      {
        type: 'Create',
        actor: actorUri,
        object: { id: `${actorUri}/statuses/2`, type: 'Note', content: '<p>hi</p>' },
      },
      actorUri,
    );
    expectNoSideEffects();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(expect.stringContaining('type=Create'));
  });

  it('drops garbage (non-object) payloads without throwing', async () => {
    await expect(
      federationService.processInboxActivity('not-an-object' as unknown as Record<string, unknown>, actorUri),
    ).resolves.toBeUndefined();
    await expect(
      federationService.processInboxActivity(null as unknown as Record<string, unknown>, actorUri),
    ).resolves.toBeUndefined();
    await expect(
      federationService.processInboxActivity([] as unknown as Record<string, unknown>, actorUri),
    ).resolves.toBeUndefined();
    expectNoSideEffects();
    expect(mocks.loggerWarn).toHaveBeenCalled();
  });

  it('drops an unknown activity type that is not in the inbound union', async () => {
    await federationService.processInboxActivity(
      { id: `${actorUri}/flag/1`, type: 'Flag', actor: actorUri, object: actorUri },
      actorUri,
    );
    expectNoSideEffects();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(expect.stringContaining('type=Flag'));
  });
});

// ---------------------------------------------------------------------------
// 2. Valid Create{Note} with a past published → processed, createdAt preserved
// ---------------------------------------------------------------------------

describe('processInboxActivity validation gate — valid Create{Note} preserves the original publish date', () => {
  const noteId = `${actorUri}/statuses/300`;
  const activityId = `${actorUri}/statuses/300/activity`;

  it('processes the Create and stores the PAST Note published as createdAt (no date regression)', async () => {
    stubResolvedActor('oxy_bob');
    mocks.postExists.mockResolvedValue(null); // not a duplicate

    const past = '2022-03-10T14:00:00Z';

    await federationService.processInboxActivity(
      {
        id: activityId,
        type: 'Create',
        actor: actorUri,
        published: past,
        object: {
          id: noteId,
          type: 'Note',
          attributedTo: actorUri,
          content: '<p>hello from the past</p>',
          published: past,
          to: ['https://www.w3.org/ns/activitystreams#Public'],
        },
      },
      actorUri,
    );

    expect(mocks.postCreatorCreate).toHaveBeenCalledTimes(1);
    expect(mocks.postCreatorCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        federation: expect.objectContaining({ activityId: noteId }),
        createdAt: new Date(past),
        updatedAt: new Date(past),
      }),
    );
    // The Create passed validation, so it must NOT have been dropped.
    expect(mocks.loggerWarn).not.toHaveBeenCalledWith(
      expect.stringContaining('dropping invalid inbound activity'),
    );
  });

  it('omits createdAt (schema default = now) when the Note carries no published date', async () => {
    stubResolvedActor('oxy_bob');
    mocks.postExists.mockResolvedValue(null);

    await federationService.processInboxActivity(
      {
        id: activityId,
        type: 'Create',
        actor: actorUri,
        object: {
          id: noteId,
          type: 'Note',
          attributedTo: actorUri,
          content: '<p>no date</p>',
          to: ['https://www.w3.org/ns/activitystreams#Public'],
        },
      },
      actorUri,
    );

    expect(mocks.postCreatorCreate).toHaveBeenCalledTimes(1);
    const params = mocks.postCreatorCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(params).not.toHaveProperty('createdAt');
    expect(params).not.toHaveProperty('updatedAt');
  });
});

// ---------------------------------------------------------------------------
// 3. Valid Announce / Like / Undo are still processed through the gate
// ---------------------------------------------------------------------------

describe('processInboxActivity validation gate — valid Like/Announce/Undo still process', () => {
  const likedUri = 'https://mastodon.social/users/alice/statuses/100';
  const announcedUri = 'https://mastodon.social/users/alice/statuses/200';
  const announceId = `${actorUri}/statuses/200/activity`;

  it('records a native Like for a valid Like activity', async () => {
    stubResolvedActor('oxy_bob');
    stubResolvedPost('local_post_1');

    await federationService.processInboxActivity(
      { id: `${actorUri}/likes/1`, type: 'Like', actor: actorUri, object: likedUri },
      actorUri,
    );

    expect(mocks.likeCreate).toHaveBeenCalledWith({ userId: 'oxy_bob', postId: 'local_post_1', value: 1 });
    expect(mocks.postUpdateOne).toHaveBeenCalledWith(
      { _id: 'local_post_1' },
      { $inc: { 'stats.likesCount': 1 } },
    );
    expect(mocks.loggerWarn).not.toHaveBeenCalledWith(
      expect.stringContaining('dropping invalid inbound activity'),
    );
  });

  it('creates a native boost Post for a valid Announce activity', async () => {
    stubResolvedActor('oxy_bob');
    stubResolvedPost('local_post_2');
    // The boosted post must be public + published for the boost to be imported.
    mocks.postFindById.mockReturnValue({
      lean: vi.fn().mockResolvedValue({ status: 'published', visibility: 'public' }),
    });
    mocks.postExists.mockResolvedValue(null); // no existing boost

    await federationService.processInboxActivity(
      {
        id: announceId,
        type: 'Announce',
        actor: actorUri,
        object: announcedUri,
        published: '2026-06-18T09:30:00Z',
      },
      actorUri,
    );

    expect(mocks.postCreatorCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        oxyUserId: 'oxy_bob',
        boostOf: 'local_post_2',
        federation: expect.objectContaining({ activityId: announceId }),
        createdAt: new Date('2026-06-18T09:30:00Z'),
        updatedAt: new Date('2026-06-18T09:30:00Z'),
      }),
    );
    expect(mocks.postUpdateOne).toHaveBeenCalledWith(
      { _id: 'local_post_2' },
      { $inc: { 'stats.boostsCount': 1, 'stats.federatedBoostsCount': 1 } },
    );
  });

  it('processes a valid Undo(Like): deletes the Like and decrements the counter', async () => {
    stubResolvedActor('oxy_bob');
    stubResolvedPost('local_post_1');
    mocks.likeFindOneAndDelete.mockReturnValue({
      lean: vi.fn().mockResolvedValue({ _id: 'like_1' }),
    });

    await federationService.processInboxActivity(
      {
        id: `${actorUri}/undos/1`,
        type: 'Undo',
        actor: actorUri,
        object: { id: `${actorUri}/likes/1`, type: 'Like', object: likedUri },
      },
      actorUri,
    );

    expect(mocks.likeFindOneAndDelete).toHaveBeenCalledWith({ userId: 'oxy_bob', postId: 'local_post_1', value: 1 });
    expect(mocks.postUpdateOne).toHaveBeenCalledWith(
      { _id: 'local_post_1', 'stats.likesCount': { $gt: 0 } },
      { $inc: { 'stats.likesCount': -1 } },
    );
    expect(mocks.loggerWarn).not.toHaveBeenCalledWith(
      expect.stringContaining('dropping invalid inbound activity'),
    );
  });
});
