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

import { PostVisibility } from '@mention/shared-types';
import { closePostgres, connectPostgres } from '../../db/postgres';
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
const MODERATOR = scope.user('moderator');

const accounts: Record<string, { kind: string; username: string }> = {
  [MEMBER]: { kind: 'personal', username: 'member' },
  [REPLIER]: { kind: 'personal', username: 'replier' },
  [BANNED]: { kind: 'personal', username: 'banned' },
  [MODERATOR]: { kind: 'personal', username: 'moderator' },
  [COMMUNITY]: { kind: 'community', username: 'forum' },
};

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
  await insertCommunityBan({
    communityOxyUserId: COMMUNITY,
    bannedOxyUserId: BANNED,
    bannedByOxyUserId: MODERATOR,
    reason: null,
  });
});

afterAll(async () => {
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
      if (account) map.set(id, { user: { id, ...account, name: {}, isFederated: false } });
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
});
