import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Outbound boost federation (PART 1): the `Announce` / `Undo(Announce)` path and
 * the addressing extension that unions follower inboxes with an explicit target
 * inbox.
 *
 * These pin:
 *   - the addressing dedupe in `deliverToFollowers({ extraInboxes })`
 *     (follower shared inbox vs. an explicit inbox → each instance once);
 *   - `federateBoost` emitting an `Announce` whose `object` is the boosted
 *     original's canonical AP id, `cc`'d to the booster's followers + the
 *     original author, delivered to followers + (federated original) the author
 *     inbox;
 *   - `federateUndoBoost` emitting the matching `Undo(Announce)`;
 *   - the REGRESSION GUARD: a bare boost routed through `federateNewPost` (the
 *     `POST /posts` `boost_of` path) produces an `Announce`, NEVER an empty
 *     `Create(Note)` — while a normal post still federates as a `Create(Note)`.
 *
 * The delivery/queue layer, the models, and the Oxy client are mocked so the
 * real `FollowService` runs in isolation; assertions read the captured
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
vi.mock('../../../utils/safeUpstreamFetch', () => ({ fetchUpstreamSingleHop: vi.fn() }));
vi.mock('@oxyhq/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxyhq/core/server')>()),
  assertSafePublicUrl: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../../../utils/mediaResolver', () => ({
  resolveMediaRef: (ref: string) => ({ url: `https://cloud.oxy.so/${ref}` }),
}));
vi.mock('../../../services/fediverseSharing', () => ({ isFediverseSharingEnabled }));
vi.mock('../../../utils/oxyHelpers', () => ({ getServiceOxyClient: () => ({ getUserById }) }));

import { followService } from '../../../connectors/activitypub/follow.service';

const ISO = '2024-05-06T07:08:09.000Z';
const ALICE_ACTOR = 'https://mention.earth/ap/users/alice';
const ALICE_FOLLOWERS = `${ALICE_ACTOR}/followers`;
const AP_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

/** The distinct target inboxes `enqueueDelivery` was asked to deliver to. */
function deliveredInboxes(): string[] {
  return enqueueDelivery.mock.calls.map((c) => (c[0] as { targetInbox: string }).targetInbox);
}

/** The activity enqueued (identical across all inboxes in one fan-out). */
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

describe('deliverToFollowers — addressing extension', () => {
  it('unions a follower shared inbox and an explicit extra inbox, delivering each once', async () => {
    followFindLean.mockResolvedValue([{ remoteActorUri: 'https://foo.example/users/f' }]);
    actorFindLean.mockResolvedValue([{ sharedInboxUrl: 'https://foo.example/inbox' }]);

    await followService.deliverToFollowers({ type: 'X' }, 'sender', 'alice', {
      extraInboxes: ['https://bar.example/inbox'],
    });

    expect(deliveredInboxes().sort()).toEqual(
      ['https://bar.example/inbox', 'https://foo.example/inbox'].sort(),
    );
    expect(enqueueDelivery).toHaveBeenCalledTimes(2);
  });

  it('dedupes an explicit inbox that coincides with a follower shared inbox (delivers once)', async () => {
    followFindLean.mockResolvedValue([{ remoteActorUri: 'https://shared.example/users/f' }]);
    actorFindLean.mockResolvedValue([{ sharedInboxUrl: 'https://shared.example/inbox' }]);

    await followService.deliverToFollowers({ type: 'X' }, 'sender', 'alice', {
      extraInboxes: ['https://shared.example/inbox'],
    });

    expect(deliveredInboxes()).toEqual(['https://shared.example/inbox']);
    expect(enqueueDelivery).toHaveBeenCalledTimes(1);
  });

  it('delivers to an explicit inbox even when the sender has zero followers', async () => {
    followFindLean.mockResolvedValue([]);

    await followService.deliverToFollowers({ type: 'X' }, 'sender', 'alice', {
      extraInboxes: ['https://only.example/inbox'],
    });

    expect(deliveredInboxes()).toEqual(['https://only.example/inbox']);
  });
});

describe('federateBoost — Announce', () => {
  it('announces a boost of a FEDERATED original to followers + the original author inbox', async () => {
    postFindByIdLean.mockResolvedValue({
      oxyUserId: 'orig-owner',
      federation: {
        activityId: 'https://remote.example/users/bob/statuses/9',
        actorUri: 'https://remote.example/users/bob',
      },
    });
    // resolveActorInbox(bob) → the remote author's shared inbox.
    actorFindOneLean.mockResolvedValue({ sharedInboxUrl: 'https://remote.example/inbox' });
    // The booster's own remote followers.
    followFindLean.mockResolvedValue([{ remoteActorUri: 'https://foo.example/users/x' }]);
    actorFindLean.mockResolvedValue([{ sharedInboxUrl: 'https://foo.example/inbox' }]);

    await followService.federateBoost(
      { _id: 'boost1', boostOf: 'orig1', createdAt: ISO },
      'booster-oxy',
      'alice',
    );

    const activity = deliveredActivity();
    expect(activity.type).toBe('Announce');
    expect(activity.actor).toBe(ALICE_ACTOR);
    expect(activity.id).toBe(`${ALICE_ACTOR}/boosts/boost1`);
    expect(activity.object).toBe('https://remote.example/users/bob/statuses/9');
    expect(activity.to).toEqual([AP_PUBLIC]);
    expect(activity.cc).toEqual([ALICE_FOLLOWERS, 'https://remote.example/users/bob']);
    expect(activity.published).toBe(ISO);

    // Delivered to the booster's follower inbox AND the original author's inbox.
    expect(deliveredInboxes().sort()).toEqual(
      ['https://foo.example/inbox', 'https://remote.example/inbox'].sort(),
    );
  });

  it('announces a boost of a LOCAL original with the minted note URI and no extra inbox', async () => {
    postFindByIdLean.mockResolvedValue({ oxyUserId: 'local-owner-id', federation: undefined });
    // The local original's author username, resolved server-side.
    getUserById.mockResolvedValue({ id: 'local-owner-id', username: 'bob' });
    followFindLean.mockResolvedValue([{ remoteActorUri: 'https://foo.example/users/x' }]);
    actorFindLean.mockResolvedValue([{ sharedInboxUrl: 'https://foo.example/inbox' }]);

    await followService.federateBoost(
      { _id: 'boost1', boostOf: 'orig1', createdAt: ISO },
      'booster-oxy',
      'alice',
    );

    expect(getUserById).toHaveBeenCalledWith('local-owner-id');
    const activity = deliveredActivity();
    expect(activity.type).toBe('Announce');
    expect(activity.object).toBe('https://mention.earth/ap/users/bob/posts/orig1');
    expect(activity.cc).toEqual([ALICE_FOLLOWERS, 'https://mention.earth/ap/users/bob']);
    // A local original has no remote inbox — only the booster's follower is hit.
    expect(deliveredInboxes()).toEqual(['https://foo.example/inbox']);
  });

  it('skips federation entirely when the booster has sharing disabled', async () => {
    isFediverseSharingEnabled.mockResolvedValue(false);

    await followService.federateBoost(
      { _id: 'boost1', boostOf: 'orig1', createdAt: ISO },
      'booster-oxy',
      'alice',
    );

    expect(postFindByIdLean).not.toHaveBeenCalled();
    expect(enqueueDelivery).not.toHaveBeenCalled();
  });
});

describe('federateUndoBoost — Undo(Announce)', () => {
  it('retracts a boost with an Undo(Announce) to followers + the original author inbox', async () => {
    postFindByIdLean.mockResolvedValue({
      oxyUserId: 'orig-owner',
      federation: {
        activityId: 'https://remote.example/users/bob/statuses/9',
        actorUri: 'https://remote.example/users/bob',
      },
    });
    actorFindOneLean.mockResolvedValue({ sharedInboxUrl: 'https://remote.example/inbox' });
    followFindLean.mockResolvedValue([{ remoteActorUri: 'https://foo.example/users/x' }]);
    actorFindLean.mockResolvedValue([{ sharedInboxUrl: 'https://foo.example/inbox' }]);

    await followService.federateUndoBoost(
      { _id: 'boost1', boostOf: 'orig1', createdAt: ISO },
      'booster-oxy',
      'alice',
    );

    const activity = deliveredActivity();
    expect(activity.type).toBe('Undo');
    expect(activity.actor).toBe(ALICE_ACTOR);
    expect(activity.id).toBe(`${ALICE_ACTOR}/boosts/boost1/undo`);
    const inner = activity.object as Record<string, unknown>;
    expect(inner.type).toBe('Announce');
    expect(inner.id).toBe(`${ALICE_ACTOR}/boosts/boost1`);
    expect(inner.object).toBe('https://remote.example/users/bob/statuses/9');
    expect(activity.cc).toEqual([ALICE_FOLLOWERS, 'https://remote.example/users/bob']);
    expect(deliveredInboxes().sort()).toEqual(
      ['https://foo.example/inbox', 'https://remote.example/inbox'].sort(),
    );
  });
});

describe('federateNewPost — boost regression guard (POST /posts boost_of)', () => {
  it('federates a bare boost as an Announce, NEVER an empty Create(Note)', async () => {
    const buildNoteSpy = vi.spyOn(followService, 'buildCreateNoteActivity');
    postFindByIdLean.mockResolvedValue({
      oxyUserId: 'orig-owner',
      federation: {
        activityId: 'https://remote.example/users/bob/statuses/9',
        actorUri: 'https://remote.example/users/bob',
      },
    });
    actorFindOneLean.mockResolvedValue({ sharedInboxUrl: 'https://remote.example/inbox' });
    followFindLean.mockResolvedValue([{ remoteActorUri: 'https://foo.example/users/x' }]);
    actorFindLean.mockResolvedValue([{ sharedInboxUrl: 'https://foo.example/inbox' }]);

    // The shape PostCreationService passes: a boost has an EMPTY body + boostOf.
    await followService.federateNewPost(
      { _id: 'boost1', boostOf: 'orig1', content: { variants: [] }, createdAt: ISO, visibility: 'public' },
      'booster-oxy',
      'alice',
    );

    // The Create(Note) builder must not run for a boost.
    expect(buildNoteSpy).not.toHaveBeenCalled();
    expect(deliveredActivity().type).toBe('Announce');
    buildNoteSpy.mockRestore();
  });

  it('still federates a normal (non-boost) post as a Create(Note)', async () => {
    const buildNoteSpy = vi.spyOn(followService, 'buildCreateNoteActivity');
    followFindLean.mockResolvedValue([{ remoteActorUri: 'https://foo.example/users/x' }]);
    actorFindLean.mockResolvedValue([{ sharedInboxUrl: 'https://foo.example/inbox' }]);

    await followService.federateNewPost(
      {
        _id: 'post1',
        content: { variants: [{ source: 'author', text: 'hello world', tag: 'en' }] },
        createdAt: ISO,
        visibility: 'public',
      },
      'author-oxy',
      'alice',
    );

    expect(buildNoteSpy).toHaveBeenCalledTimes(1);
    const activity = deliveredActivity();
    expect(activity.type).toBe('Create');
    expect((activity.object as Record<string, unknown>).type).toBe('Note');
    expect(postFindByIdLean).not.toHaveBeenCalled();
    buildNoteSpy.mockRestore();
  });
});
