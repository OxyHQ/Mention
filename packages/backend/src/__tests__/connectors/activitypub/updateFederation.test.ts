import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Outbound edit federation (PART 3): an edited local post re-federates as an
 * ActivityPub `Update(Note)`. The embedded Note is the SAME one the Create path
 * builds — canonical body, and (for a reply) `inReplyTo` + the parent-author
 * `Mention` — PLUS an `updated` timestamp, which is how Mastodon marks a status
 * as edited.
 *
 * These pin:
 *   - a top-level edit → `Update` whose object is a `Note` with `updated` set and
 *     NO `inReplyTo`, addressed to the same audience as a fresh post;
 *   - a reply edit to a FEDERATED parent → the Update Note keeps `inReplyTo` = the
 *     parent's `federation.activityId` + the parent-author `Mention`, and is
 *     delivered to the editor's followers AND the parent author's inbox;
 *   - a boost is skipped (no editable body);
 *   - a non-public post is skipped;
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

const ISO = '2024-05-06T07:08:09.000Z';
const ALICE_ACTOR = 'https://mention.earth/ap/users/alice';
const ALICE_FOLLOWERS = `${ALICE_ACTOR}/followers`;
const AP_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

/** An editable post as the seam hands it to `federateUpdate`. */
function editedPost(overrides: Record<string, unknown> = {}): {
  _id: string;
  content: { variants: Array<{ source: 'author'; text: string; tag: string }> };
  createdAt: string;
  visibility: string;
  parentPostId?: string;
  boostOf?: string;
} {
  return {
    _id: 'post1',
    content: { variants: [{ source: 'author', text: 'edited body', tag: 'en' }] },
    createdAt: ISO,
    visibility: 'public',
    ...overrides,
  };
}

/** The distinct target inboxes `enqueueDelivery` was asked to deliver to. */
function deliveredInboxes(): string[] {
  return enqueueDelivery.mock.calls.map((c) => (c[0] as { targetInbox: string }).targetInbox);
}

/** The activity enqueued (identical across all inboxes in one fan-out). */
function deliveredActivity(): Record<string, unknown> {
  return (enqueueDelivery.mock.calls[0]?.[0] as { activityJson: Record<string, unknown> }).activityJson;
}

/** The embedded Note object of the enqueued Update activity. */
function deliveredNote(): Record<string, unknown> {
  return deliveredActivity().object as Record<string, unknown>;
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

describe('federateUpdate — top-level edit', () => {
  it('emits an Update(Note) with an `updated` stamp and no inReplyTo', async () => {
    followFindLean.mockResolvedValue([{ remoteActorUri: 'https://foo.example/users/x' }]);
    actorFindLean.mockResolvedValue([{ sharedInboxUrl: 'https://foo.example/inbox' }]);

    await followService.federateUpdate(editedPost(), 'author-oxy', 'alice');

    const activity = deliveredActivity();
    expect(activity.type).toBe('Update');
    expect(activity.actor).toBe(ALICE_ACTOR);
    expect(typeof activity.updated).toBe('string');
    expect(activity.to).toEqual([AP_PUBLIC]);
    expect(activity.cc).toEqual([ALICE_FOLLOWERS]);
    // The edit activity id is the Note id with a unique `#updates/<ts>` fragment.
    expect(String(activity.id)).toMatch(new RegExp(`^${ALICE_ACTOR}/posts/post1#updates/\\d+$`));

    const note = deliveredNote();
    expect(note.type).toBe('Note');
    // AP `content` is HTML — the plain-text body is wrapped in a paragraph.
    expect(note.content).toBe('<p>edited body</p>');
    expect(note.inReplyTo).toBeUndefined();
    // The Note carries the SAME `updated` marker as the envelope.
    expect(note.updated).toBe(activity.updated);

    // A top-level edit never resolves a parent.
    expect(postFindByIdLean).not.toHaveBeenCalled();
    expect(deliveredInboxes()).toEqual(['https://foo.example/inbox']);
  });
});

describe('federateUpdate — reply edit to a FEDERATED parent', () => {
  it('keeps inReplyTo + parent Mention and delivers to followers AND the parent inbox', async () => {
    postFindByIdLean.mockResolvedValue({
      oxyUserId: 'parent-owner',
      federation: {
        activityId: 'https://remote.example/users/bob/statuses/9',
        actorUri: 'https://remote.example/users/bob',
      },
    });
    actorFindOneLean.mockResolvedValue({
      sharedInboxUrl: 'https://remote.example/inbox',
      acct: 'bob@remote.example',
    });
    followFindLean.mockResolvedValue([{ remoteActorUri: 'https://foo.example/users/x' }]);
    actorFindLean.mockResolvedValue([{ sharedInboxUrl: 'https://foo.example/inbox' }]);

    await followService.federateUpdate(editedPost({ parentPostId: 'parent1' }), 'replier-oxy', 'alice');

    const activity = deliveredActivity();
    expect(activity.type).toBe('Update');

    const note = deliveredNote();
    expect(note.inReplyTo).toBe('https://remote.example/users/bob/statuses/9');
    expect(note.tag).toContainEqual({
      type: 'Mention',
      href: 'https://remote.example/users/bob',
      name: '@bob@remote.example',
    });
    expect(note.updated).toBe(activity.updated);
    expect(activity.cc).toEqual([ALICE_FOLLOWERS, 'https://remote.example/users/bob']);

    expect(deliveredInboxes().sort()).toEqual(
      ['https://foo.example/inbox', 'https://remote.example/inbox'].sort(),
    );
  });
});

describe('federateUpdate — skipped cases', () => {
  it('skips a boost (no editable body)', async () => {
    followFindLean.mockResolvedValue([{ remoteActorUri: 'https://foo.example/users/x' }]);
    actorFindLean.mockResolvedValue([{ sharedInboxUrl: 'https://foo.example/inbox' }]);

    await followService.federateUpdate(editedPost({ boostOf: 'orig1' }), 'author-oxy', 'alice');

    expect(enqueueDelivery).not.toHaveBeenCalled();
  });

  it('skips a non-public post', async () => {
    await followService.federateUpdate(editedPost({ visibility: 'private' }), 'author-oxy', 'alice');

    expect(enqueueDelivery).not.toHaveBeenCalled();
  });

  it('skips entirely when sharing is disabled', async () => {
    isFediverseSharingEnabled.mockResolvedValue(false);

    await followService.federateUpdate(editedPost(), 'author-oxy', 'alice');

    expect(enqueueDelivery).not.toHaveBeenCalled();
  });
});
