import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Sharing-consent gate on the shared-inbox handlers that target an EXISTING
 * local post: a reply's parent (`handleCreate`), a Like target
 * (`handleLike`), and an Announce target (`handleAnnounce`).
 * `handleIncomingFollow`'s gate is covered separately in
 * `inboundFollowBridge.test.ts`.
 *
 * Once the target post's LOCAL owner has turned fediverse sharing off, every
 * one of these NEW-engagement activities must be dropped silently (debug
 * log, no DB writes, no counter moves) — the account is treated as if it
 * doesn't exist at the protocol layer, mirroring the Follow gate. A
 * REMOTE-owned/mirrored post (`federation != null`) must never be gated —
 * only a real local owner.
 *
 * `handleUndoLike` / `handleUndoAnnounce` are deliberately NOT gated (see
 * their doc comments in `inbox.service.ts`): an Undo is teardown, sent
 * exactly once by the remote server and never touched by the sharing
 * OFF-cleanup job, so it must always converge regardless of the current
 * sharing state — mirroring the pre-existing, likewise-ungated
 * `handleUndo(Follow)` branch. Covered here as a regression guard.
 *
 * Drives the REAL `InboxProcessingService` (same mocking convention as the
 * sibling `inboundFollowBridge.test.ts` / `inboxOxyUserIdInvariant.test.ts`:
 * mock the models + `services/fediverseSharing`, let `actor.service.ts` run
 * for real against the mocked `FederatedActor` model). `outbox.service.ts` is
 * mocked wholesale — its own thread-linking/boost-import logic has its own
 * dedicated test coverage; here only the GATE matters.
 */

const ACTOR_URI = 'https://mastodon.social/users/bob';
const TARGET_POST_ID = '507f1f77bcf86cd799439011';
const TARGET_POST_URI = `https://mention.earth/ap/users/alice/posts/${TARGET_POST_ID}`;
const OWNER_OXY_ID = 'oxy_alice';
const BOOSTER_OXY_ID = 'oxy_bob';

const mocks = vi.hoisted(() => ({
  getPublicKey: vi.fn(),
  signViaOxy: vi.fn(),
  signRequest: vi.fn(),
  actorFindOne: vi.fn(),
  followExists: vi.fn(),
  postFindOne: vi.fn(),
  postExists: vi.fn(),
  postUpdateOne: vi.fn(),
  postDeleteOne: vi.fn(),
  likeCreate: vi.fn(),
  likeFindOneAndDelete: vi.fn(),
  postCreatorCreate: vi.fn(),
  ensureFederatedReplyLink: vi.fn(),
  importAnnounce: vi.fn(),
  isFediverseSharingEnabled: vi.fn(),
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
  default: { findOne: mocks.actorFindOne },
}));

vi.mock('../../../models/FederatedFollow', () => ({
  default: { exists: mocks.followExists },
}));

vi.mock('../../../models/FederationDeliveryQueue', () => ({
  default: {},
  getNextRetryTime: vi.fn(),
}));

vi.mock('../../../models/Post', () => ({
  POST_CLASSIFICATION_PENDING: 'pending',
  Post: {
    findOne: mocks.postFindOne,
    exists: mocks.postExists,
    updateOne: mocks.postUpdateOne,
    deleteOne: mocks.postDeleteOne,
  },
}));

vi.mock('../../../models/Like', () => ({
  default: {
    create: mocks.likeCreate,
    findOneAndDelete: mocks.likeFindOneAndDelete,
  },
}));

vi.mock('../../../models/UserSettings', () => ({
  default: { updateOne: vi.fn() },
}));

vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: vi.fn(),
}));

vi.mock('../../../services/mediaCache/cacheWorker', () => ({
  persistRemoteMediaForFederatedOwnerDetailed: vi.fn(),
}));

vi.mock('../../../services/mediaCache/cacheStore', () => ({
  recordAccessAndMaybeEnqueue: vi.fn(),
}));

vi.mock('../../../services/serviceRegistry', () => ({
  getPostCreator: () => ({ create: mocks.postCreatorCreate }),
  registerPostFederator: vi.fn(),
  registerPostCreator: vi.fn(),
  getPostFederator: vi.fn(),
}));

vi.mock('../../../services/fediverseSharing', () => ({
  isFediverseSharingEnabled: (...args: unknown[]) => mocks.isFediverseSharingEnabled(...args),
}));

vi.mock('../../../connectors/activitypub/outbox.service', () => ({
  outboxSyncService: {
    ensureFederatedReplyLink: (...args: unknown[]) => mocks.ensureFederatedReplyLink(...args),
    importAnnounce: (...args: unknown[]) => mocks.importAnnounce(...args),
    syncOutboxPosts: vi.fn(),
  },
}));

import { inboxProcessingService } from '../../../connectors/activitypub/inbox.service';

/** Stub the remote actor (author/liker/booster) resolved via `FederatedActor.findOne`. */
function stubRemoteActor(oxyUserId: string | null): void {
  mocks.actorFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue(
      oxyUserId
        ? { uri: ACTOR_URI, oxyUserId, lastFetchedAt: new Date() }
        : { uri: ACTOR_URI, lastFetchedAt: new Date() },
    ),
  });
}

/**
 * Routes every `Post.findOne` call by its filter shape:
 *  - `resolvePostIdFromObjectUri`'s local-post-exists check (`status` present)
 *  - `isLocalPostOwnerSharingEnabled`'s owner lookup (bare `_id`)
 *  - `handleUndoAnnounce`'s boost-row lookup (`type: 'boost'`)
 */
function stubPostFindOne(options: {
  localPostExists?: boolean;
  owner?: { oxyUserId?: string | null; federation?: unknown } | null;
  boost?: { _id: string; boostOf?: string } | null;
} = {}): void {
  const { localPostExists = true, owner = { oxyUserId: OWNER_OXY_ID, federation: null }, boost = null } = options;
  mocks.postFindOne.mockImplementation((filter: Record<string, unknown>) => ({
    lean: async () => {
      if (filter.type === 'boost' || 'boostOf' in filter) return boost;
      if ('status' in filter) return localPostExists ? { _id: filter._id } : null;
      return owner;
    },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();

  mocks.followExists.mockResolvedValue({ _id: 'follow_1' });
  mocks.postExists.mockResolvedValue(null);
  mocks.postUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  mocks.postDeleteOne.mockResolvedValue({ deletedCount: 1 });
  mocks.likeCreate.mockResolvedValue({ _id: 'like_1' });
  mocks.likeFindOneAndDelete.mockReturnValue({ lean: vi.fn().mockResolvedValue({ _id: 'like_1' }) });
  mocks.postCreatorCreate.mockResolvedValue({ _id: 'created_post_1' });
  mocks.ensureFederatedReplyLink.mockResolvedValue({ parentPostId: TARGET_POST_ID, threadId: TARGET_POST_ID });
  mocks.importAnnounce.mockResolvedValue(true);
  mocks.isFediverseSharingEnabled.mockResolvedValue(true);
  stubRemoteActor(BOOSTER_OXY_ID);
  stubPostFindOne();
});

describe('handleCreate — reply targeting an opted-out parent-post owner', () => {
  function replyActivity() {
    return {
      id: `${ACTOR_URI}/statuses/900/activity`,
      type: 'Create' as const,
      actor: ACTOR_URI,
      object: {
        id: `${ACTOR_URI}/statuses/900`,
        type: 'Note' as const,
        attributedTo: ACTOR_URI,
        content: '<p>nice post</p>',
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        inReplyTo: TARGET_POST_URI,
      },
    };
  }

  it('materializes the reply as today when the parent owner has sharing enabled', async () => {
    mocks.isFediverseSharingEnabled.mockResolvedValue(true);

    await inboxProcessingService.processInboxActivity(replyActivity(), ACTOR_URI);

    expect(mocks.isFediverseSharingEnabled).toHaveBeenCalledWith(OWNER_OXY_ID);
    expect(mocks.postCreatorCreate).toHaveBeenCalledTimes(1);
  });

  it('drops the reply silently when the parent owner has sharing disabled', async () => {
    mocks.isFediverseSharingEnabled.mockResolvedValue(false);

    await inboxProcessingService.processInboxActivity(replyActivity(), ACTOR_URI);

    expect(mocks.postCreatorCreate).not.toHaveBeenCalled();
  });

  it('is not gated when the parent is remote-owned/mirrored (federation != null)', async () => {
    stubPostFindOne({ owner: { oxyUserId: 'remote_oxy_1', federation: { activityId: 'https://remote.example/1' } } });
    mocks.isFediverseSharingEnabled.mockResolvedValue(false);

    await inboxProcessingService.processInboxActivity(replyActivity(), ACTOR_URI);

    expect(mocks.isFediverseSharingEnabled).not.toHaveBeenCalled();
    expect(mocks.postCreatorCreate).toHaveBeenCalledTimes(1);
  });
});

describe('handleLike (gated) / handleUndoLike (ungated teardown) — target owner sharing', () => {
  function likeActivity() {
    return { id: `${ACTOR_URI}/likes/1`, type: 'Like' as const, actor: ACTOR_URI, object: TARGET_POST_URI };
  }
  function undoLikeActivity() {
    return {
      id: `${ACTOR_URI}/likes/1/undo`,
      type: 'Undo' as const,
      actor: ACTOR_URI,
      object: { id: `${ACTOR_URI}/likes/1`, type: 'Like' as const, actor: ACTOR_URI, object: TARGET_POST_URI },
    };
  }

  it('handleLike: records the like and increments the counter as today when enabled', async () => {
    await inboxProcessingService.processInboxActivity(likeActivity(), ACTOR_URI);

    expect(mocks.isFediverseSharingEnabled).toHaveBeenCalledWith(OWNER_OXY_ID);
    expect(mocks.likeCreate).toHaveBeenCalledWith({ userId: BOOSTER_OXY_ID, postId: TARGET_POST_ID, value: 1 });
    expect(mocks.postUpdateOne).toHaveBeenCalledWith(
      { _id: TARGET_POST_ID },
      { $inc: { 'stats.likesCount': 1 } },
    );
  });

  it('handleLike: no Like row, no counter move, no actor resolution when the owner has sharing disabled', async () => {
    mocks.isFediverseSharingEnabled.mockResolvedValue(false);

    await inboxProcessingService.processInboxActivity(likeActivity(), ACTOR_URI);

    expect(mocks.likeCreate).not.toHaveBeenCalled();
    expect(mocks.postUpdateOne).not.toHaveBeenCalled();
    expect(mocks.actorFindOne).not.toHaveBeenCalled();
  });

  it('handleUndoLike: removes the like and decrements the counter as today when enabled', async () => {
    await inboxProcessingService.processInboxActivity(undoLikeActivity(), ACTOR_URI);

    expect(mocks.likeFindOneAndDelete).toHaveBeenCalledWith({
      userId: BOOSTER_OXY_ID,
      postId: TARGET_POST_ID,
      value: 1,
    });
    expect(mocks.postUpdateOne).toHaveBeenCalledWith(
      { _id: TARGET_POST_ID, 'stats.likesCount': { $gt: 0 } },
      { $inc: { 'stats.likesCount': -1 } },
    );
  });

  it('handleUndoLike: still processes the undo (row removed, counter decremented) when the owner has sharing disabled — teardown must converge', async () => {
    mocks.isFediverseSharingEnabled.mockResolvedValue(false);

    await inboxProcessingService.processInboxActivity(undoLikeActivity(), ACTOR_URI);

    expect(mocks.likeFindOneAndDelete).toHaveBeenCalledWith({
      userId: BOOSTER_OXY_ID,
      postId: TARGET_POST_ID,
      value: 1,
    });
    expect(mocks.postUpdateOne).toHaveBeenCalledWith(
      { _id: TARGET_POST_ID, 'stats.likesCount': { $gt: 0 } },
      { $inc: { 'stats.likesCount': -1 } },
    );
    // The sharing flag is never even consulted for an Undo.
    expect(mocks.isFediverseSharingEnabled).not.toHaveBeenCalled();
  });

  it('is not gated when the target is remote-owned/mirrored (federation != null)', async () => {
    stubPostFindOne({ owner: { oxyUserId: 'remote_oxy_1', federation: { activityId: 'https://remote.example/1' } } });
    mocks.isFediverseSharingEnabled.mockResolvedValue(false);

    await inboxProcessingService.processInboxActivity(likeActivity(), ACTOR_URI);

    expect(mocks.isFediverseSharingEnabled).not.toHaveBeenCalled();
    expect(mocks.likeCreate).toHaveBeenCalledTimes(1);
  });
});

describe('handleAnnounce (gated) / handleUndoAnnounce (ungated teardown) — target owner sharing', () => {
  function announceActivity() {
    return {
      id: `${ACTOR_URI}/announces/1`,
      type: 'Announce' as const,
      actor: ACTOR_URI,
      object: TARGET_POST_URI,
      published: new Date().toISOString(),
    };
  }
  function undoAnnounceActivity() {
    return {
      id: `${ACTOR_URI}/announces/1/undo`,
      type: 'Undo' as const,
      actor: ACTOR_URI,
      object: { id: `${ACTOR_URI}/announces/1`, type: 'Announce' as const, actor: ACTOR_URI, object: TARGET_POST_URI },
    };
  }

  it('handleAnnounce: imports the boost as today when the owner has sharing enabled', async () => {
    await inboxProcessingService.processInboxActivity(announceActivity(), ACTOR_URI);

    expect(mocks.isFediverseSharingEnabled).toHaveBeenCalledWith(OWNER_OXY_ID);
    expect(mocks.importAnnounce).toHaveBeenCalledTimes(1);
  });

  it('handleAnnounce: no boost imported, no booster resolution when the owner has sharing disabled', async () => {
    mocks.isFediverseSharingEnabled.mockResolvedValue(false);

    await inboxProcessingService.processInboxActivity(announceActivity(), ACTOR_URI);

    expect(mocks.importAnnounce).not.toHaveBeenCalled();
    expect(mocks.actorFindOne).not.toHaveBeenCalled();
  });

  it('handleUndoAnnounce: removes the boost and decrements the counter as today when enabled', async () => {
    stubPostFindOne({ boost: { _id: 'boost_1', boostOf: TARGET_POST_ID } });

    await inboxProcessingService.processInboxActivity(undoAnnounceActivity(), ACTOR_URI);

    expect(mocks.postDeleteOne).toHaveBeenCalledWith({ _id: 'boost_1' });
    expect(mocks.postUpdateOne).toHaveBeenCalledWith(
      { _id: TARGET_POST_ID, 'stats.boostsCount': { $gt: 0 } },
      { $inc: { 'stats.boostsCount': -1 } },
    );
  });

  it('handleUndoAnnounce: still processes the undo (boost removed, counter decremented) when the owner has sharing disabled — teardown must converge', async () => {
    stubPostFindOne({ boost: { _id: 'boost_1', boostOf: TARGET_POST_ID } });
    mocks.isFediverseSharingEnabled.mockResolvedValue(false);

    await inboxProcessingService.processInboxActivity(undoAnnounceActivity(), ACTOR_URI);

    expect(mocks.postDeleteOne).toHaveBeenCalledWith({ _id: 'boost_1' });
    expect(mocks.postUpdateOne).toHaveBeenCalledWith(
      { _id: TARGET_POST_ID, 'stats.boostsCount': { $gt: 0 } },
      { $inc: { 'stats.boostsCount': -1 } },
    );
    // The sharing flag is never even consulted for an Undo.
    expect(mocks.isFediverseSharingEnabled).not.toHaveBeenCalled();
  });

  it('is not gated when the announced post is remote-owned/mirrored (federation != null)', async () => {
    stubPostFindOne({ owner: { oxyUserId: 'remote_oxy_1', federation: { activityId: 'https://remote.example/1' } } });
    mocks.isFediverseSharingEnabled.mockResolvedValue(false);

    await inboxProcessingService.processInboxActivity(announceActivity(), ACTOR_URI);

    expect(mocks.isFediverseSharingEnabled).not.toHaveBeenCalled();
    expect(mocks.importAnnounce).toHaveBeenCalledTimes(1);
  });
});
