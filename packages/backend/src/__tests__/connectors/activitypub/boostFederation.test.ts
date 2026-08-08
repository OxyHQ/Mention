import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
  insertMany,
} = vi.hoisted(() => ({
  enqueueDelivery: vi.fn(),
  isFediverseSharingEnabled: vi.fn(),
  getUserById: vi.fn(),
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

import { closePostgres, connectPostgres } from '../../../db/postgres';
import {
  clearFederationScope,
  federationScope,
  seedActor,
  seedFollowerWithInbox,
  seedPost,
} from '../../helpers/federationFixtures';
import { followService } from '../../../connectors/activitypub/follow.service';
import type { PostRecord } from '../../../db/posts/postRecord';
import { deliveryService } from '../../../connectors/activitypub/delivery.service';

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

const scope = federationScope('boost-federation');
const ORIGIN_ACTOR = `${scope.origin}/users/bob`;
const ORIGIN_INBOX = `${scope.origin}/origin-inbox`;
const ORIGIN_NOTE = `${ORIGIN_ACTOR}/statuses/9`;
const EXTRA_INBOX = 'https://bar.example/inbox';

/**
 * The FEDERATED boosted original + its author's actor row (the extra inbox).
 *
 * A real mirrored post row: `resolveFederationTarget` reads its stored
 * `federation.activity_id` to decide the Announce's `object`, so a stub here
 * could not tell a working lookup from one that finds nothing — and a boost
 * whose object silently resolves to null is one no remote server can render.
 */
async function seedFederatedOriginal(): Promise<PostRecord> {
  const original = await seedPost(scope, {
    oxyUserId: scope.user('orig-owner'),
    federation: { activityId: ORIGIN_NOTE, actorUri: ORIGIN_ACTOR },
  });
  await seedActor(scope, {
    username: 'bob',
    uri: ORIGIN_ACTOR,
    sharedInboxUrl: ORIGIN_INBOX,
    inboxUrl: ORIGIN_INBOX,
  });
  return original;
}

const USER_AUTHOR_OXY = scope.user('author-oxy');

const USER_BOOSTER_OXY = scope.user('booster-oxy');

const USER_SENDER = scope.user('sender');

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearFederationScope(scope);
  enqueueDelivery.mockResolvedValue(true);
  isFediverseSharingEnabled.mockResolvedValue(true);
  getUserById.mockResolvedValue({ id: 'u', username: 'bob' });
});

afterEach(async () => {
  await clearFederationScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('deliverToFollowers — addressing extension', () => {
  it('unions a follower shared inbox and an explicit extra inbox, delivering each once', async () => {
    const followerInbox = await seedFollowerWithInbox(scope, USER_SENDER, { username: 'f' });

    await deliveryService.deliverToFollowers({ type: 'X' }, USER_SENDER, 'alice', {
      extraInboxes: [EXTRA_INBOX],
    });

    expect(deliveredInboxes().sort()).toEqual([EXTRA_INBOX, followerInbox].sort());
    expect(enqueueDelivery).toHaveBeenCalledTimes(2);
  });

  it('dedupes an explicit inbox that coincides with a follower shared inbox (delivers once)', async () => {
    const followerInbox = await seedFollowerWithInbox(scope, USER_SENDER, { username: 'f' });

    await deliveryService.deliverToFollowers({ type: 'X' }, USER_SENDER, 'alice', {
      extraInboxes: [followerInbox],
    });

    expect(deliveredInboxes()).toEqual([followerInbox]);
    expect(enqueueDelivery).toHaveBeenCalledTimes(1);
  });

  it('delivers to an explicit inbox even when the sender has zero followers', async () => {
    // No follower rows seeded at all — the sender genuinely has none.
    await deliveryService.deliverToFollowers({ type: 'X' }, USER_SENDER, 'alice', {
      extraInboxes: ['https://only.example/inbox'],
    });

    expect(deliveredInboxes()).toEqual(['https://only.example/inbox']);
  });
});

describe('federateBoost — Announce', () => {
  it('announces a boost of a FEDERATED original to followers + the original author inbox', async () => {
    const original = await seedFederatedOriginal();
    // The booster's own remote follower.
    const followerInbox = await seedFollowerWithInbox(scope, USER_BOOSTER_OXY, { username: 'x' });

    await followService.federateBoost(
      // `federateBoost` takes the SDK's `LocalBoostEventPayload`, which still
      // spells the id `_id` — the one shape on this path that is NOT a
      // `NoteSourcePost`. `boostOf` is a real Mention post id either way.
      { _id: 'boost1', boostOf: original.id, createdAt: ISO },
      USER_BOOSTER_OXY,
      'alice',
    );

    const activity = deliveredActivity();
    expect(activity.type).toBe('Announce');
    expect(activity.actor).toBe(ALICE_ACTOR);
    expect(activity.id).toBe(`${ALICE_ACTOR}/boosts/boost1`);
    expect(activity.object).toBe(ORIGIN_NOTE);
    expect(activity.to).toEqual([AP_PUBLIC]);
    expect(activity.cc).toEqual([ALICE_FOLLOWERS, ORIGIN_ACTOR]);
    expect(activity.published).toBe(ISO);

    // Delivered to the booster's follower inbox AND the original author's inbox.
    expect(deliveredInboxes().sort()).toEqual([followerInbox, ORIGIN_INBOX].sort());
  });

  it('announces a boost of a LOCAL original with the minted note URI and no extra inbox', async () => {
    const owner = scope.user('local-owner-id');
    const original = await seedPost(scope, { oxyUserId: owner });
    // The local original's author username, resolved server-side.
    getUserById.mockResolvedValue({ id: owner, username: 'bob' });
    const followerInbox = await seedFollowerWithInbox(scope, USER_BOOSTER_OXY, { username: 'x' });

    await followService.federateBoost(
      // `federateBoost` takes the SDK's `LocalBoostEventPayload`, which still
      // spells the id `_id` — the one shape on this path that is NOT a
      // `NoteSourcePost`. `boostOf` is a real Mention post id either way.
      { _id: 'boost1', boostOf: original.id, createdAt: ISO },
      USER_BOOSTER_OXY,
      'alice',
    );

    expect(getUserById).toHaveBeenCalledWith(owner);
    const activity = deliveredActivity();
    expect(activity.type).toBe('Announce');
    expect(activity.object).toBe(`https://mention.earth/ap/users/bob/posts/${original.id}`);
    expect(activity.cc).toEqual([ALICE_FOLLOWERS, 'https://mention.earth/ap/users/bob']);
    // A local original has no remote inbox — only the booster's follower is hit.
    expect(deliveredInboxes()).toEqual([followerInbox]);
  });

  it('skips federation entirely when the booster has sharing disabled', async () => {
    const original = await seedFederatedOriginal();
    isFediverseSharingEnabled.mockResolvedValue(false);

    await followService.federateBoost(
      // `federateBoost` takes the SDK's `LocalBoostEventPayload`, which still
      // spells the id `_id` — the one shape on this path that is NOT a
      // `NoteSourcePost`. `boostOf` is a real Mention post id either way.
      { _id: 'boost1', boostOf: original.id, createdAt: ISO },
      USER_BOOSTER_OXY,
      'alice',
    );

    expect(enqueueDelivery).not.toHaveBeenCalled();
  });
});

describe('federateUndoBoost — Undo(Announce)', () => {
  it('retracts a boost with an Undo(Announce) to followers + the original author inbox', async () => {
    const original = await seedFederatedOriginal();
    const followerInbox = await seedFollowerWithInbox(scope, USER_BOOSTER_OXY, { username: 'x' });

    await followService.federateUndoBoost(
      // `federateBoost` takes the SDK's `LocalBoostEventPayload`, which still
      // spells the id `_id` — the one shape on this path that is NOT a
      // `NoteSourcePost`. `boostOf` is a real Mention post id either way.
      { _id: 'boost1', boostOf: original.id, createdAt: ISO },
      USER_BOOSTER_OXY,
      'alice',
    );

    const activity = deliveredActivity();
    expect(activity.type).toBe('Undo');
    expect(activity.actor).toBe(ALICE_ACTOR);
    expect(activity.id).toBe(`${ALICE_ACTOR}/boosts/boost1/undo`);
    const inner = activity.object as Record<string, unknown>;
    expect(inner.type).toBe('Announce');
    expect(inner.id).toBe(`${ALICE_ACTOR}/boosts/boost1`);
    expect(inner.object).toBe(ORIGIN_NOTE);
    expect(activity.cc).toEqual([ALICE_FOLLOWERS, ORIGIN_ACTOR]);
    expect(deliveredInboxes().sort()).toEqual([followerInbox, ORIGIN_INBOX].sort());
  });
});

describe('federateNewPost — boost regression guard (POST /posts boost_of)', () => {
  it('federates a bare boost as an Announce, NEVER an empty Create(Note)', async () => {
    const buildNoteSpy = vi.spyOn(followService, 'buildCreateNoteActivity');
    const original = await seedFederatedOriginal();
    const followerInbox = await seedFollowerWithInbox(scope, USER_BOOSTER_OXY, { username: 'x' });

    // The shape PostCreationService passes: a boost has an EMPTY body + boostOf.
    await followService.federateNewPost(
      { id: 'boost1', boostOf: original.id, content: { variants: [] }, createdAt: ISO, visibility: 'public' },
      USER_BOOSTER_OXY,
      'alice',
    );

    // The Create(Note) builder must not run for a boost.
    expect(buildNoteSpy).not.toHaveBeenCalled();
    expect(deliveredActivity().type).toBe('Announce');
    buildNoteSpy.mockRestore();
  });

  it('still federates a normal (non-boost) post as a Create(Note)', async () => {
    const buildNoteSpy = vi.spyOn(followService, 'buildCreateNoteActivity');
    await seedFollowerWithInbox(scope, USER_AUTHOR_OXY, { username: 'x' });

    await followService.federateNewPost(
      {
        _id: 'post1',
        content: { variants: [{ source: 'author', text: 'hello world', tag: 'en' }] },
        createdAt: ISO,
        visibility: 'public',
      },
      USER_AUTHOR_OXY,
      'alice',
    );

    expect(buildNoteSpy).toHaveBeenCalledTimes(1);
    const activity = deliveredActivity();
    expect(activity.type).toBe('Create');
    expect((activity.object as Record<string, unknown>).type).toBe('Note');
    buildNoteSpy.mockRestore();
  });
});
