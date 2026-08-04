import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closePostgres, connectPostgres } from '../../../db/postgres';
import {
  clearFederationScope,
  federationScope,
  seedActor,
  seedFollow,
  seedPost,
} from '../../helpers/federationFixtures';
import type { PostRecord, PostRecordInput } from '../../../db/posts/postRecord';

const scope = federationScope('inbound-engagement-notifications');

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

const ACTOR_URI = `${scope.origin}/users/bob`;
const CREATED_REPLY_ID = 'created_post_1';
const OWNER_OXY_ID = scope.user('alice');
const ACTOR_OXY_ID = scope.user('bob');

/**
 * The local post every activity here targets, seeded per test so the AP object
 * URI resolves back to a REAL row.
 *
 * Whether the owner is notifiable at all is decided by `federation` on that row —
 * a mirrored post's owner is a federated actor with no Mention inbox. Under the
 * previous `Post.findOne` stub that was a property the TEST asserted, not a
 * property of a row, and the stub answered by inspecting the caller's filter
 * shape, so a lookup that matched nothing was indistinguishable from a correct one.
 */
let target: PostRecord;
let targetUri: string;

async function seedTarget(overrides: Partial<PostRecordInput> = {}): Promise<void> {
  target = await seedPost(scope, { oxyUserId: OWNER_OXY_ID, ...overrides });
  targetUri = `https://mention.earth/ap/users/alice/posts/${target.id}`;
}

const mocks = vi.hoisted(() => ({
  getPublicKey: vi.fn(),
  signViaOxy: vi.fn(),
  signRequest: vi.fn(),
  materializeEngagementRelationship: vi.fn(),
  materializeEngagementTombstone: vi.fn(),
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

vi.mock('../../../services/PostEngagementCommandService', () => ({
  materializeEngagementRelationship: (...args: unknown[]) =>
    mocks.materializeEngagementRelationship(...args),
  materializeEngagementTombstone: (...args: unknown[]) =>
    mocks.materializeEngagementTombstone(...args),
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

// The channel reply gate resolves the parent author's account kind here.
vi.mock('../../../services/publishAsAccount', () => ({
  isChannelAccount: () => Promise.resolve(false),
}));

import { inboxProcessingService } from '../../../connectors/activitypub/inbox.service';

/** Stub the remote actor (liker/booster/reply-author) resolved via `FederatedActor.findOne`. */
async function seedRemoteActor(oxyUserId: string | null): Promise<void> {
  await seedActor(scope, { username: 'bob', uri: ACTOR_URI, oxyUserId, lastFetchedAt: new Date() });
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearFederationScope(scope);
  mocks.materializeEngagementRelationship.mockResolvedValue({ changed: true });
  mocks.materializeEngagementTombstone.mockResolvedValue({ changed: true });
  mocks.postCreatorCreate.mockResolvedValue({ id: CREATED_REPLY_ID });
  await seedTarget();
  mocks.ensureFederatedReplyLink.mockImplementation(async () => ({
    parentPostId: target.id,
    threadId: target.id,
  }));
  mocks.importAnnounce.mockResolvedValue(true);
  mocks.isFediverseSharingEnabled.mockResolvedValue(true);
  mocks.createPostAuthorNotifications.mockResolvedValue(undefined);
  await seedRemoteActor(ACTOR_OXY_ID);
  // A local user follows the actor, so `handleCreate`'s follower gate passes.
  await seedFollow(scope, { remoteActorUri: ACTOR_URI, direction: 'outbound', status: 'accepted' });
});

// ---------------------------------------------------------------------------
// handleLike
// ---------------------------------------------------------------------------

describe('handleLike — local owner like notification', () => {
  function likeActivity() {
    return { id: `${ACTOR_URI}/likes/1`, type: 'Like' as const, actor: ACTOR_URI, object: targetUri };
  }

  it('notifies the owner (type:"like") on a NEW inbound like, mirroring the native shape', async () => {
    await inboxProcessingService.processInboxActivity(likeActivity(), ACTOR_URI);

    expect(mocks.materializeEngagementRelationship).toHaveBeenCalledWith({
      kind: 'like',
      userId: ACTOR_OXY_ID,
      postId: target.id,
    });
    expect(mocks.createPostAuthorNotifications).toHaveBeenCalledWith(target.authorship, {
      actorId: ACTOR_OXY_ID,
      type: 'like',
      entityId: target.id,
      entityType: 'post',
    });
  });

  it('does NOT notify on a redelivered duplicate like', async () => {
    mocks.materializeEngagementRelationship.mockResolvedValueOnce({ changed: false });

    await inboxProcessingService.processInboxActivity(likeActivity(), ACTOR_URI);

    expect(mocks.materializeEngagementRelationship).toHaveBeenCalledTimes(1);
    expect(mocks.createPostAuthorNotifications).not.toHaveBeenCalled();
  });

  it('does NOT notify when the owner has fediverse sharing off', async () => {
    mocks.isFediverseSharingEnabled.mockResolvedValue(false);

    await inboxProcessingService.processInboxActivity(likeActivity(), ACTOR_URI);

    expect(mocks.materializeEngagementRelationship).not.toHaveBeenCalled();
    expect(mocks.createPostAuthorNotifications).not.toHaveBeenCalled();
  });

  it('does NOT notify when the liker actor is unresolved', async () => {
    // The actor exists but was never linked to an Oxy account.
    await clearFederationScope(scope);
    await seedRemoteActor(null);
    await seedFollow(scope, { remoteActorUri: ACTOR_URI, direction: 'outbound', status: 'accepted' });

    await inboxProcessingService.processInboxActivity(likeActivity(), ACTOR_URI);

    expect(mocks.materializeEngagementRelationship).not.toHaveBeenCalled();
    expect(mocks.createPostAuthorNotifications).not.toHaveBeenCalled();
  });

  it('records the like but does NOT notify for a REMOTE-owned/mirrored target (no local inbox)', async () => {
    // A MIRRORED target: its "owner" is a federated actor with no Mention
    // inbox, so the engagement is recorded and nobody is notified.
    await seedTarget({
      oxyUserId: scope.user('remote-owner'),
      federation: { activityId: `${scope.origin}/statuses/mirrored`, actorUri: ACTOR_URI },
    });

    await inboxProcessingService.processInboxActivity(likeActivity(), ACTOR_URI);

    expect(mocks.materializeEngagementRelationship).toHaveBeenCalledTimes(1);
    expect(mocks.createPostAuthorNotifications).not.toHaveBeenCalled();
  });

  it('is fail-soft: a notification failure never fails the inbox activity', async () => {
    mocks.createPostAuthorNotifications.mockRejectedValueOnce(new Error('notif backend down'));

    await expect(
      inboxProcessingService.processInboxActivity(likeActivity(), ACTOR_URI),
    ).resolves.toBeUndefined();

    expect(mocks.materializeEngagementRelationship).toHaveBeenCalledTimes(1);
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
      object: targetUri,
      published: new Date().toISOString(),
    };
  }

  it('notifies the owner (type:"boost") when a NEW boost is imported', async () => {
    await inboxProcessingService.processInboxActivity(announceActivity(), ACTOR_URI);

    expect(mocks.importAnnounce).toHaveBeenCalledTimes(1);
    expect(mocks.createPostAuthorNotifications).toHaveBeenCalledWith(target.authorship, {
      actorId: ACTOR_OXY_ID,
      type: 'boost',
      entityId: target.id,
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
    // The actor exists but was never linked to an Oxy account.
    await clearFederationScope(scope);
    await seedRemoteActor(null);
    await seedFollow(scope, { remoteActorUri: ACTOR_URI, direction: 'outbound', status: 'accepted' });

    await inboxProcessingService.processInboxActivity(announceActivity(), ACTOR_URI);

    expect(mocks.importAnnounce).not.toHaveBeenCalled();
    expect(mocks.createPostAuthorNotifications).not.toHaveBeenCalled();
  });

  it('imports the boost but does NOT notify for a REMOTE-owned/mirrored target', async () => {
    // A MIRRORED target: its "owner" is a federated actor with no Mention
    // inbox, so the engagement is recorded and nobody is notified.
    await seedTarget({
      oxyUserId: scope.user('remote-owner'),
      federation: { activityId: `${scope.origin}/statuses/mirrored`, actorUri: ACTOR_URI },
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
        inReplyTo: targetUri,
      },
    };
  }

  it('notifies the parent owner (type:"reply", entityId = the new reply post) on a NEW reply', async () => {
    await inboxProcessingService.processInboxActivity(replyActivity(), ACTOR_URI);

    expect(mocks.postCreatorCreate).toHaveBeenCalledTimes(1);
    expect(mocks.createPostAuthorNotifications).toHaveBeenCalledWith(target.authorship, {
      actorId: ACTOR_OXY_ID,
      type: 'reply',
      entityId: CREATED_REPLY_ID,
      entityType: 'reply',
    });
  });

  it('does NOT notify on a redelivered reply (activityId already stored)', async () => {
    // The dedupe is a REAL uniqueness check against `federation.activity_id`,
    // so the premise is a stored row rather than a stubbed `exists` answer —
    // which is what makes this distinguishable from a dedupe that never runs.
    await seedPost(scope, {
      oxyUserId: ACTOR_OXY_ID,
      parentPostId: target.id,
      isReply: true,
      federation: { activityId: `${ACTOR_URI}/statuses/900`, actorUri: ACTOR_URI },
    });

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
    // A MIRRORED target: its "owner" is a federated actor with no Mention
    // inbox, so the engagement is recorded and nobody is notified.
    await seedTarget({
      oxyUserId: scope.user('remote-owner'),
      federation: { activityId: `${scope.origin}/statuses/mirrored`, actorUri: ACTOR_URI },
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

afterEach(async () => {
  await clearFederationScope(scope);
});

afterAll(async () => {
  await closePostgres();
});
