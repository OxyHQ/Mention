import { beforeEach, describe, expect, it, vi } from 'vitest';

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
 * The delivery/queue layer, the models, and the Oxy client are mocked so the real
 * `FollowService` runs in isolation; assertions read the captured
 * `enqueueDelivery` calls.
 */

const {
  enqueueDelivery,
  isFediverseSharingEnabled,
  getUserById,
  followFindLean,
  actorFindLean,
  actorFindOneLean,
  postFindByIdLean,
  insertMany,
} = vi.hoisted(() => ({
  enqueueDelivery: vi.fn(),
  isFediverseSharingEnabled: vi.fn(),
  getUserById: vi.fn(),
  followFindLean: vi.fn(),
  actorFindLean: vi.fn(),
  actorFindOneLean: vi.fn(),
  postFindByIdLean: vi.fn(),
  insertMany: vi.fn(),
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
vi.mock('../../../models/FederatedActor', () => ({
  default: {
    find: () => ({ lean: () => actorFindLean() }),
    findOne: () => ({ lean: () => actorFindOneLean() }),
  },
}));
vi.mock('../../../models/FederatedFollow', () => ({
  default: { find: () => ({ lean: () => followFindLean() }) },
}));
vi.mock('../../../models/FederationDeliveryQueue', () => ({
  default: { insertMany, create: vi.fn() },
}));
vi.mock('../../../models/Post', () => ({
  Post: { findById: () => ({ select: () => ({ lean: () => postFindByIdLean() }) }) },
}));
vi.mock('../../../models/UserSettings', () => ({ default: {} }));
vi.mock('../../../utils/safeUpstreamFetch', () => ({ fetchUpstreamSingleHop: vi.fn() }));
vi.mock('../../../utils/ssrfGuard', () => ({ assertSafePublicUrl: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('../../../utils/mediaResolver', () => ({
  resolveMediaRef: (ref: string) => ({ url: `https://cloud.oxy.so/${ref}` }),
  resolveAvatarUrl: (ref: string) => `https://cloud.oxy.so/${ref}`,
}));
vi.mock('../../../services/fediverseSharing', () => ({ isFediverseSharingEnabled }));
vi.mock('../../../utils/oxyHelpers', () => ({ getServiceOxyClient: () => ({ getUserById }) }));

import { followService } from '../../../connectors/activitypub/follow.service';

const ALICE_ACTOR = 'https://mention.earth/ap/users/alice';

/** A FEDERATED liked original: its remote activity id + author actor. */
function mockFederatedTarget(): void {
  postFindByIdLean.mockResolvedValue({
    oxyUserId: 'orig-owner',
    federation: {
      activityId: 'https://remote.example/users/bob/statuses/9',
      actorUri: 'https://remote.example/users/bob',
    },
  });
  // resolveFederationTarget → the remote author's FederatedActor row (inbox).
  actorFindOneLean.mockResolvedValue({ sharedInboxUrl: 'https://remote.example/inbox' });
}

/** The distinct target inboxes `enqueueDelivery` was asked to deliver to. */
function deliveredInboxes(): string[] {
  return enqueueDelivery.mock.calls.map((c) => (c[0] as { targetInbox: string }).targetInbox);
}

/** The activity enqueued. */
function deliveredActivity(): Record<string, unknown> {
  return (enqueueDelivery.mock.calls[0]?.[0] as { activityJson: Record<string, unknown> }).activityJson;
}

beforeEach(() => {
  vi.clearAllMocks();
  enqueueDelivery.mockResolvedValue(true);
  isFediverseSharingEnabled.mockResolvedValue(true);
  followFindLean.mockResolvedValue([]);
  actorFindLean.mockResolvedValue([]);
  actorFindOneLean.mockResolvedValue(null);
  postFindByIdLean.mockResolvedValue(null);
  getUserById.mockResolvedValue({ id: 'u', username: 'bob' });
});

describe('federateLike — Like to origin', () => {
  it('sends a Like of the remote activity id to the origin author inbox ONLY', async () => {
    mockFederatedTarget();
    // Even with the liker's own followers present, a like is NOT fanned out to them.
    followFindLean.mockResolvedValue([{ remoteActorUri: 'https://foo.example/users/x' }]);
    actorFindLean.mockResolvedValue([{ sharedInboxUrl: 'https://foo.example/inbox' }]);

    await followService.federateLike({ _id: 'like1', postId: 'orig1' }, 'liker-oxy', 'alice');

    const activity = deliveredActivity();
    expect(activity.type).toBe('Like');
    expect(activity.actor).toBe(ALICE_ACTOR);
    expect(activity.id).toBe(`${ALICE_ACTOR}/likes/like1`);
    expect(activity.object).toBe('https://remote.example/users/bob/statuses/9');

    // Delivered to the origin author inbox only — never the liker's follower inbox.
    expect(deliveredInboxes()).toEqual(['https://remote.example/inbox']);
    expect(deliveredInboxes()).not.toContain('https://foo.example/inbox');
  });

  it('is a no-op for a LOCAL liked post (no remote inbox)', async () => {
    // A local original: no federation block → resolveFederationTarget yields no
    // author inbox, so nothing is delivered over ActivityPub.
    postFindByIdLean.mockResolvedValue({ oxyUserId: 'local-owner', federation: undefined });
    getUserById.mockResolvedValue({ id: 'local-owner', username: 'bob' });

    await followService.federateLike({ _id: 'like1', postId: 'localpost' }, 'liker-oxy', 'alice');

    expect(enqueueDelivery).not.toHaveBeenCalled();
  });

  it('skips entirely when sharing is disabled', async () => {
    isFediverseSharingEnabled.mockResolvedValue(false);

    await followService.federateLike({ _id: 'like1', postId: 'orig1' }, 'liker-oxy', 'alice');

    expect(postFindByIdLean).not.toHaveBeenCalled();
    expect(enqueueDelivery).not.toHaveBeenCalled();
  });
});

describe('federateUndoLike — Undo(Like) to origin', () => {
  it('retracts a like with an Undo(Like) re-minting the same Like id', async () => {
    mockFederatedTarget();

    await followService.federateUndoLike({ _id: 'like1', postId: 'orig1' }, 'liker-oxy', 'alice');

    const activity = deliveredActivity();
    expect(activity.type).toBe('Undo');
    expect(activity.actor).toBe(ALICE_ACTOR);
    expect(activity.id).toBe(`${ALICE_ACTOR}/likes/like1/undo`);

    const inner = activity.object as Record<string, unknown>;
    expect(inner.type).toBe('Like');
    expect(inner.id).toBe(`${ALICE_ACTOR}/likes/like1`);
    expect(inner.object).toBe('https://remote.example/users/bob/statuses/9');

    expect(deliveredInboxes()).toEqual(['https://remote.example/inbox']);
  });

  it('is a no-op for a LOCAL liked post', async () => {
    postFindByIdLean.mockResolvedValue({ oxyUserId: 'local-owner', federation: undefined });
    getUserById.mockResolvedValue({ id: 'local-owner', username: 'bob' });

    await followService.federateUndoLike({ _id: 'like1', postId: 'localpost' }, 'liker-oxy', 'alice');

    expect(enqueueDelivery).not.toHaveBeenCalled();
  });
});
