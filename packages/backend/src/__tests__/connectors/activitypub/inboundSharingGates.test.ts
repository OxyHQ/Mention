import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closePostgres, connectPostgres } from '../../../db/postgres';
import { eq } from 'drizzle-orm';
import { PostType } from '@mention/shared-types';
import { getDb } from '../../../db/postgres';
import { posts } from '../../../db/schema/posts';
import {
  clearFederationScope,
  federationScope,
  seedActor,
  seedChannel,
  seedFollow,
  seedLane,
  seedPost,
} from '../../helpers/federationFixtures';
import type { PostRecord } from '../../../db/posts/postRecord';

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
 * Drives the REAL `InboxProcessingService` against REAL `federated_actors`,
 * `federated_follows` and `posts` rows. `services/fediverseSharing` stays
 * mocked — it is the flag under test — and `outbox.service.ts` is mocked
 * wholesale, because its thread-linking/boost-import logic has its own
 * coverage and only the GATE matters here.
 *
 * The target post used to be a `Post.findOne` stub that answered by inspecting
 * the caller's FILTER SHAPE (`'status' in filter`, `filter.type === 'boost'`).
 * That routing table is a re-implementation of the queries under test, so it
 * could not distinguish a working lookup from one that matches nothing — and
 * "the owner is remote-owned" was a property the test asserted rather than a
 * property of a row. Both are real rows now, which also means
 * `resolvePostIdFromObjectUri` genuinely resolves the AP object URI back to a
 * local post id: the whole gate hangs off that resolution, and with a stub it
 * was assumed.
 */

const scope = federationScope('inbound-sharing-gates');
const ACTOR_URI = `${scope.origin}/users/bob`;
const OWNER_OXY_ID = scope.user('alice');
const BOOSTER_OXY_ID = scope.user('bob');

/**
 * The local post every activity in this file targets, seeded per test so its id
 * is the real one the AP object URI has to resolve back to.
 */
let target: PostRecord;
let targetUri: string;

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

vi.mock('../../../connectors/activitypub/outbox.service', () => ({
  outboxSyncService: {
    ensureFederatedReplyLink: (...args: unknown[]) => mocks.ensureFederatedReplyLink(...args),
    importAnnounce: (...args: unknown[]) => mocks.importAnnounce(...args),
    syncOutboxPosts: vi.fn(),
  },
}));

import { bumpPostCounters, loadPostRecord } from '../../../db/posts/postRepository';
import type { PostRecordInput } from '../../../db/posts/postRecord';
import { actorService } from '../../../connectors/activitypub/actor.service';
import { inboxProcessingService } from '../../../connectors/activitypub/inbox.service';

/**
 * The remote actor (author/liker/booster) the handlers resolve, as a real row.
 *
 * `lastFetchedAt: new Date()` makes the cached row FRESH, which is what keeps
 * `getOrFetchActor` from attempting a network fetch.
 */
function seedRemoteActor(oxyUserId: string | null): Promise<unknown> {
  return seedActor(scope, { username: 'bob', uri: ACTOR_URI, oxyUserId, lastFetchedAt: new Date() });
}

/**
 * Seed the activity target: a public, published, LOCALLY-owned post.
 *
 * `federation` stays absent, which is what makes the owner local and therefore
 * gate-able — `isLocalPostOwnerSharingEnabled` proceeds unconditionally for a
 * mirrored post, so this field is the difference between the gate running and
 * the gate being skipped.
 */
async function seedTarget(overrides: Partial<PostRecordInput> = {}): Promise<void> {
  target = await seedPost(scope, { oxyUserId: OWNER_OXY_ID, ...overrides });
  targetUri = `https://mention.earth/ap/users/alice/posts/${target.id}`;
}

/** The boost row a subsequent Undo(Announce) has to find and delete. */
async function seedBoost(announceId: string): Promise<PostRecord> {
  return seedPost(scope, {
    oxyUserId: BOOSTER_OXY_ID,
    type: PostType.BOOST,
    content: {},
    boostOf: target.id,
    federation: { activityId: announceId, actorUri: ACTOR_URI },
  });
}

/** The stored boost counters, for asserting an Undo actually decremented them. */
async function readCounters(postId: string): Promise<{ boosts: number; federatedBoosts: number }> {
  const [row] = await getDb()
    .select({
      boosts: posts.statsBoostsCount,
      federatedBoosts: posts.statsFederatedBoostsCount,
    })
    .from(posts)
    .where(eq(posts.id, postId));
  return row;
}

// `expect(actorFindOne).not.toHaveBeenCalled()` used to stand for "the gate ran
// before any actor resolution". With real rows there is no model call to count,
// so the claim is made against the resolver seam the handlers actually use.
const resolveActorSpy = vi.spyOn(actorService, 'resolveActorOxyUserId');

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearFederationScope(scope);

  mocks.materializeEngagementRelationship.mockResolvedValue({ changed: true });
  mocks.materializeEngagementTombstone.mockResolvedValue({ changed: true });
  mocks.postCreatorCreate.mockResolvedValue({ id: 'created_post_1' });
  mocks.importAnnounce.mockResolvedValue(true);
  mocks.isFediverseSharingEnabled.mockResolvedValue(true);
  await seedRemoteActor(BOOSTER_OXY_ID);
  // At least one local user follows the actor, so `handleCreate`'s follower gate
  // passes and the sharing gate is what the assertions below are measuring.
  await seedFollow(scope, {
    remoteActorUri: ACTOR_URI,
    direction: 'outbound',
    status: 'accepted',
  });
  await seedTarget();
  // Resolved lazily: a test that re-seeds the target (the mirrored-parent case)
  // must not have the thread link still pointing at the previous, LOCAL post —
  // which would run the gate on the wrong post and hide the property under test.
  mocks.ensureFederatedReplyLink.mockImplementation(async () => ({
    parentPostId: target.id,
    threadId: target.id,
  }));
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
        inReplyTo: targetUri,
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
    // A MIRRORED post: `federation != null`, so its "owner" is a federated actor
    // with no Mention consent to honour. The gate must not run at all.
    await seedTarget({
      oxyUserId: scope.user('remote-owner'),
      federation: { activityId: `${scope.origin}/statuses/mirrored`, actorUri: ACTOR_URI },
    });
    mocks.isFediverseSharingEnabled.mockResolvedValue(false);

    await inboxProcessingService.processInboxActivity(replyActivity(), ACTOR_URI);

    expect(mocks.isFediverseSharingEnabled).not.toHaveBeenCalled();
    expect(mocks.postCreatorCreate).toHaveBeenCalledTimes(1);
  });

  /**
   * A CHANNEL POST TAKES NO REPLIES, from a remote instance either — site 3 of
   * four for `utils/channelReplyGate`, at its real call site.
   *
   * The SHAPE of the refusal is the load-bearing part here and is asserted
   * explicitly: a DROP. `processInboxActivity` must RESOLVE, because a throw
   * fails the BullMQ inbox job into permanent retry, and any 4xx from an inbox
   * POST makes Mastodon stop delivering to this instance entirely — killing every
   * follow, accept, like and reply from that server, not just this one.
   */
  it('drops a reply to a CHANNEL post silently — resolves, never throws', async () => {
    // A REAL `channel_id` on a REAL parent row, not a mocked lookup.
    // `parentIsChannelPost` reads the column with `posts.id = <text>`, and the
    // guard it replaced (`ObjectId.isValid`) answered `false` for every uuid v7
    // id while looking present — a mocked `findById` cannot tell those apart,
    // because it never runs the predicate that was wrong.
    await seedTarget({ channelId: await seedChannel(scope) });

    await expect(
      inboxProcessingService.processInboxActivity(replyActivity(), ACTOR_URI),
    ).resolves.not.toThrow();

    expect(mocks.postCreatorCreate).not.toHaveBeenCalled();
  });

  it('CONTROL: a parent carrying only a laneId still accepts the reply', async () => {
    // A lane is a lens, not a destination — the gate must key off `channel_id`
    // alone, or every lane post would silently stop accepting federated replies.
    // This is also the case that makes the one above non-vacuous: the same
    // seeding path, one column different, opposite outcome.
    await seedTarget({ laneId: await seedLane(scope, { ownerId: OWNER_OXY_ID }) });

    await inboxProcessingService.processInboxActivity(replyActivity(), ACTOR_URI);

    expect(mocks.postCreatorCreate).toHaveBeenCalledTimes(1);
  });
});

describe('handleLike (gated) / handleUndoLike (ungated teardown) — target owner sharing', () => {
  function likeActivity() {
    return { id: `${ACTOR_URI}/likes/1`, type: 'Like' as const, actor: ACTOR_URI, object: targetUri };
  }
  function undoLikeActivity() {
    return {
      id: `${ACTOR_URI}/likes/1/undo`,
      type: 'Undo' as const,
      actor: ACTOR_URI,
      object: { id: `${ACTOR_URI}/likes/1`, type: 'Like' as const, actor: ACTOR_URI, object: targetUri },
    };
  }

  it('handleLike: records the like and increments the counter as today when enabled', async () => {
    await inboxProcessingService.processInboxActivity(likeActivity(), ACTOR_URI);

    expect(mocks.isFediverseSharingEnabled).toHaveBeenCalledWith(OWNER_OXY_ID);
    expect(mocks.materializeEngagementRelationship).toHaveBeenCalledWith({
      kind: 'like',
      userId: BOOSTER_OXY_ID,
      postId: target.id,
    });
  });

  it('handleLike: no Like row, no counter move, no actor resolution when the owner has sharing disabled', async () => {
    mocks.isFediverseSharingEnabled.mockResolvedValue(false);

    await inboxProcessingService.processInboxActivity(likeActivity(), ACTOR_URI);

    expect(mocks.materializeEngagementRelationship).not.toHaveBeenCalled();
    expect(resolveActorSpy).not.toHaveBeenCalled();
  });

  it('handleUndoLike: removes the like and decrements the counter as today when enabled', async () => {
    await inboxProcessingService.processInboxActivity(undoLikeActivity(), ACTOR_URI);

    expect(mocks.materializeEngagementTombstone).toHaveBeenCalledWith({
      kind: 'like',
      userId: BOOSTER_OXY_ID,
      postId: target.id,
    });
  });

  it('handleUndoLike: still processes the undo (row removed, counter decremented) when the owner has sharing disabled — teardown must converge', async () => {
    mocks.isFediverseSharingEnabled.mockResolvedValue(false);

    await inboxProcessingService.processInboxActivity(undoLikeActivity(), ACTOR_URI);

    expect(mocks.materializeEngagementTombstone).toHaveBeenCalledWith({
      kind: 'like',
      userId: BOOSTER_OXY_ID,
      postId: target.id,
    });
    // The sharing flag is never even consulted for an Undo.
    expect(mocks.isFediverseSharingEnabled).not.toHaveBeenCalled();
  });

  it('is not gated when the target is remote-owned/mirrored (federation != null)', async () => {
    // A MIRRORED post: `federation != null`, so its "owner" is a federated actor
    // with no Mention consent to honour. The gate must not run at all.
    await seedTarget({
      oxyUserId: scope.user('remote-owner'),
      federation: { activityId: `${scope.origin}/statuses/mirrored`, actorUri: ACTOR_URI },
    });
    mocks.isFediverseSharingEnabled.mockResolvedValue(false);

    await inboxProcessingService.processInboxActivity(likeActivity(), ACTOR_URI);

    expect(mocks.isFediverseSharingEnabled).not.toHaveBeenCalled();
    expect(mocks.materializeEngagementRelationship).toHaveBeenCalledWith({
      kind: 'like',
      userId: BOOSTER_OXY_ID,
      postId: target.id,
    });
  });
});

describe('handleAnnounce (gated) / handleUndoAnnounce (ungated teardown) — target owner sharing', () => {
  function announceActivity() {
    return {
      id: `${ACTOR_URI}/announces/1`,
      type: 'Announce' as const,
      actor: ACTOR_URI,
      object: targetUri,
      published: new Date().toISOString(),
    };
  }
  function undoAnnounceActivity() {
    return {
      id: `${ACTOR_URI}/announces/1/undo`,
      type: 'Undo' as const,
      actor: ACTOR_URI,
      object: { id: `${ACTOR_URI}/announces/1`, type: 'Announce' as const, actor: ACTOR_URI, object: targetUri },
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
    expect(resolveActorSpy).not.toHaveBeenCalled();
  });

  it('handleUndoAnnounce: removes the boost row and decrements BOTH counters when enabled', async () => {
    const boost = await seedBoost(`${ACTOR_URI}/announces/1`);
    await bumpPostCounters(target.id, { boosts: 1, federatedBoosts: 1 });

    await inboxProcessingService.processInboxActivity(undoAnnounceActivity(), ACTOR_URI);

    expect(await loadPostRecord(boost.id)).toBeNull();
    // Both, in lockstep: the import incremented both, and a decrement that moved
    // only `boosts` would leave `federatedBoosts` permanently overstating how
    // much of the count came from the fediverse.
    expect(await readCounters(target.id)).toEqual({ boosts: 0, federatedBoosts: 0 });
  });

  it("handleUndoAnnounce: never retracts ANOTHER actor's boost of the same post", async () => {
    // The FALLBACK path — an Undo that omits the original Announce id, which
    // Mastodon does — matches on (boostOf, booster, actorUri). Drop the actor
    // URI from that predicate and one remote server can retract another's boost
    // of the same post. The id path cannot be tested this way: a UNIQUE index on
    // `federation_activity_id` already makes two boosts sharing an Announce id
    // unstorable, which is worth knowing before writing a test for it.
    const mine = await seedBoost(`${ACTOR_URI}/announces/1`);
    const theirs = await seedPost(scope, {
      oxyUserId: scope.user('mallory'),
      type: PostType.BOOST,
      content: {},
      boostOf: target.id,
      federation: {
        activityId: `${scope.origin}/users/mallory/announces/1`,
        actorUri: `${scope.origin}/users/mallory`,
      },
    });
    await bumpPostCounters(target.id, { boosts: 2, federatedBoosts: 2 });

    await inboxProcessingService.processInboxActivity(
      {
        id: `${ACTOR_URI}/announces/1/undo`,
        type: 'Undo' as const,
        actor: ACTOR_URI,
        // No `id` on the inner Announce: the id lookup cannot fire.
        object: { type: 'Announce' as const, actor: ACTOR_URI, object: targetUri },
      },
      ACTOR_URI,
    );

    expect(await loadPostRecord(mine.id)).toBeNull();
    expect(await loadPostRecord(theirs.id)).not.toBeNull();
    expect(await readCounters(target.id)).toEqual({ boosts: 1, federatedBoosts: 1 });
  });

  it('handleUndoAnnounce: still converges when the owner has sharing disabled — teardown is ungated', async () => {
    const boost = await seedBoost(`${ACTOR_URI}/announces/1`);
    await bumpPostCounters(target.id, { boosts: 1, federatedBoosts: 1 });
    mocks.isFediverseSharingEnabled.mockResolvedValue(false);

    await inboxProcessingService.processInboxActivity(undoAnnounceActivity(), ACTOR_URI);

    expect(await loadPostRecord(boost.id)).toBeNull();
    expect(await readCounters(target.id)).toEqual({ boosts: 0, federatedBoosts: 0 });
    // The sharing flag is never even consulted for an Undo.
    expect(mocks.isFediverseSharingEnabled).not.toHaveBeenCalled();
  });

  it('is not gated when the announced post is remote-owned/mirrored (federation != null)', async () => {
    // A MIRRORED post: `federation != null`, so its "owner" is a federated actor
    // with no Mention consent to honour. The gate must not run at all.
    await seedTarget({
      oxyUserId: scope.user('remote-owner'),
      federation: { activityId: `${scope.origin}/statuses/mirrored`, actorUri: ACTOR_URI },
    });
    mocks.isFediverseSharingEnabled.mockResolvedValue(false);

    await inboxProcessingService.processInboxActivity(announceActivity(), ACTOR_URI);

    expect(mocks.isFediverseSharingEnabled).not.toHaveBeenCalled();
    expect(mocks.importAnnounce).toHaveBeenCalledTimes(1);
  });
});

afterEach(async () => {
  await clearFederationScope(scope);
});

afterAll(async () => {
  await closePostgres();
});
