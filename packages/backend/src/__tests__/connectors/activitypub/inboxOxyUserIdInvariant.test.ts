import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mandatory-Oxy-link invariant (Workstream B, B1).
 *
 * Federated posts MUST carry a real Oxy author. When an inbound `Create{Note}`
 * is processed but its remote actor has NOT resolved to an Oxy user (no
 * `oxyUserId`), `handleCreate` must:
 *   1. THROW (so the BullMQ inbox job fails and retries with backoff), and
 *   2. NOT insert any Post — never an orphan with a null author.
 *
 * When the actor DOES resolve, the post is inserted with that exact Oxy author
 * (regression guard for the happy path).
 *
 * Drives the REAL `FederationService` → `InboxProcessingService` chain with the
 * same dependency mocks the sibling `inboxValidation.test.ts` uses, so the
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
// circular import. Stub the post-creator accessor so federated note imports
// don't pull in the real PostCreationService graph.
vi.mock('../../../services/serviceRegistry', () => ({
  getPostCreator: () => ({ create: mocks.postCreatorCreate }),
  registerPostFederator: vi.fn(),
  registerPostCreator: vi.fn(),
  getPostFederator: vi.fn(),
}));

import { activityPubConnector as federationService } from '../../../connectors/activitypub/ActivityPubConnector';
import { ActorResolutionPendingError } from '../../../connectors/shared/ActorResolutionPendingError';

const actorUri = 'https://mastodon.social/users/bob';
const noteId = `${actorUri}/statuses/900`;
const activityId = `${actorUri}/statuses/900/activity`;

/**
 * Stub the cached `FederatedActor` lookup used by `getOrFetchActor`. Pass an
 * `oxyUserId` to simulate a fully-resolved actor; pass `null` to simulate a
 * cached actor that exists but has NOT yet resolved to an Oxy user (the orphan
 * scenario). `lastFetchedAt` is fresh so no background refresh fires.
 */
function stubCachedActor(oxyUserId: string | null) {
  mocks.actorFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue(
      oxyUserId
        ? { uri: actorUri, oxyUserId, lastFetchedAt: new Date() }
        : { uri: actorUri, lastFetchedAt: new Date() },
    ),
  });
}

function createNoteActivity() {
  return {
    id: activityId,
    type: 'Create' as const,
    actor: actorUri,
    object: {
      id: noteId,
      type: 'Note' as const,
      attributedTo: actorUri,
      content: '<p>hello world</p>',
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  mocks.findOneAndUpdate.mockImplementation(async (_query, update) => ({ _id: 'actor_1', ...update?.$set }));
  mocks.updateOne.mockResolvedValue({ modifiedCount: 1 });
  mocks.actorFind.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
  mocks.postFind.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
  mocks.postFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
  mocks.postFindById.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
  mocks.postUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  mocks.postInsertMany.mockResolvedValue({ insertedCount: 0 });
  // Not a duplicate — `handleCreate` proceeds past the dedup check.
  mocks.postExists.mockResolvedValue(null);
  // The actor is followed by at least one local user (required by handleCreate).
  mocks.followExists.mockResolvedValue({ _id: 'follow_1' });
  mocks.persistRemoteMedia.mockResolvedValue({ ok: false, permanent: false });
  mocks.recordAccess.mockResolvedValue(undefined);
  mocks.postCreatorCreate.mockResolvedValue({ _id: 'created_post_1' });
  mocks.makeServiceRequest.mockResolvedValue({ id: 'oxy_user_1' });
  mocks.getServiceOxyClient.mockReturnValue({ makeServiceRequest: mocks.makeServiceRequest });
});

describe('handleCreate — mandatory Oxy link invariant', () => {
  it('THROWS ActorResolutionPendingError and inserts NO post when the actor has no oxyUserId', async () => {
    stubCachedActor(null); // actor exists but is not resolved to an Oxy user

    await expect(
      federationService.processInboxActivity(createNoteActivity(), actorUri),
    ).rejects.toBeInstanceOf(ActorResolutionPendingError);

    // No orphan post is ever inserted (neither via the creator nor raw insert).
    expect(mocks.postCreatorCreate).not.toHaveBeenCalled();
    expect(mocks.postInsertMany).not.toHaveBeenCalled();
  });

  it('inserts the post with the resolved Oxy author when the actor has an oxyUserId', async () => {
    stubCachedActor('oxy_bob');

    await federationService.processInboxActivity(createNoteActivity(), actorUri);

    expect(mocks.postCreatorCreate).toHaveBeenCalledTimes(1);
    const params = mocks.postCreatorCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(params.oxyUserId).toBe('oxy_bob');
    // The author is a real string id — never null.
    expect(params.oxyUserId).not.toBeNull();
  });
});
