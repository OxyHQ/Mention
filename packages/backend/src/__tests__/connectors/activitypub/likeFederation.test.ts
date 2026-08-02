import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Outbound like federation (PART 3): a like of a FEDERATED post notifies its
 * ORIGIN author with a `Like` (or `Undo(Like)`) delivered ONLY to that author's
 * inbox — a like is never fanned out to the liker's own followers. Local-post
 * likes are a no-op (the author is notified natively via the `Like` doc).
 *
 * These pin:
 *   - `federateLike` on a FEDERATED post → a `Like` whose `object` is the liked
 *     original's `federation.activityId`, a deterministic id from the Like doc,
 *     delivered to the origin author inbox ONLY (never a follower inbox);
 *   - `federateUndoLike` → the matching `Undo(Like)` re-minting the same Like id;
 *   - a LOCAL post like → no delivery at all;
 *   - the sharing gate short-circuit.
 *
 * The delivery/queue layer and the Oxy client are mocked so the real
 * `FollowService` runs in isolation; assertions read the captured
 * `enqueueDelivery` calls. The actor, follow and POST rows are all real Postgres
 * rows — "delivered to the origin author inbox ONLY" is only meaningful if the
 * liker's follower inboxes genuinely exist and were genuinely not chosen, which
 * a `find().lean()` double asserted about itself; and whether a like has a
 * remote object to point at is decided by the liked post's own row, so stubbing
 * that read would only prove the delivery layer does the right thing with a
 * hand-written object.
 */

const {
  enqueueDelivery,
  isFediverseSharingEnabled,
  getUserById,
  insertMany,
  fallbackCreate,
} = vi.hoisted(() => ({
  enqueueDelivery: vi.fn(),
  isFediverseSharingEnabled: vi.fn(),
  getUserById: vi.fn(),
  insertMany: vi.fn(),
  fallbackCreate: vi.fn(),
}));

vi.mock('../../../connectors/activitypub/constants', async () => {
  const actual = await vi.importActual<typeof import('../../../connectors/activitypub/constants')>(
    '../../../connectors/activitypub/constants',
  );
  return { ...actual, FEDERATION_ENABLED: true };
});
vi.mock('../../../connectors/activitypub/actor.service', () => ({ actorService: {} }));
vi.mock('../../../connectors/activitypub/crypto', () => ({ getPublicKey: vi.fn(), signRequest: vi.fn() }));
vi.mock('../../../queue/producers', () => ({ enqueueDelivery, enqueueInboxActivity: vi.fn() }));
// The durable fallback queue is a FAILURE-INJECTION seam (the suites below
// simulate it rejecting), so it keeps its double — now on the repository the
// delivery engine actually calls.
vi.mock('../../../db/federation/deliveryQueueRepository', () => ({
  insertDeliveries: insertMany,
  insertDelivery: fallbackCreate,
}));
vi.mock('../../../utils/safeUpstreamFetch', () => ({ fetchUpstreamSingleHop: vi.fn() }));
vi.mock('@oxyhq/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxyhq/core/server')>()),
  assertSafePublicUrl: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../../../utils/mediaResolver', () => ({
  resolveMediaRef: (ref: string) => ({ url: `https://cloud.oxy.so/${ref}` }),
  resolveAvatarUrl: (ref: string) => `https://cloud.oxy.so/${ref}`,
}));
vi.mock('../../../services/fediverseSharing', () => ({ isFediverseSharingEnabled }));
vi.mock('../../../utils/oxyHelpers', () => ({ getServiceOxyClient: () => ({ getUserById }) }));

import { closePostgres, connectPostgres } from '../../../db/postgres';
import {
  clearFederationScope,
  federationScope,
  seedActor,
  seedFollow,
  seedPost,
} from '../../helpers/federationFixtures';
import { followService } from '../../../connectors/activitypub/follow.service';

const ALICE_ACTOR = 'https://mention.earth/ap/users/alice';
const scope = federationScope('like-federation');
const ORIGIN_ACTOR = `${scope.origin}/users/bob`;
const ORIGIN_INBOX = `${scope.origin}/inbox`;
const ORIGIN_NOTE = `${ORIGIN_ACTOR}/statuses/9`;
const FOLLOWER_ACTOR = `${scope.origin}/users/x`;
const FOLLOWER_INBOX = `${scope.origin}/follower-inbox`;

/** A FEDERATED liked original: its remote activity id + author actor row. */
async function seedFederatedTarget(): Promise<string> {
  const post = await seedPost(scope, {
    oxyUserId: scope.user('orig-owner'),
    federation: { activityId: ORIGIN_NOTE, actorUri: ORIGIN_ACTOR },
  });
  // `resolveFederationTarget` reads the remote author's row for its inbox.
  await seedActor(scope, {
    username: 'bob',
    uri: ORIGIN_ACTOR,
    sharedInboxUrl: ORIGIN_INBOX,
    inboxUrl: ORIGIN_INBOX,
  });
  return post.id;
}

/** A LOCAL liked original: no federation block, so there is no remote inbox. */
async function seedLocalTarget(): Promise<string> {
  const post = await seedPost(scope, { oxyUserId: scope.user('local-owner') });
  return post.id;
}

/** The liker's OWN follower — present so "not fanned out" can be observed. */
async function seedLikerFollower(): Promise<void> {
  await seedActor(scope, {
    username: 'x',
    uri: FOLLOWER_ACTOR,
    sharedInboxUrl: FOLLOWER_INBOX,
    inboxUrl: FOLLOWER_INBOX,
  });
  await seedFollow(scope, {
    localUserId: USER_LIKER_OXY,
    remoteActorUri: FOLLOWER_ACTOR,
    direction: 'inbound',
    status: 'accepted',
  });
}

/** The distinct target inboxes `enqueueDelivery` was asked to deliver to. */
function deliveredInboxes(): string[] {
  return enqueueDelivery.mock.calls.map((c) => (c[0] as { targetInbox: string }).targetInbox);
}

/** The activity enqueued. */
function deliveredActivity(): Record<string, unknown> {
  return (enqueueDelivery.mock.calls[0]?.[0] as { activityJson: Record<string, unknown> }).activityJson;
}

const USER_LIKER_OXY = scope.user('liker-oxy');

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearFederationScope(scope);
  enqueueDelivery.mockResolvedValue(true);
  fallbackCreate.mockResolvedValue(undefined);
  isFediverseSharingEnabled.mockResolvedValue(true);
  getUserById.mockResolvedValue({ id: 'u', username: 'bob' });
});

afterEach(async () => {
  await clearFederationScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('federateLike — Like to origin', () => {
  it('sends a Like of the remote activity id to the origin author inbox ONLY', async () => {
    const postId = await seedFederatedTarget();
    // The liker's own follower EXISTS in the graph; a like must still not fan out.
    await seedLikerFollower();

    await followService.federateLike({ _id: 'like1', postId }, USER_LIKER_OXY, 'alice');

    const activity = deliveredActivity();
    expect(activity.type).toBe('Like');
    expect(activity.actor).toBe(ALICE_ACTOR);
    expect(activity.id).toBe(`${ALICE_ACTOR}/likes/like1`);
    expect(activity.object).toBe(ORIGIN_NOTE);

    // Delivered to the origin author inbox only — never the liker's follower inbox.
    expect(deliveredInboxes()).toEqual([ORIGIN_INBOX]);
    expect(deliveredInboxes()).not.toContain(FOLLOWER_INBOX);
  });

  it('is a no-op for a LOCAL liked post (no remote inbox)', async () => {
    // A local original: no federation block → resolveFederationTarget yields no
    // author inbox, so nothing is delivered over ActivityPub.
    const postId = await seedLocalTarget();
    getUserById.mockResolvedValue({ id: 'local-owner', username: 'bob' });

    await followService.federateLike({ _id: 'like1', postId }, USER_LIKER_OXY, 'alice');

    expect(enqueueDelivery).not.toHaveBeenCalled();
  });

  it('skips entirely when sharing is disabled', async () => {
    isFediverseSharingEnabled.mockResolvedValue(false);

    const postId = await seedFederatedTarget();

    await followService.federateLike({ _id: 'like1', postId }, USER_LIKER_OXY, 'alice');

    expect(enqueueDelivery).not.toHaveBeenCalled();
  });

  it('keeps the public path best-effort but propagates queue failure from the durable path', async () => {
    const postId = await seedFederatedTarget();
    enqueueDelivery.mockRejectedValue(new Error('delivery queue unavailable'));
    fallbackCreate.mockRejectedValue(new Error('delivery queue unavailable'));

    await expect(
      followService.federateLike({ _id: 'like1', postId }, USER_LIKER_OXY, 'alice'),
    ).resolves.toBeUndefined();

    await expect(
      followService.federateLikeStrict({ _id: 'like1', postId }, USER_LIKER_OXY, 'alice'),
    ).rejects.toThrow('delivery queue unavailable');
  });
});

describe('federateUndoLike — Undo(Like) to origin', () => {
  it('retracts a like with an Undo(Like) re-minting the same Like id', async () => {
    const postId = await seedFederatedTarget();

    await followService.federateUndoLike({ _id: 'like1', postId }, USER_LIKER_OXY, 'alice');

    const activity = deliveredActivity();
    expect(activity.type).toBe('Undo');
    expect(activity.actor).toBe(ALICE_ACTOR);
    expect(activity.id).toBe(`${ALICE_ACTOR}/likes/like1/undo`);

    const inner = activity.object as Record<string, unknown>;
    expect(inner.type).toBe('Like');
    expect(inner.id).toBe(`${ALICE_ACTOR}/likes/like1`);
    expect(inner.object).toBe(ORIGIN_NOTE);

    expect(deliveredInboxes()).toEqual([ORIGIN_INBOX]);
  });

  it('is a no-op for a LOCAL liked post', async () => {
    const postId = await seedLocalTarget();
    getUserById.mockResolvedValue({ id: 'local-owner', username: 'bob' });

    await followService.federateUndoLike({ _id: 'like1', postId }, USER_LIKER_OXY, 'alice');

    expect(enqueueDelivery).not.toHaveBeenCalled();
  });

  it('propagates queue failure from the durable Undo path', async () => {
    const postId = await seedFederatedTarget();
    enqueueDelivery.mockRejectedValue(new Error('undo queue unavailable'));
    fallbackCreate.mockRejectedValue(new Error('undo queue unavailable'));

    await expect(
      followService.federateUndoLikeStrict({ _id: 'like1', postId }, USER_LIKER_OXY, 'alice'),
    ).rejects.toThrow('undo queue unavailable');
  });
});
