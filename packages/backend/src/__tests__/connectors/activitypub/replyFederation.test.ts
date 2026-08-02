import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Outbound reply federation (PART 2): a reply Note carries `inReplyTo` (the
 * parent's canonical AP object id) + a parent-author `Mention` tag, and is
 * delivered to the replier's followers AND — for a FEDERATED parent — the parent
 * author's inbox, so Mastodon threads the reply under the parent and notifies its
 * author.
 *
 * Both reply entry points (`POST /feed/reply` and the `POST /posts` reply path)
 * converge on `FollowService.federateNewPost`, which reads `post.parentPostId` and
 * routes to the reply-addressing branch — so these tests exercise that ONE
 * convergence point.
 *
 * These pin:
 *   - a reply to a FEDERATED parent → Create(Note) with `inReplyTo` = the parent's
 *     `federation.activityId`, a Mention tag for the parent author, `cc` unioning
 *     the author actor, delivered to followers + the parent author's inbox;
 *   - a reply to a LOCAL parent → a locally-minted `inReplyTo`, a local Mention,
 *     and NO bogus extra inbox (a local author is reached through their own
 *     followers, never a remote POST);
 *   - a TOP-LEVEL post → a Note with NO `inReplyTo` and no parent lookup at all;
 *   - a parent that cannot be resolved → fail-soft: the reply still federates as a
 *     normal Note (no `inReplyTo`), never throwing.
 *
 * The delivery/queue layer, the models, and the Oxy client are mocked so the real
 * `FollowService` runs in isolation; assertions read the captured
 * `enqueueDelivery` calls.
 */

const {
  enqueueDelivery,
  isFediverseSharingEnabled,
  getUserById,
  postFindByIdLean,
  insertMany,
} = vi.hoisted(() => ({
  enqueueDelivery: vi.fn(),
  isFediverseSharingEnabled: vi.fn(),
  getUserById: vi.fn(),
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

import { closePostgres, connectPostgres } from '../../../db/postgres';
import {
  clearFederationScope,
  federationScope,
  seedActor,
  seedFollowerWithInbox,
} from '../../helpers/federationFixtures';
import { followService } from '../../../connectors/activitypub/follow.service';

const ISO = '2024-05-06T07:08:09.000Z';
const ALICE_ACTOR = 'https://mention.earth/ap/users/alice';
const ALICE_FOLLOWERS = `${ALICE_ACTOR}/followers`;
const AP_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

/** A reply post as the seam hands it to `federateNewPost`. */
function replyPost(parentPostId: string | undefined): {
  _id: string;
  parentPostId?: string;
  content: { variants: Array<{ source: 'author'; text: string; tag: string }> };
  createdAt: string;
  visibility: string;
} {
  return {
    _id: 'reply1',
    ...(parentPostId ? { parentPostId } : {}),
    content: { variants: [{ source: 'author', text: 'threaded response', tag: 'en' }] },
    createdAt: ISO,
    visibility: 'public',
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

/** The embedded Note object of the enqueued Create activity. */
function deliveredNote(): Record<string, unknown> {
  return deliveredActivity().object as Record<string, unknown>;
}

const scope = federationScope('reply-federation');
const PARENT_ACTOR = `${scope.origin}/users/bob`;
const PARENT_INBOX = `${scope.origin}/parent-inbox`;
const PARENT_NOTE = `${PARENT_ACTOR}/statuses/9`;
const PARENT_ACCT = `bob@${scope.domain}`;

/** The replier's follower inbox for the test currently running. */
let followerInbox: string;

const USER_AUTHOR_OXY = scope.user('author-oxy');

const USER_REPLIER_OXY = scope.user('replier-oxy');

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearFederationScope(scope);
  enqueueDelivery.mockResolvedValue(true);
  isFediverseSharingEnabled.mockResolvedValue(true);
  postFindByIdLean.mockResolvedValue(null);
  getUserById.mockResolvedValue({ id: 'u', username: 'bob' });
});

afterEach(async () => {
  await clearFederationScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('federateNewPost — reply to a FEDERATED parent', () => {
  beforeEach(async () => {
    // The parent post is a federated (remote) Note.
    postFindByIdLean.mockResolvedValue({
      oxyUserId: 'parent-owner',
      federation: { activityId: PARENT_NOTE, actorUri: PARENT_ACTOR },
    });
    // The parent author's actor row → its inbox + acct. The `acct` is what the
    // reply's `Mention` name is rendered from, so it has to be a real column
    // value rather than a field a double was told to return.
    await seedActor(scope, {
      username: 'bob',
      uri: PARENT_ACTOR,
      sharedInboxUrl: PARENT_INBOX,
      inboxUrl: PARENT_INBOX,
    });
    // The replier's own remote follower.
    followerInbox = await seedFollowerWithInbox(scope, USER_REPLIER_OXY, { username: 'x' });
  });

  it('emits a Create(Note) with inReplyTo = the parent activityId + a parent-author Mention', async () => {
    await followService.federateNewPost(replyPost('parent1'), USER_REPLIER_OXY, 'alice');

    const activity = deliveredActivity();
    expect(activity.type).toBe('Create');
    const note = deliveredNote();
    expect(note.type).toBe('Note');
    expect(note.inReplyTo).toBe(PARENT_NOTE);
    // AP `content` is HTML — the plain-text body is wrapped in a paragraph.
    expect(note.content).toBe('<p>threaded response</p>');

    // The Mention tag threads + notifies the remote author (href resolves it;
    // name is the human-readable @user@domain from the stored acct).
    const tags = note.tag as Array<Record<string, string>>;
    expect(tags).toContainEqual({
      type: 'Mention',
      href: PARENT_ACTOR,
      name: `@${PARENT_ACCT}`,
    });

    // The mentioned author joins the followers collection in cc (both envelope
    // and object).
    expect(activity.cc).toEqual([ALICE_FOLLOWERS, PARENT_ACTOR]);
    expect(note.cc).toEqual([ALICE_FOLLOWERS, PARENT_ACTOR]);
    expect(note.to).toEqual([AP_PUBLIC]);
  });

  it('delivers to the replier followers AND the parent author inbox (deduped)', async () => {
    await followService.federateNewPost(replyPost('parent1'), USER_REPLIER_OXY, 'alice');

    expect(deliveredInboxes().sort()).toEqual([followerInbox, PARENT_INBOX].sort());
  });
});

describe('federateNewPost — reply to a LOCAL parent', () => {
  it('emits a locally-minted inReplyTo + local Mention and adds NO extra inbox', async () => {
    // A local parent: no federation block, resolved to its owner username.
    postFindByIdLean.mockResolvedValue({ oxyUserId: 'local-parent-owner', federation: undefined });
    getUserById.mockResolvedValue({ id: 'local-parent-owner', username: 'bob' });
    const followerInbox = await seedFollowerWithInbox(scope, USER_REPLIER_OXY, { username: 'x' });

    await followService.federateNewPost(replyPost('parent1'), USER_REPLIER_OXY, 'alice');

    expect(getUserById).toHaveBeenCalledWith('local-parent-owner');
    const note = deliveredNote();
    expect(note.inReplyTo).toBe('https://mention.earth/ap/users/bob/posts/parent1');
    expect(note.tag).toContainEqual({
      type: 'Mention',
      href: 'https://mention.earth/ap/users/bob',
      name: '@bob@mention.earth',
    });
    expect(note.cc).toEqual([ALICE_FOLLOWERS, 'https://mention.earth/ap/users/bob']);

    // A local parent's author is reached through the replier's followers — never a
    // bogus remote POST to a nonexistent inbox.
    expect(deliveredInboxes()).toEqual([followerInbox]);
  });
});

describe('federateNewPost — top-level (non-reply) post', () => {
  it('emits a Note with NO inReplyTo and never looks up a parent', async () => {
    const followerInbox = await seedFollowerWithInbox(scope, USER_AUTHOR_OXY, { username: 'x' });

    await followService.federateNewPost(replyPost(undefined), USER_AUTHOR_OXY, 'alice');

    const activity = deliveredActivity();
    expect(activity.type).toBe('Create');
    const note = deliveredNote();
    expect(note.inReplyTo).toBeUndefined();
    // No hashtags + no reply Mention → no tag array at all.
    expect(note.tag).toBeUndefined();
    expect(note.cc).toEqual([ALICE_FOLLOWERS]);
    // A top-level post never resolves a parent.
    expect(postFindByIdLean).not.toHaveBeenCalled();
    expect(deliveredInboxes()).toEqual([followerInbox]);
  });
});

describe('federateNewPost — parent unresolvable (fail-soft)', () => {
  it('still federates the reply as a normal Note (no inReplyTo), never throwing', async () => {
    // The parent post cannot be found.
    postFindByIdLean.mockResolvedValue(null);
    await seedFollowerWithInbox(scope, USER_REPLIER_OXY, { username: 'x' });

    await expect(
      followService.federateNewPost(replyPost('ghost-parent'), USER_REPLIER_OXY, 'alice'),
    ).resolves.toBeUndefined();

    // It attempted to resolve the parent, found nothing, and fell back cleanly.
    expect(postFindByIdLean).toHaveBeenCalled();
    const note = deliveredNote();
    expect(note.inReplyTo).toBeUndefined();
    expect(note.tag).toBeUndefined();
    // Delivered to the replier's followers only (no parent-author inbox).
    expect(deliveredInboxes()).toEqual([followerInbox]);
  });
});
