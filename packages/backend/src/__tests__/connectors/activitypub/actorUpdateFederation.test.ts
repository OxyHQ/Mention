import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Outbound actor-update federation (PART 3): a Mention-owned profile change (the
 * `profileHeaderImage` banner) rebroadcasts the FULL actor document as an
 * `Update(Person)` to remote followers so Mastodon refreshes the cached profile.
 *
 * These pin:
 *   - `federateActorUpdate` emitting an `Update` whose `object` is the SAME
 *     `Person` document the GET actor route serves (built by the shared
 *     `buildLocalActorObject`), carrying the current banner as AP `image`, `to`
 *     the public collection, `cc` the followers, delivered to follower inboxes;
 *   - the sharing gate short-circuit;
 *   - a no-op when the user can't be resolved.
 *
 * The delivery/queue layer, the models, and the Oxy client are mocked so the real
 * `FollowService` runs in isolation; assertions read the captured
 * `enqueueDelivery` calls.
 */

const {
  enqueueDelivery,
  isFediverseSharingEnabled,
  getUserById,
  resolveOxyUser,
  getPublicKey,
  userSettingsFindOneLean,
  followFindLean,
  actorFindLean,
  insertMany,
} = vi.hoisted(() => ({
  enqueueDelivery: vi.fn(),
  isFediverseSharingEnabled: vi.fn(),
  getUserById: vi.fn(),
  resolveOxyUser: vi.fn(),
  getPublicKey: vi.fn(),
  userSettingsFindOneLean: vi.fn(),
  followFindLean: vi.fn(),
  actorFindLean: vi.fn(),
  insertMany: vi.fn(),
}));

vi.mock('../../../connectors/activitypub/constants', async () => {
  const actual = await vi.importActual<typeof import('../../../connectors/activitypub/constants')>(
    '../../../connectors/activitypub/constants',
  );
  return { ...actual, FEDERATION_ENABLED: true, resolveOxyUser };
});
vi.mock('../../../connectors/activitypub/actor.service', () => ({ actorService: {} }));
vi.mock('../../../connectors/activitypub/crypto', () => ({ getPublicKey, signRequest: vi.fn() }));
vi.mock('../../../queue/producers', () => ({ enqueueDelivery, enqueueInboxActivity: vi.fn() }));
vi.mock('../../../models/FederatedActor', () => ({
  default: {
    find: () => ({ lean: () => actorFindLean() }),
    findOne: () => ({ lean: () => null }),
  },
}));
vi.mock('../../../models/FederatedFollow', () => ({
  default: { find: () => ({ lean: () => followFindLean() }) },
}));
vi.mock('../../../models/FederationDeliveryQueue', () => ({
  default: { insertMany, create: vi.fn() },
}));
vi.mock('../../../models/Post', () => ({
  Post: { findById: () => ({ select: () => ({ lean: () => null }) }) },
}));
vi.mock('../../../models/UserSettings', () => ({
  default: { findOne: () => ({ lean: () => userSettingsFindOneLean() }) },
}));
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
const ALICE_FOLLOWERS = `${ALICE_ACTOR}/followers`;
const AP_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

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
  getUserById.mockResolvedValue({ id: 'owner', username: 'alice' });
  resolveOxyUser.mockResolvedValue({
    _id: 'owner',
    name: { displayName: 'Alice' },
    bio: 'hello world',
    avatar: null,
    createdAt: '2020-01-01T00:00:00.000Z',
  });
  getPublicKey.mockResolvedValue({ keyId: `${ALICE_ACTOR}#main-key`, publicKeyPem: 'PEM' });
  userSettingsFindOneLean.mockResolvedValue({ profileHeaderImage: 'banner-file-id' });
});

describe('federateActorUpdate — Update(Person)', () => {
  it('broadcasts the full actor with the current banner to remote followers', async () => {
    followFindLean.mockResolvedValue([{ remoteActorUri: 'https://foo.example/users/x' }]);
    actorFindLean.mockResolvedValue([{ sharedInboxUrl: 'https://foo.example/inbox' }]);

    await followService.federateActorUpdate('owner', 'alice');

    const activity = deliveredActivity();
    expect(activity.type).toBe('Update');
    expect(activity.actor).toBe(ALICE_ACTOR);
    expect(activity.to).toEqual([AP_PUBLIC]);
    expect(activity.cc).toEqual([ALICE_FOLLOWERS]);
    expect(typeof activity.updated).toBe('string');

    const object = activity.object as Record<string, unknown>;
    expect(object.type).toBe('Person');
    expect(object.id).toBe(ALICE_ACTOR);
    expect(object.preferredUsername).toBe('alice');
    expect(object.name).toBe('Alice');
    // The embedded actor object must NOT carry its own JSON-LD context (the
    // envelope owns it).
    expect(object['@context']).toBeUndefined();
    // The banner is advertised as the AP `image`, resolved to an absolute URL.
    expect(object.image).toEqual({ type: 'Image', url: 'https://cloud.oxy.so/banner-file-id' });

    expect(deliveredInboxes()).toEqual(['https://foo.example/inbox']);
  });

  it('skips entirely when sharing is disabled', async () => {
    isFediverseSharingEnabled.mockResolvedValue(false);

    await followService.federateActorUpdate('owner', 'alice');

    expect(resolveOxyUser).not.toHaveBeenCalled();
    expect(enqueueDelivery).not.toHaveBeenCalled();
  });

  it('is a no-op when the user cannot be resolved', async () => {
    resolveOxyUser.mockResolvedValue(null);
    followFindLean.mockResolvedValue([{ remoteActorUri: 'https://foo.example/users/x' }]);
    actorFindLean.mockResolvedValue([{ sharedInboxUrl: 'https://foo.example/inbox' }]);

    await followService.federateActorUpdate('owner', 'alice');

    expect(enqueueDelivery).not.toHaveBeenCalled();
  });
});
