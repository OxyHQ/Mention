import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Inbound Follow → Oxy follow-graph bridge (Phase 2).
 *
 * A fediverse Follow must become a REAL Oxy edge, not just a Mention-local
 * `FederatedFollow` row. `handleIncomingFollow` therefore:
 *   1. requires the follower actor's `oxyUserId` (throws `ActorResolutionPendingError`
 *      so the BullMQ inbox job retries when the actor is not yet resolved),
 *   2. skips self-follows,
 *   3. calls oxy-api `POST /federation/follow` (action `follow`) BEFORE sending the
 *      Accept, so a retry never spams Accepts,
 *   4. sends the Accept, then
 *   5. creates a fail-soft follow notification.
 *
 * `handleUndo(Follow)` mirrors it: it locates the row first (idempotent no-op when
 * absent), removes the Oxy edge (only when the actor resolved) BEFORE deleting the
 * local row.
 *
 * Mock conventions follow the sibling `inboxOxyUserIdInvariant.test.ts`: the real
 * `InboxProcessingService` runs against mocked models / crypto / oxy client, so the
 * production dispatch path is exercised. `resolveOxyUser` is overridden on the real
 * `constants` module (it otherwise `require()`s the whole server), and
 * `followService.sendAccept` is spied so call order can be asserted.
 */

const mocks = vi.hoisted(() => ({
  getPublicKey: vi.fn(),
  signViaOxy: vi.fn(),
  signRequest: vi.fn(),
  actorFind: vi.fn(),
  actorFindOne: vi.fn(),
  actorFindOneAndUpdate: vi.fn(),
  actorUpdateOne: vi.fn(),
  followExists: vi.fn(),
  followFindOne: vi.fn(),
  followFindOneAndUpdate: vi.fn(),
  followDeleteOne: vi.fn(),
  followUpdateOne: vi.fn(),
  postFind: vi.fn(),
  postFindOne: vi.fn(),
  postFindById: vi.fn(),
  postUpdateOne: vi.fn(),
  postInsertMany: vi.fn(),
  postExists: vi.fn(),
  postDeleteOne: vi.fn(),
  likeCreate: vi.fn(),
  likeFindOneAndDelete: vi.fn(),
  getServiceOxyClient: vi.fn(),
  makeServiceRequest: vi.fn(),
  resolveOxyUser: vi.fn(),
  createNotification: vi.fn(),
  persistRemoteMedia: vi.fn(),
  recordAccess: vi.fn(),
  postCreatorCreate: vi.fn(),
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
  loggerDebug: vi.fn(),
  isFediverseSharingEnabledFromUser: vi.fn(),
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
    findOneAndUpdate: mocks.actorFindOneAndUpdate,
    updateOne: mocks.actorUpdateOne,
  },
}));

vi.mock('../../../models/FederatedFollow', () => ({
  default: {
    exists: mocks.followExists,
    findOne: mocks.followFindOne,
    findOneAndUpdate: mocks.followFindOneAndUpdate,
    deleteOne: mocks.followDeleteOne,
    updateOne: mocks.followUpdateOne,
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

vi.mock('../../../utils/notificationUtils', () => ({
  createNotification: mocks.createNotification,
  createMentionNotifications: vi.fn(),
  createWelcomeNotification: vi.fn(),
  createBatchNotifications: vi.fn(),
}));

vi.mock('../../../services/mediaCache/cacheWorker', () => ({
  persistRemoteMediaForFederatedOwnerDetailed: mocks.persistRemoteMedia,
}));

vi.mock('../../../services/mediaCache/cacheStore', () => ({
  recordAccessAndMaybeEnqueue: mocks.recordAccess,
}));

vi.mock('../../../services/fediverseSharing', () => ({
  isFediverseSharingEnabledFromUser: (...args: unknown[]) =>
    mocks.isFediverseSharingEnabledFromUser(...args),
}));

vi.mock('../../../services/serviceRegistry', () => ({
  getPostCreator: () => ({ create: mocks.postCreatorCreate }),
  registerPostFederator: vi.fn(),
  registerPostCreator: vi.fn(),
  getPostFederator: vi.fn(),
}));

// `resolveOxyUser` (in the real constants module) resolves the LOCAL user a Follow
// targets by `require()`-ing the whole server; override just that export while
// preserving every other real constant the connector graph reads at import.
vi.mock('../../../connectors/activitypub/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../connectors/activitypub/constants')>();
  return { ...actual, resolveOxyUser: mocks.resolveOxyUser };
});

import { followService } from '../../../connectors/activitypub/follow.service';
import { inboxProcessingService } from '../../../connectors/activitypub/inbox.service';
import { ActorResolutionPendingError } from '../../../connectors/shared/ActorResolutionPendingError';

const actorUri = 'https://mastodon.social/users/bob';
const localActorUri = 'https://mention.earth/ap/users/alice';
const followActivityId = `${actorUri}/follows/1`;

// `handleIncomingFollow` reads the follower's oxyUserId from `getOrFetchActor`,
// which (for a fresh cached actor) returns the mocked `FederatedActor.findOne`
// row directly with no network I/O.
function stubFollowerActor(oxyUserId: string | null): void {
  mocks.actorFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue(
      oxyUserId
        ? { uri: actorUri, oxyUserId, lastFetchedAt: new Date() }
        : { uri: actorUri, lastFetchedAt: new Date() },
    ),
  });
}

function followActivity() {
  return {
    id: followActivityId,
    type: 'Follow' as const,
    actor: actorUri,
    object: localActorUri,
  };
}

function undoFollowActivity() {
  return {
    id: `${followActivityId}/undo`,
    type: 'Undo' as const,
    actor: actorUri,
    object: {
      id: followActivityId,
      type: 'Follow' as const,
      actor: actorUri,
      object: localActorUri,
    },
  };
}

const sendAcceptSpy = vi.spyOn(followService, 'sendAccept');

beforeEach(() => {
  vi.clearAllMocks();

  mocks.getServiceOxyClient.mockReturnValue({ makeServiceRequest: mocks.makeServiceRequest });
  mocks.makeServiceRequest.mockResolvedValue({ created: true, counts: { followers: 1, following: 0 } });
  // The Follow targets local user `alice` → oxy id `oxy_alice`.
  mocks.resolveOxyUser.mockResolvedValue({ _id: 'oxy_alice' });
  mocks.followFindOneAndUpdate.mockResolvedValue({ _id: 'ff_1' });
  mocks.followDeleteOne.mockResolvedValue({ deletedCount: 1 });
  mocks.createNotification.mockResolvedValue(undefined);
  sendAcceptSpy.mockResolvedValue(undefined);
  mocks.isFediverseSharingEnabledFromUser.mockReturnValue(true);
});

describe('handleIncomingFollow — Oxy follow-graph bridge', () => {
  it('bridges the follow (correct payload) BEFORE sending Accept, then notifies', async () => {
    stubFollowerActor('oxy_bob');

    await inboxProcessingService.processInboxActivity(followActivity(), actorUri);

    expect(mocks.makeServiceRequest).toHaveBeenCalledWith('POST', '/federation/follow', {
      followerUserId: 'oxy_bob',
      targetUserId: 'oxy_alice',
      action: 'follow',
    });
    expect(sendAcceptSpy).toHaveBeenCalledWith('oxy_alice', 'alice', followActivityId, actorUri);

    // Bridge strictly precedes the Accept so a retry never re-delivers Accepts.
    const bridgeOrder = mocks.makeServiceRequest.mock.invocationCallOrder[0];
    const acceptOrder = sendAcceptSpy.mock.invocationCallOrder[0];
    expect(bridgeOrder).toBeLessThan(acceptOrder);

    expect(mocks.createNotification).toHaveBeenCalledWith({
      recipientId: 'oxy_alice',
      actorId: 'oxy_bob',
      type: 'follow',
      entityId: 'oxy_bob',
      entityType: 'profile',
    });
  });

  it('throws ActorResolutionPendingError and does not bridge or Accept when the actor has no oxyUserId', async () => {
    stubFollowerActor(null);

    await expect(
      inboxProcessingService.processInboxActivity(followActivity(), actorUri),
    ).rejects.toBeInstanceOf(ActorResolutionPendingError);

    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
    expect(sendAcceptSpy).not.toHaveBeenCalled();
  });

  it('skips the bridge and Accept for a self-follow', async () => {
    // The follower resolves to the SAME Oxy user as the follow target.
    mocks.resolveOxyUser.mockResolvedValue({ _id: 'oxy_alice' });
    stubFollowerActor('oxy_alice');

    await inboxProcessingService.processInboxActivity(followActivity(), actorUri);

    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
    expect(sendAcceptSpy).not.toHaveBeenCalled();
    expect(mocks.followFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('throws (job retry) and never Accepts when the bridge call fails', async () => {
    stubFollowerActor('oxy_bob');
    mocks.makeServiceRequest.mockRejectedValueOnce(new Error('oxy-api 503'));

    await expect(
      inboxProcessingService.processInboxActivity(followActivity(), actorUri),
    ).rejects.toThrow('oxy-api 503');

    expect(sendAcceptSpy).not.toHaveBeenCalled();
    expect(mocks.followFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('completes the follow even when the notification fails (fail-soft)', async () => {
    stubFollowerActor('oxy_bob');
    mocks.createNotification.mockRejectedValueOnce(new Error('notif backend down'));

    await expect(
      inboxProcessingService.processInboxActivity(followActivity(), actorUri),
    ).resolves.toBeUndefined();

    expect(mocks.makeServiceRequest).toHaveBeenCalledTimes(1);
    expect(sendAcceptSpy).toHaveBeenCalledTimes(1);
    expect(mocks.loggerWarn).toHaveBeenCalled();
  });
});

describe('handleIncomingFollow — dropped when the target has fediverse sharing off', () => {
  it('drops the follow silently right after resolving the local user, before touching the actor/bridge/Accept chain', async () => {
    mocks.isFediverseSharingEnabledFromUser.mockReturnValue(false);
    stubFollowerActor('oxy_bob');

    await expect(
      inboxProcessingService.processInboxActivity(followActivity(), actorUri),
    ).resolves.toBeUndefined();

    // Derived from the ALREADY-resolved local user (`resolveOxyUser`'s
    // result) — no second, separate Oxy lookup for the sharing flag.
    expect(mocks.isFediverseSharingEnabledFromUser).toHaveBeenCalledWith({ _id: 'oxy_alice' });
    // Gate runs BEFORE the follower actor fetch — no actor lookup, no bridge, no
    // Accept, no FederatedFollow row, and (since a Reject would be unverifiable
    // against a 404'd actor and would reveal the account exists) no Reject either.
    expect(mocks.actorFindOne).not.toHaveBeenCalled();
    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
    expect(sendAcceptSpy).not.toHaveBeenCalled();
    expect(mocks.followFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.followUpdateOne).not.toHaveBeenCalled();
    expect(mocks.createNotification).not.toHaveBeenCalled();
    expect(mocks.loggerDebug).toHaveBeenCalledWith(expect.stringContaining('alice'));
  });
});

describe('handleUndo(Follow) — Oxy follow-graph bridge', () => {
  it('removes the Oxy edge (unfollow) BEFORE deleting the local row', async () => {
    mocks.followFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({ _id: 'ff_1', localUserId: 'oxy_alice' }),
    });
    mocks.actorFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({ oxyUserId: 'oxy_bob' }),
    });

    await inboxProcessingService.processInboxActivity(undoFollowActivity(), actorUri);

    expect(mocks.makeServiceRequest).toHaveBeenCalledWith('POST', '/federation/follow', {
      followerUserId: 'oxy_bob',
      targetUserId: 'oxy_alice',
      action: 'unfollow',
    });
    expect(mocks.followDeleteOne).toHaveBeenCalledWith({ _id: 'ff_1' });

    const bridgeOrder = mocks.makeServiceRequest.mock.invocationCallOrder[0];
    const deleteOrder = mocks.followDeleteOne.mock.invocationCallOrder[0];
    expect(bridgeOrder).toBeLessThan(deleteOrder);
  });

  it('deletes the row without bridging when the actor never resolved to an Oxy user', async () => {
    mocks.followFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({ _id: 'ff_1', localUserId: 'oxy_alice' }),
    });
    mocks.actorFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({ uri: actorUri }), // no oxyUserId
    });

    await inboxProcessingService.processInboxActivity(undoFollowActivity(), actorUri);

    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
    expect(mocks.followDeleteOne).toHaveBeenCalledWith({ _id: 'ff_1' });
  });

  it('is a no-op when no matching follow row exists (already processed)', async () => {
    mocks.followFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    await inboxProcessingService.processInboxActivity(undoFollowActivity(), actorUri);

    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
    expect(mocks.followDeleteOne).not.toHaveBeenCalled();
    expect(mocks.actorFindOne).not.toHaveBeenCalled();
  });
});
