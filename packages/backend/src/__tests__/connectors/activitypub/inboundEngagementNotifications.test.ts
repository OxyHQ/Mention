import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Inbound federated engagement → LOCAL owner notification parity.
 *
 * A like/boost/reply from the fediverse on a LOCAL Mention post must reach the
 * owner's notifications exactly like the native equivalent — the same
 * `createPostAuthorNotifications` util the local `posts.controller` (like) and
 * `PostCreationService` (reply/boost) paths call, mirroring
 * `handleIncomingFollow`'s already-present follow notification.
 *
 * These pin, per handler:
 *   - handleLike     → `type:'like'`  (entityId = the liked post)
 *   - handleAnnounce → `type:'boost'` (entityId = the boosted post)
 *   - handleCreate   → `type:'reply'` (entityId = the NEW reply post) to the parent owner
 *
 * and for each: the notification fires ONLY on genuinely-NEW engagement — never
 * on a redelivered duplicate, never when the target owner has sharing OFF, and
 * never when the remote actor is unresolved. A REMOTE-owned/mirrored target
 * (`federation != null`) records the engagement but is never notified (no local
 * inbox). A notification failure is fail-soft — it never fails the inbox job.
 *
 * Drives the REAL `InboxProcessingService` with the same mocking convention as
 * the sibling `inboundSharingGates.test.ts`: mock the models + the notification
 * util + `services/fediverseSharing`, let `actor.service.ts` run for real
 * against the mocked `FederatedActor` model, and mock `outbox.service.ts`
 * wholesale (its thread-link/boost-import logic has its own coverage).
 */

const ACTOR_URI = 'https://mastodon.social/users/bob';
const TARGET_POST_ID = '507f1f77bcf86cd799439011';
const TARGET_POST_URI = `https://mention.earth/ap/users/alice/posts/${TARGET_POST_ID}`;
const CREATED_REPLY_ID = 'created_post_1';
const OWNER_OXY_ID = 'oxy_alice';
const ACTOR_OXY_ID = 'oxy_bob';
const OWNER_AUTHORSHIP = [{ userId: OWNER_OXY_ID, role: 'owner', status: 'accepted' }];

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
  createPostAuthorNotifications: vi.fn(),
  createNotification: vi.fn(),
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

// The notification util is imported LAZILY inside the handlers (to avoid the
// load-time server cycle); this module mock intercepts that dynamic import too.
vi.mock('../../../utils/notificationUtils', () => ({
  createPostAuthorNotifications: mocks.createPostAuthorNotifications,
  createNotification: mocks.createNotification,
  createMentionNotifications: vi.fn(),
  createWelcomeNotification: vi.fn(),
  createBatchNotifications: vi.fn(),
}));

vi.mock('../../../connectors/activitypub/outbox.service', () => ({
  outboxSyncService: {
    ensureFederatedReplyLink: (...args: unknown[]) => mocks.ensureFederatedReplyLink(...args),
    importAnnounce: (...args: unknown[]) => mocks.importAnnounce(...args),
    syncOutboxPosts: vi.fn(),
  },
}));

import { inboxProcessingService } from '../../../connectors/activitypub/inbox.service';

/** Stub the remote actor (liker/booster/reply-author) resolved via `FederatedActor.findOne`. */
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
 *  - `isLocalPostOwnerSharingEnabled` (owner gate) AND
 *    `notifyLocalPostOwnerOfEngagement` (owner notify) — both bare `{_id}`,
 *    served by the same `owner` doc (gate reads oxyUserId/federation; notify
 *    reads authorship/federation).
 */
function stubPostFindOne(options: {
  localPostExists?: boolean;
  owner?: { oxyUserId?: string | null; federation?: unknown; authorship?: unknown } | null;
} = {}): void {
  const {
    localPostExists = true,
    owner = { oxyUserId: OWNER_OXY_ID, federation: null, authorship: OWNER_AUTHORSHIP },
  } = options;
  mocks.postFindOne.mockImplementation((filter: Record<string, unknown>) => ({
    lean: async () => {
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
  mocks.likeCreate.mockResolvedValue({ _id: 'like_1' });
  mocks.postCreatorCreate.mockResolvedValue({ _id: CREATED_REPLY_ID });
  mocks.ensureFederatedReplyLink.mockResolvedValue({ parentPostId: TARGET_POST_ID, threadId: TARGET_POST_ID });
  mocks.importAnnounce.mockResolvedValue(true);
  mocks.isFediverseSharingEnabled.mockResolvedValue(true);
  mocks.createPostAuthorNotifications.mockResolvedValue(undefined);
  stubRemoteActor(ACTOR_OXY_ID);
  stubPostFindOne();
});

// ---------------------------------------------------------------------------
// handleLike
// ---------------------------------------------------------------------------

describe('handleLike — local owner like notification', () => {
  function likeActivity() {
    return { id: `${ACTOR_URI}/likes/1`, type: 'Like' as const, actor: ACTOR_URI, object: TARGET_POST_URI };
  }

  it('notifies the owner (type:"like") on a NEW inbound like, mirroring the native shape', async () => {
    await inboxProcessingService.processInboxActivity(likeActivity(), ACTOR_URI);

    expect(mocks.likeCreate).toHaveBeenCalledWith({ userId: ACTOR_OXY_ID, postId: TARGET_POST_ID, value: 1 });
    expect(mocks.createPostAuthorNotifications).toHaveBeenCalledWith(OWNER_AUTHORSHIP, {
      actorId: ACTOR_OXY_ID,
      type: 'like',
      entityId: TARGET_POST_ID,
      entityType: 'post',
    });
  });

  it('does NOT notify on a redelivered duplicate like (duplicate-key insert)', async () => {
    mocks.likeCreate.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }));

    await inboxProcessingService.processInboxActivity(likeActivity(), ACTOR_URI);

    expect(mocks.likeCreate).toHaveBeenCalledTimes(1);
    expect(mocks.postUpdateOne).not.toHaveBeenCalled();
    expect(mocks.createPostAuthorNotifications).not.toHaveBeenCalled();
  });

  it('does NOT notify when the owner has fediverse sharing off', async () => {
    mocks.isFediverseSharingEnabled.mockResolvedValue(false);

    await inboxProcessingService.processInboxActivity(likeActivity(), ACTOR_URI);

    expect(mocks.likeCreate).not.toHaveBeenCalled();
    expect(mocks.createPostAuthorNotifications).not.toHaveBeenCalled();
  });

  it('does NOT notify when the liker actor is unresolved', async () => {
    stubRemoteActor(null);

    await inboxProcessingService.processInboxActivity(likeActivity(), ACTOR_URI);

    expect(mocks.likeCreate).not.toHaveBeenCalled();
    expect(mocks.createPostAuthorNotifications).not.toHaveBeenCalled();
  });

  it('records the like but does NOT notify for a REMOTE-owned/mirrored target (no local inbox)', async () => {
    stubPostFindOne({
      owner: { oxyUserId: 'remote_oxy_1', federation: { activityId: 'https://remote.example/1' }, authorship: OWNER_AUTHORSHIP },
    });

    await inboxProcessingService.processInboxActivity(likeActivity(), ACTOR_URI);

    expect(mocks.likeCreate).toHaveBeenCalledTimes(1);
    expect(mocks.createPostAuthorNotifications).not.toHaveBeenCalled();
  });

  it('is fail-soft: a notification failure never fails the inbox activity', async () => {
    mocks.createPostAuthorNotifications.mockRejectedValueOnce(new Error('notif backend down'));

    await expect(
      inboxProcessingService.processInboxActivity(likeActivity(), ACTOR_URI),
    ).resolves.toBeUndefined();

    expect(mocks.likeCreate).toHaveBeenCalledTimes(1);
    expect(mocks.postUpdateOne).toHaveBeenCalledTimes(1);
    expect(mocks.loggerWarn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleAnnounce
// ---------------------------------------------------------------------------

describe('handleAnnounce — local owner boost notification', () => {
  function announceActivity() {
    return {
      id: `${ACTOR_URI}/announces/1`,
      type: 'Announce' as const,
      actor: ACTOR_URI,
      object: TARGET_POST_URI,
      published: new Date().toISOString(),
    };
  }

  it('notifies the owner (type:"boost") when a NEW boost is imported', async () => {
    await inboxProcessingService.processInboxActivity(announceActivity(), ACTOR_URI);

    expect(mocks.importAnnounce).toHaveBeenCalledTimes(1);
    expect(mocks.createPostAuthorNotifications).toHaveBeenCalledWith(OWNER_AUTHORSHIP, {
      actorId: ACTOR_OXY_ID,
      type: 'boost',
      entityId: TARGET_POST_ID,
      entityType: 'post',
    });
  });

  it('does NOT notify on a redelivered Announce (importAnnounce reports no new boost)', async () => {
    mocks.importAnnounce.mockResolvedValue(false);

    await inboxProcessingService.processInboxActivity(announceActivity(), ACTOR_URI);

    expect(mocks.createPostAuthorNotifications).not.toHaveBeenCalled();
  });

  it('does NOT notify when the owner has fediverse sharing off', async () => {
    mocks.isFediverseSharingEnabled.mockResolvedValue(false);

    await inboxProcessingService.processInboxActivity(announceActivity(), ACTOR_URI);

    expect(mocks.importAnnounce).not.toHaveBeenCalled();
    expect(mocks.createPostAuthorNotifications).not.toHaveBeenCalled();
  });

  it('does NOT notify when the booster actor is unresolved', async () => {
    stubRemoteActor(null);

    await inboxProcessingService.processInboxActivity(announceActivity(), ACTOR_URI);

    expect(mocks.importAnnounce).not.toHaveBeenCalled();
    expect(mocks.createPostAuthorNotifications).not.toHaveBeenCalled();
  });

  it('imports the boost but does NOT notify for a REMOTE-owned/mirrored target', async () => {
    stubPostFindOne({
      owner: { oxyUserId: 'remote_oxy_1', federation: { activityId: 'https://remote.example/1' }, authorship: OWNER_AUTHORSHIP },
    });

    await inboxProcessingService.processInboxActivity(announceActivity(), ACTOR_URI);

    expect(mocks.importAnnounce).toHaveBeenCalledTimes(1);
    expect(mocks.createPostAuthorNotifications).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleCreate (federated reply)
// ---------------------------------------------------------------------------

describe('handleCreate — reply notification to the local parent owner', () => {
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

  it('notifies the parent owner (type:"reply", entityId = the new reply post) on a NEW reply', async () => {
    await inboxProcessingService.processInboxActivity(replyActivity(), ACTOR_URI);

    expect(mocks.postCreatorCreate).toHaveBeenCalledTimes(1);
    expect(mocks.createPostAuthorNotifications).toHaveBeenCalledWith(OWNER_AUTHORSHIP, {
      actorId: ACTOR_OXY_ID,
      type: 'reply',
      entityId: CREATED_REPLY_ID,
      entityType: 'reply',
    });
  });

  it('does NOT notify on a redelivered reply (activityId already stored)', async () => {
    mocks.postExists.mockResolvedValue({ _id: 'already_here' });

    await inboxProcessingService.processInboxActivity(replyActivity(), ACTOR_URI);

    expect(mocks.postCreatorCreate).not.toHaveBeenCalled();
    expect(mocks.createPostAuthorNotifications).not.toHaveBeenCalled();
  });

  it('does NOT notify when the parent owner has fediverse sharing off (reply dropped)', async () => {
    mocks.isFediverseSharingEnabled.mockResolvedValue(false);

    await inboxProcessingService.processInboxActivity(replyActivity(), ACTOR_URI);

    expect(mocks.postCreatorCreate).not.toHaveBeenCalled();
    expect(mocks.createPostAuthorNotifications).not.toHaveBeenCalled();
  });

  it('does NOT notify for a REMOTE-owned/mirrored parent (materialized but no local inbox)', async () => {
    stubPostFindOne({
      owner: { oxyUserId: 'remote_oxy_1', federation: { activityId: 'https://remote.example/1' }, authorship: OWNER_AUTHORSHIP },
    });

    await inboxProcessingService.processInboxActivity(replyActivity(), ACTOR_URI);

    expect(mocks.postCreatorCreate).toHaveBeenCalledTimes(1);
    expect(mocks.createPostAuthorNotifications).not.toHaveBeenCalled();
  });

  it('does NOT notify for a non-reply top-level federated post (no parent)', async () => {
    mocks.ensureFederatedReplyLink.mockResolvedValue(null);
    const activity = replyActivity();
    delete (activity.object as { inReplyTo?: unknown }).inReplyTo;

    await inboxProcessingService.processInboxActivity(activity, ACTOR_URI);

    expect(mocks.postCreatorCreate).toHaveBeenCalledTimes(1);
    expect(mocks.createPostAuthorNotifications).not.toHaveBeenCalled();
  });
});
