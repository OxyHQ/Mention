import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Outbound delete federation (PART 3): a deleted local post broadcasts a
 * `Delete(Tombstone)` to the deleter's remote followers so Mastodon removes it.
 *
 * These pin:
 *   - `federateDelete` emitting a `Delete` whose `object` is a `Tombstone`
 *     carrying the post's canonical AP id (the exact id the outbox / push /
 *     dereference routes advertise), `to` the public collection, `cc` the
 *     deleter's followers, delivered to the follower inboxes;
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

import { followService } from '../../../connectors/activitypub/follow.service';

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
  getUserById.mockResolvedValue({ id: 'u', username: 'alice' });
});

describe('federateDelete — Delete(Tombstone)', () => {
  it('broadcasts a Delete of the post canonical id to the deleter followers', async () => {
    followFindLean.mockResolvedValue([{ remoteActorUri: 'https://foo.example/users/x' }]);
    actorFindLean.mockResolvedValue([{ sharedInboxUrl: 'https://foo.example/inbox' }]);

    await followService.federateDelete({ _id: 'post1' }, 'author-oxy', 'alice');

    const activity = deliveredActivity();
    expect(activity.type).toBe('Delete');
    expect(activity.actor).toBe(ALICE_ACTOR);
    expect(activity.id).toBe(`${ALICE_ACTOR}/posts/post1/delete`);
    expect(activity.to).toEqual([AP_PUBLIC]);
    expect(activity.cc).toEqual([ALICE_FOLLOWERS]);

    const object = activity.object as Record<string, unknown>;
    expect(object.type).toBe('Tombstone');
    expect(object.id).toBe(`${ALICE_ACTOR}/posts/post1`);

    expect(deliveredInboxes()).toEqual(['https://foo.example/inbox']);
  });

  it('skips federation entirely when the deleter has sharing disabled', async () => {
    isFediverseSharingEnabled.mockResolvedValue(false);

    await followService.federateDelete({ _id: 'post1' }, 'author-oxy', 'alice');

    expect(enqueueDelivery).not.toHaveBeenCalled();
  });
});
