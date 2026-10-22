import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A community HOSTED HERE (an Oxy `community` account, FEP-1b12 `Group`), end to
 * end over real rows: who may post in it, what the community relays, and what a
 * moderator's removal undoes. Oxy (identity, membership, publication policy) and
 * the delivery transport are the boundary.
 */

const h = vi.hoisted(() => ({
  resolveUserSummaries: vi.fn(),
  publicationPolicies: vi.fn(),
  deliverToFollowers: vi.fn(async () => undefined),
}));
// Communities are a private preview; everyone but OUTSIDER is in it here.
vi.mock('../../services/communities/communityPreview', () => ({
  isInCommunitiesPreview: async (id: string | null) => !!id && !id.includes('outsider'),
}));
vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async () => []) },
  resolveUserSummaries: h.resolveUserSummaries,
}));
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    safety: {
      publicationPolicies: h.publicationPolicies,
      profileAccess: async () => ({ allowed: true }),
    },
  }),
}));
vi.mock('../../connectors/activitypub/delivery.service', () => ({
  deliveryService: { deliverToFollowers: h.deliverToFollowers, queueDelivery: vi.fn() },
}));
vi.mock('../../services/fediverseSharing', () => ({
  isFediverseSharingEnabled: async () => true,
}));
vi.mock('../../services/PostRecentReplierService', () => ({
  recordRecentReplierForPost: vi.fn(async () => undefined),
}));
vi.mock('../../services/postEnrichment', () => ({ enrichIngestedPosts: vi.fn() }));
vi.mock('../../services/mtn/MentionRecordEmitter', () => ({
  emitPostCreated: vi.fn(async () => undefined),
  emitRepostCreated: vi.fn(async () => undefined),
}));
vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));
vi.mock('../../services/postSafetyAccess', () => ({
  loadPostSafetyDecisions: async (records: Array<{ id: string }>) =>
    new Map(records.map((record) => [record.id, { allowed: true }])),
}));

import { eq } from 'drizzle-orm';
import { PostVisibility } from '@mention/shared-types';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { federatedActors } from '../../db/schema/federation';
import { clearServiceScope, readPost, serviceScope, trackPost } from '../helpers/serviceFixtures';
import { postCreationService } from '../../services/PostCreationService';
import { CommunityPostError } from '../../services/communities/communityPosting';
import { removePostFromCommunity } from '../../services/communities/communityModeration';
import {
  deleteCommunityBan,
  insertCommunityBan,
} from '../../db/communities/communityBanRepository';
import { followService } from '../../connectors/activitypub/follow.service';
import {
  buildCommunityAnnounce,
  resolveLocalCommunityActor,
} from '../../connectors/activitypub/communityRelay';
import { authorizeFederationDelivery } from '../../services/federation/publicationPolicy';

const scope = serviceScope('native-communities');
const MEMBER = scope.user('member');
const REPLIER = scope.user('replier');
const BANNED = scope.user('banned');
const COMMUNITY = scope.user('forum');
const OUTSIDER = scope.user('outsider');
const MODERATOR = scope.user('moderator');
const LEMMY = scope.user('lemmy-technology');
const LEMMY_ACTOR = 'https://lemmy.example/c/technology';
const LEMMY_INBOX = 'https://lemmy.example/inbox';

const accounts: Record<string, { kind: string; username: string }> = {
  [MEMBER]: { kind: 'personal', username: 'member' },
  [REPLIER]: { kind: 'personal', username: 'replier' },
  [BANNED]: { kind: 'personal', username: 'banned' },
  [MODERATOR]: { kind: 'personal', username: 'moderator' },
  [COMMUNITY]: { kind: 'community', username: 'forum' },
  [LEMMY]: { kind: 'community', username: 'technology@lemmy.example' },
};
const FEDERATED = new Set([LEMMY]);

const memberReader = {
  accounts: {
    members: {
      list: vi.fn(async () => [
        {
          _id: 'row',
          accountId: COMMUNITY,
          memberUserId: MODERATOR,
          role: 'editor' as const,
          permissions: ['members:read'],
          inherit: true,
          status: 'active' as const,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
    },
  },
};

const quiet = { skipNotifications: true, skipSocketEmit: true, skipFederationDelivery: true };

beforeAll(async () => {
  await connectPostgres();
  await clearServiceScope(scope);
  await getDb()
    .insert(federatedActors)
    .values({
      protocol: 'activitypub',
      uri: LEMMY_ACTOR,
      type: 'Group',
      username: 'technology',
      domain: 'lemmy.example',
      acct: 'technology@lemmy.example',
      inboxUrl: LEMMY_INBOX,
      oxyUserId: LEMMY,
    })
    .onConflictDoNothing();
  await insertCommunityBan({
    communityOxyUserId: COMMUNITY,
    bannedOxyUserId: BANNED,
    bannedByOxyUserId: MODERATOR,
    reason: null,
  });
});

afterAll(async () => {
  await getDb().delete(federatedActors).where(eq(federatedActors.uri, LEMMY_ACTOR));
  await deleteCommunityBan(COMMUNITY, BANNED);
  await clearServiceScope(scope);
  await closePostgres();
});

beforeEach(() => {
  h.deliverToFollowers.mockClear();
  h.resolveUserSummaries.mockImplementation(async (ids: string[]) => {
    const map = new Map();
    for (const id of ids) {
      const account = accounts[id];
      if (account)
        map.set(id, { user: { id, ...account, name: {}, isFederated: FEDERATED.has(id) } });
    }
    return map;
  });
  h.publicationPolicies.mockImplementation(
    async ({ authorAccountIds }: { authorAccountIds: string[] }) => ({
      items: authorAccountIds.map((authorAccountId) => ({
        authorAccountId,
        policy: {
          publicationAllowed: true,
          requiredAudience: null,
          collaborationAllowed: true,
          federationAllowed: true,
          policyVersion: '2',
        },
      })),
    }),
  );
});

describe('a community hosted here', () => {
  it('takes posts from anybody it has not banned, and its threads keep it', async () => {
    const post = await postCreationService.create({
      oxyUserId: MEMBER,
      content: { text: 'first post', title: 'Hello forum' },
      communityOxyUserId: COMMUNITY,
      ...quiet,
    });
    trackPost(scope, post.id);
    const stored = await readPost(post.id);
    expect(stored?.oxyUserId).toBe(MEMBER);
    expect(stored?.communityOxyUserId).toBe(COMMUNITY);
    expect(stored?.content.title).toBe('Hello forum');

    // A reply names no community; it is written in its thread's.
    const reply = await postCreationService.create({
      oxyUserId: REPLIER,
      content: { text: 'a comment' },
      parentPostId: post.id,
      threadId: post.id,
      ...quiet,
    });
    trackPost(scope, reply.id);
    expect((await readPost(reply.id))?.communityOxyUserId).toBe(COMMUNITY);

    const refusal = (params: Parameters<typeof postCreationService.create>[0]) =>
      postCreationService.create({ ...params, ...quiet }).catch((error: unknown) => error);
    const banned = await refusal({
      oxyUserId: BANNED,
      content: { text: 'let me in' },
      communityOxyUserId: COMMUNITY,
    });
    expect(banned).toBeInstanceOf(CommunityPostError);
    expect((banned as CommunityPostError).status).toBe(403);
    const bannedReply = await refusal({
      oxyUserId: BANNED,
      content: { text: 'or here' },
      parentPostId: post.id,
      threadId: post.id,
    });
    expect((bannedReply as CommunityPostError).status).toBe(403);
    const notACommunity = await refusal({
      oxyUserId: MEMBER,
      content: { text: 'hm' },
      communityOxyUserId: REPLIER,
    });
    expect((notACommunity as CommunityPostError).status).toBe(400);
    const privatePost = await refusal({
      oxyUserId: MEMBER,
      content: { text: 'hm' },
      communityOxyUserId: COMMUNITY,
      visibility: PostVisibility.FOLLOWERS_ONLY,
    });
    expect((privatePost as CommunityPostError).status).toBe(400);

    // Outside the preview a community does not exist: naming one is a 404, and
    // a reply in its thread is an ordinary reply that is not filed under it.
    const outsiderPost = await refusal({
      oxyUserId: OUTSIDER,
      content: { text: 'is it there?' },
      communityOxyUserId: COMMUNITY,
    });
    expect((outsiderPost as CommunityPostError).status).toBe(404);
    const outsiderReply = await postCreationService.create({
      oxyUserId: OUTSIDER,
      content: { text: 'just a reply' },
      parentPostId: post.id,
      threadId: post.id,
      ...quiet,
    });
    trackPost(scope, outsiderReply.id);
    expect((await readPost(outsiderReply.id))?.communityOxyUserId).toBeNull();
  });

  it("relays its members' posts as Announces, and stops vouching once a moderator removes one", async () => {
    const post = await postCreationService.create({
      oxyUserId: MEMBER,
      content: { text: 'relay me', title: 'A link post' },
      communityOxyUserId: COMMUNITY,
      ...quiet,
    });
    trackPost(scope, post.id);
    const community = await resolveLocalCommunityActor(COMMUNITY);
    expect(community?.actorUri).toMatch(/\/ap\/users\/forum$/);
    if (!community) return;

    // The member's own Create names the community; a titled post is a `Page`.
    const stored = await readPost(post.id);
    if (!stored) throw new Error('the post was not stored');
    await followService.federateNewPost({ ...stored, visibility: 'public' }, MEMBER, 'member');
    const [memberDelivery, communityDelivery] = h.deliverToFollowers.mock.calls as unknown as Array<
      [Record<string, unknown>, string, string]
    >;
    const create = memberDelivery[0];
    expect(create.object).toMatchObject({
      type: 'Page',
      name: 'A link post',
      audience: community.actorUri,
    });
    expect(create.cc).toContain(community.actorUri);
    // …and the community relays it, signed as itself, to its own followers.
    expect(communityDelivery[1]).toBe(COMMUNITY);
    const announce = communityDelivery[0];
    expect(announce).toEqual(buildCommunityAnnounce(community, create));
    expect(announce).toMatchObject({ type: 'Announce', actor: community.actorUri });
    expect(
      await authorizeFederationDelivery({ activity: announce, senderAccountId: COMMUNITY }),
    ).toBe(true);

    // A moderator removes it: the post stays its author's, out of the community,
    // and the community no longer vouches for it.
    await removePostFromCommunity({
      communityOxyUserId: COMMUNITY,
      moderatorOxyUserId: MODERATOR,
      memberReader,
      postId: post.id,
      reason: 'off topic',
    });
    const removed = await readPost(post.id);
    expect(removed?.oxyUserId).toBe(MEMBER);
    expect(removed?.communityOxyUserId).toBeNull();
    expect(
      await authorizeFederationDelivery({ activity: announce, senderAccountId: COMMUNITY }),
    ).toBe(false);
    // The removal itself is relayed as a moderator's Delete.
    const removal = (
      h.deliverToFollowers.mock.calls.at(-1) as unknown as [Record<string, unknown>]
    )[0];
    expect(removal.object).toMatchObject({
      type: 'Delete',
      actor: expect.stringMatching(/\/ap\/users\/moderator$/),
      summary: 'off topic',
    });
    expect(
      await authorizeFederationDelivery({ activity: removal, senderAccountId: COMMUNITY }),
    ).toBe(true);
    // A non-moderator cannot remove anything.
    await expect(
      removePostFromCommunity({
        communityOxyUserId: COMMUNITY,
        moderatorOxyUserId: MEMBER,
        memberReader,
        postId: post.id,
        reason: null,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('delivers a post written in a REMOTE community, and its thread, to the community', async () => {
    const post = await postCreationService.create({
      oxyUserId: MEMBER,
      content: { text: 'hello lemmy', title: 'From Mention' },
      communityOxyUserId: LEMMY,
      ...quiet,
    });
    trackPost(scope, post.id);
    const reply = await postCreationService.create({
      oxyUserId: REPLIER,
      content: { text: 'a comment from Mention' },
      parentPostId: post.id,
      threadId: post.id,
      ...quiet,
    });
    trackPost(scope, reply.id);
    expect((await readPost(reply.id))?.communityOxyUserId).toBe(LEMMY);

    h.deliverToFollowers.mockClear();
    const stored = await readPost(post.id);
    if (!stored) throw new Error('the post was not stored');
    await followService.federateNewPost({ ...stored, visibility: 'public' }, MEMBER, 'member');
    // One delivery — the member's followers plus the community's inbox; a remote
    // community announces it itself, so nothing is relayed from here.
    expect(h.deliverToFollowers).toHaveBeenCalledTimes(1);
    const [create, , , options] = h.deliverToFollowers.mock.calls[0] as unknown as [
      Record<string, unknown>,
      string,
      string,
      { extraInboxes: string[] },
    ];
    expect(create.object).toMatchObject({
      type: 'Page',
      name: 'From Mention',
      audience: LEMMY_ACTOR,
    });
    expect(create.cc).toContain(LEMMY_ACTOR);
    expect(options.extraInboxes).toContain(LEMMY_INBOX);
  });
});
