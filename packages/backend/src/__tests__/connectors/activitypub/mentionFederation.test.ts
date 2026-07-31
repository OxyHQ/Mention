import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Outbound @mention federation: a Mention post stores mentions inline as internal
 * `[mention:<oxyUserId>]` placeholders + a `mentions` id allowlist. The Note
 * builder MUST resolve those to Mastodon mention anchors + `Mention` tags — never
 * ship the raw placeholder — and, for REMOTE mentioned users, `cc` their actor and
 * deliver to their inbox so their instance receives + notifies the post.
 *
 * These pin the ONE convergence point (`FollowService.federateNewPost` →
 * `resolveMentionContext` → `buildCreateNoteActivity`):
 *   - a post mentioning a REMOTE user → mention anchor in `content`, a `Mention`
 *     tag, the remote actor in `cc`, and its inbox unioned into delivery;
 *   - a post mentioning a LOCAL user → a local mention anchor/tag, NO cc, NO extra
 *     inbox;
 *   - the content NEVER contains a `[mention:` substring;
 *   - a hashtag still emits its `Hashtag` tag alongside a mention;
 *   - the reply-parent `Mention` is NOT duplicated when the parent is also @mentioned.
 *
 * The delivery/queue layer, the models, and the Oxy client are mocked so the real
 * `FollowService` runs in isolation; assertions read the captured `enqueueDelivery`
 * calls (mirroring the reply-federation test harness).
 */

const {
  enqueueDelivery,
  isFediverseSharingEnabled,
  getUsersByIds,
  getUserById,
  followFindLean,
  actorFindLean,
  actorFindSelectLean,
  actorFindOneLean,
  postFindByIdLean,
  insertMany,
} = vi.hoisted(() => ({
  enqueueDelivery: vi.fn(),
  isFediverseSharingEnabled: vi.fn(),
  getUsersByIds: vi.fn(),
  getUserById: vi.fn(),
  followFindLean: vi.fn(),
  actorFindLean: vi.fn(),
  actorFindSelectLean: vi.fn(),
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
    // `resolveMentionEntries` reads `find({ oxyUserId }).select(...).lean()`;
    // `deliverToFollowers` reads `find({ uri }).lean()`; both chains are stubbed.
    find: () => ({
      select: () => ({ lean: () => actorFindSelectLean() }),
      lean: () => actorFindLean(),
    }),
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
vi.mock('../../../utils/oxyHelpers', () => ({ getServiceOxyClient: () => ({ getUsersByIds, getUserById }) }));

import { followService, type NoteMentionContext } from '../../../connectors/activitypub/follow.service';

const ISO = '2024-05-06T07:08:09.000Z';
const ALICE_ACTOR = 'https://mention.earth/ap/users/alice';
const ALICE_FOLLOWERS = `${ALICE_ACTOR}/followers`;
const AP_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

/** A top-level post as the seam hands it to `federateNewPost`. */
function mentionPost(text: string, mentions: string[], hashtags?: string[]): {
  _id: string;
  content: { variants: Array<{ source: 'author'; text: string; tag: string }> };
  mentions: string[];
  hashtags?: string[];
  createdAt: string;
  visibility: string;
} {
  return {
    _id: 'post1',
    content: { variants: [{ source: 'author', text, tag: 'en' }] },
    mentions,
    ...(hashtags ? { hashtags } : {}),
    createdAt: ISO,
    visibility: 'public',
  };
}

function deliveredInboxes(): string[] {
  return enqueueDelivery.mock.calls.map((c) => (c[0] as { targetInbox: string }).targetInbox);
}
function deliveredNote(): Record<string, unknown> {
  const activity = (enqueueDelivery.mock.calls[0]?.[0] as { activityJson: Record<string, unknown> }).activityJson;
  return activity.object as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  enqueueDelivery.mockResolvedValue(true);
  isFediverseSharingEnabled.mockResolvedValue(true);
  followFindLean.mockResolvedValue([{ remoteActorUri: 'https://foo.example/users/x' }]);
  actorFindLean.mockResolvedValue([{ sharedInboxUrl: 'https://foo.example/inbox' }]);
  actorFindSelectLean.mockResolvedValue([]);
  actorFindOneLean.mockResolvedValue(null);
  postFindByIdLean.mockResolvedValue(null);
  getUsersByIds.mockResolvedValue([]);
});

describe('federateNewPost — mentions a REMOTE user', () => {
  beforeEach(() => {
    // The mentioned user resolves to a FederatedActor row (href + acct + inbox).
    actorFindSelectLean.mockResolvedValue([
      {
        oxyUserId: 'remote-oxy-id',
        uri: 'https://remote.social/users/bob',
        acct: 'bob@remote.social',
        sharedInboxUrl: 'https://remote.social/inbox',
      },
    ]);
  });

  it('emits a mention anchor + Mention tag + remote cc, and never leaks the placeholder', async () => {
    await followService.federateNewPost(
      mentionPost('hey [mention:remote-oxy-id] look', ['remote-oxy-id']),
      'author-oxy',
      'alice',
    );

    const note = deliveredNote();
    // The body carries a resolved Mastodon mention anchor — NOT the raw placeholder.
    expect(note.content).toBe(
      '<p>hey <a href="https://remote.social/users/bob" class="u-url mention">@bob@remote.social</a> look</p>',
    );
    expect(String(note.content)).not.toContain('[mention:');

    // A Mention tag threads + notifies the remote author.
    expect(note.tag).toContainEqual({
      type: 'Mention',
      href: 'https://remote.social/users/bob',
      name: '@bob@remote.social',
    });

    // The remote mentioned actor joins cc (public collection stays in `to`).
    expect(note.cc).toEqual([ALICE_FOLLOWERS, 'https://remote.social/users/bob']);
    expect(note.to).toEqual([AP_PUBLIC]);
  });

  it('unions the mentioned remote user inbox into delivery (deduped with followers)', async () => {
    await followService.federateNewPost(
      mentionPost('yo [mention:remote-oxy-id]', ['remote-oxy-id']),
      'author-oxy',
      'alice',
    );

    expect(deliveredInboxes().sort()).toEqual(
      ['https://foo.example/inbox', 'https://remote.social/inbox'].sort(),
    );
  });
});

describe('federateNewPost — mentions a LOCAL user', () => {
  it('emits a local mention anchor/tag, adds NO cc and NO extra inbox', async () => {
    // No federated actor row → resolved as a local Oxy user via the bulk lookup.
    actorFindSelectLean.mockResolvedValue([]);
    getUsersByIds.mockResolvedValue([{ id: 'local-oxy-id', username: 'carol', name: { displayName: 'Carol' } }]);

    await followService.federateNewPost(
      mentionPost('hi [mention:local-oxy-id]', ['local-oxy-id']),
      'author-oxy',
      'alice',
    );

    const note = deliveredNote();
    expect(note.content).toBe(
      '<p>hi <a href="https://mention.earth/ap/users/carol" class="u-url mention">@carol</a></p>',
    );
    expect(note.tag).toContainEqual({
      type: 'Mention',
      href: 'https://mention.earth/ap/users/carol',
      name: '@carol',
    });
    // A local mention is reached through the author's own followers — never cc'd
    // to a remote collection, never an extra remote inbox.
    expect(note.cc).toEqual([ALICE_FOLLOWERS]);
    expect(deliveredInboxes()).toEqual(['https://foo.example/inbox']);
  });
});

describe('federateNewPost — hashtag alongside a mention', () => {
  it('still emits the Hashtag tag when the post also mentions someone', async () => {
    getUsersByIds.mockResolvedValue([{ id: 'local-oxy-id', username: 'carol', name: { displayName: 'Carol' } }]);

    await followService.federateNewPost(
      mentionPost('hi [mention:local-oxy-id] #news', ['local-oxy-id'], ['news']),
      'author-oxy',
      'alice',
    );

    const tags = deliveredNote().tag as Array<Record<string, string>>;
    expect(tags).toContainEqual({ type: 'Hashtag', href: 'https://mention.earth/hashtag/news', name: '#news' });
    expect(tags).toContainEqual({
      type: 'Mention',
      href: 'https://mention.earth/ap/users/carol',
      name: '@carol',
    });
  });
});

describe('buildCreateNoteActivity — mention/reply Mention dedup', () => {
  it('does not duplicate the reply-parent Mention when the parent author is also @mentioned', () => {
    // The reply parent AND the @mention resolve to the SAME actor href.
    const sharedHref = 'https://remote.social/users/bob';
    const reply = { inReplyTo: 'https://remote.social/users/bob/statuses/9', mention: { href: sharedHref, name: '@bob@remote.social' } };
    const mentions: NoteMentionContext = {
      links: new Map([['remote-oxy-id', { href: sharedHref, handle: 'bob@remote.social' }]]),
      tags: [{ type: 'Mention', href: sharedHref, name: '@bob@remote.social' }],
      cc: [sharedHref],
      inboxes: ['https://remote.social/inbox'],
    };

    const activity = followService.buildCreateNoteActivity(
      { _id: 'p1', content: { variants: [{ source: 'author', text: 'reply to [mention:remote-oxy-id]', tag: 'en' }] }, mentions: ['remote-oxy-id'], createdAt: ISO, parentPostId: 'parent1' },
      'alice',
      reply,
      mentions,
    );
    const note = activity.object as Record<string, unknown>;

    const mentionTags = (note.tag as Array<Record<string, string>>).filter((t) => t.type === 'Mention');
    expect(mentionTags).toEqual([{ type: 'Mention', href: sharedHref, name: '@bob@remote.social' }]);
    // cc carries the shared href exactly once.
    expect(note.cc).toEqual([ALICE_FOLLOWERS, sharedHref]);
  });
});
