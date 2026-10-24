import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { PostType, type FeedPostSlice } from '@mention/shared-types';
vi.mock('../services/PostHydrationService', () => ({
  resolveUserSummaries: vi.fn(
    async (ids: string[]) =>
      new Map(
        ids.map((id) => [
          id,
          { user: { id, username: 'friend', name: { displayName: 'Friend' } } },
        ]),
      ),
  ),
}));
import { connectPostgres, closePostgres, getDb } from '../db/postgres';
import { likes, userSettings } from '../db/schema';
import { clearServiceScope, seedPost, serviceScope } from './helpers/serviceFixtures';
import { getNetworkEngagerCounts } from '../services/networkEngagement';
import {
  attachSocialFeedContext,
  eligibleSocialActors,
  eligibleSocialPostIds,
} from '../services/socialFeedEvidence';
import { friendsEngagedSource } from '../mtn/feed/engine/sources/socialSources';
import { ChronoCursor } from '../mtn/feed/CursorBuilder';
import { forYouDefinition, followingDefinition } from '../mtn/feed/definitions/presets';
const scope = serviceScope('social-feed-evidence');
const viewer = scope.user('viewer'),
  friend = scope.user('friend'),
  privateFriend = scope.user('private'),
  other = scope.user('other');
const now = Date.now();
const ctx = {
  currentUserId: viewer,
  followingIds: [friend, privateFriend, scope.user('draft')],
  rankingAsOf: now,
  paginationSession: true,
};
beforeAll(async () => {
  await connectPostgres();
});
afterEach(async () => {
  await clearServiceScope(scope);
  await getDb()
    .delete(userSettings)
    .where(inArray(userSettings.oxyUserId, [friend, privateFriend]));
});
afterAll(async () => {
  await closePostgres();
});
async function optIn() {
  await getDb().insert(userSettings).values({ oxyUserId: friend, privacyShowLikes: true });
}
async function post(extra: Parameters<typeof seedPost>[1] = {}) {
  return seedPost(scope, { oxyUserId: other, createdAt: new Date(now - 2000), ...extra });
}
async function like(id: string, userId = friend, value: 1 | -1 = 1) {
  await getDb()
    .insert(likes)
    .values({ userId, postId: id, value, createdAt: new Date(now - 1000) });
}
function slice(id: string): FeedPostSlice {
  return {
    _sliceKey: id,
    isIncompleteThread: false,
    items: [
      {
        post: { id } as never,
        isThreadParent: false,
        isThreadChild: false,
        isThreadLastChild: true,
      },
    ],
  };
}
describe('public social recommendation evidence', () => {
  it('uses positive opted-in likes and public published boosts; counts each actor once', async () => {
    await optIn();
    const target = await post();
    await like(target.id);
    await like(target.id, privateFriend);
    await post({ oxyUserId: friend, type: PostType.BOOST, boostOf: target.id });
    await post({
      oxyUserId: privateFriend,
      type: PostType.BOOST,
      boostOf: target.id,
      visibility: 'private',
    });
    await post({
      oxyUserId: scope.user('draft'),
      type: PostType.BOOST,
      boostOf: target.id,
      status: 'draft',
    });
    expect((await getNetworkEngagerCounts([target.id], ctx.followingIds)).get(target.id)).toBe(1);
    await getDb().update(likes).set({ value: -1 }).where(eq(likes.userId, friend));
    // The valid public boost remains positive; private likes/boosts never add a second actor.
    expect((await getNetworkEngagerCounts([target.id], ctx.followingIds)).get(target.id)).toBe(1);
    const downvoteOnly = await post();
    await like(downvoteOnly.id, friend, -1);
    expect((await getNetworkEngagerCounts([downvoteOnly.id], ctx.followingIds)).size).toBe(0);
  });
  it('adds a novel eligible author via the real ForYou social source and drains chronological windows losslessly', async () => {
    await optIn();
    const wanted = [];
    for (let i = 0; i < 5; i++) {
      const target = await post({ createdAt: new Date(now - 2000 - i * 1000) });
      wanted.push(target);
      await like(target.id);
    }
    const orphanReply = await post({
      isReply: true,
      federation: {
        activityId: 'https://example.test/social/orphan',
        inReplyTo: 'https://example.test/social/missing',
      },
    });
    await like(orphanReply.id);
    const privateLike = await post();
    await like(privateLike.id, privateFriend);
    const module = forYouDefinition.sources.find((source) => source.module === 'friendsEngaged');
    expect(module?.enabled).toBe(true);
    expect(followingDefinition.sources.some((source) => source.module === 'friendsEngaged')).toBe(
      false,
    );
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 4; i++) {
      const rows = await friendsEngagedSource.gather({ ...ctx, cursor }, module?.params ?? {}, 2);
      seen.push(...rows.map((p) => p.id));
      const last = rows.at(-1);
      if (!last || rows.length < 2) break;
      cursor = ChronoCursor.build(last.id, last.createdAt);
    }
    expect(seen).toEqual(wanted.map((p) => p.id));
    expect(new Set(seen).size).toBe(5);
  });
  it('keeps provenance on the focal reply, and removes it after privacy opt-out or unlike', async () => {
    await optIn();
    const target = await post();
    await like(target.id);
    const parent = await post();
    const item = slice(target.id);
    item.reason = { type: 'replyContext' };
    item.items.unshift(slice(parent.id).items[0]);
    await attachSocialFeedContext([item], ctx);
    expect(await eligibleSocialPostIds([target.id], ctx)).toEqual(new Set([target.id]));
    expect(item.socialContext).toMatchObject({
      type: 'likedBy',
      postId: target.id,
      actors: [{ id: friend }],
      total: 1,
    });
    await getDb()
      .update(userSettings)
      .set({ privacyShowLikes: false })
      .where(eq(userSettings.oxyUserId, friend));
    expect(await eligibleSocialPostIds([target.id], ctx)).toEqual(new Set());
    const hidden = slice(target.id);
    await attachSocialFeedContext([hidden], ctx);
    expect(hidden.socialContext).toBeUndefined();
    await getDb()
      .update(userSettings)
      .set({ privacyShowLikes: true })
      .where(eq(userSettings.oxyUserId, friend));
    await getDb().delete(likes).where(eq(likes.postId, target.id));
    expect(await eligibleSocialPostIds([target.id], ctx)).toEqual(new Set());
    const unliked = slice(target.id);
    await attachSocialFeedContext([unliked], ctx);
    expect(unliked.socialContext).toBeUndefined();
  });
  it('attributes public boosts separately, prefers public likes, and keeps content when actor lookup fails', async () => {
    await optIn();
    const target = await post();
    await post({ oxyUserId: friend, type: PostType.BOOST, boostOf: target.id });
    expect(await eligibleSocialPostIds([target.id], ctx)).toEqual(new Set([target.id]));
    const boosted = slice(target.id);
    await attachSocialFeedContext([boosted], ctx);
    expect(boosted.socialContext).toMatchObject({
      type: 'boostedBy',
      postId: target.id,
      total: 1,
      actors: [{ id: friend }],
    });
    await like(target.id);
    const liked = slice(target.id);
    await attachSocialFeedContext([liked], ctx);
    expect(liked.socialContext?.type).toBe('likedBy');
    const { resolveUserSummaries } = await import('../services/PostHydrationService');
    vi.mocked(resolveUserSummaries).mockRejectedValueOnce(new Error('actor service unavailable'));
    const unavailable = slice(target.id);
    await expect(attachSocialFeedContext([unavailable], ctx)).resolves.toBeUndefined();
    expect(unavailable.items[0].post.id).toBe(target.id);
    expect(unavailable.socialContext).toBeUndefined();
    await getDb().delete(likes).where(eq(likes.postId, target.id));
    expect(await eligibleSocialPostIds([target.id], ctx)).toEqual(new Set([target.id]));
  });

  it.each(['hiddenAuthors', 'mutedAuthors', 'blockedAuthors'] as const)(
    'excludes %s from supply and attribution',
    async (field) => {
      await optIn();
      const target = await post();
      await like(target.id);
      const hidden = { ...ctx, userBehavior: { [field]: [friend] } } as typeof ctx;
      expect(eligibleSocialActors(hidden)).not.toContain(friend);
      expect(await friendsEngagedSource.gather(hidden, { discovery: true }, 20)).toEqual([]);
      const item = slice(target.id);
      await attachSocialFeedContext([item], hidden);
      expect(item.socialContext).toBeUndefined();
    },
  );
});

describe('social evidence query plan', () => {
  const planAuthor = scope.user('plan-inventory');
  beforeAll(async () => {
    const { sql } = await import('drizzle-orm');
    // Prepare realistic inventory outside the query test's default deadline.
    // The database is private to this file, including its planner statistics.
    await getDb().execute(
      sql`insert into posts (id,oxy_user_id,type,visibility,status,created_at) select ${planAuthor} || '-' || i::text, ${planAuthor}, 'text','public','published',date_trunc('milliseconds',now())-interval '1 hour' from generate_series(1,10000) i`,
    );
    await getDb().execute(sql`analyze posts`);
  });
  afterAll(async () => {
    const { posts } = await import('../db/schema');
    await getDb().delete(posts).where(eq(posts.oxyUserId, planAuthor));
  });

  it('does not walk unrelated post inventory when the indexed activity cohort is empty', async () => {
    const { sql } = await import('drizzle-orm');
    const { networkEngagementExistsSql } = await import('../services/socialFeedEvidence');
    const result = await getDb().execute(
      sql`explain (analyze,buffers,format json) select id from posts where ${networkEngagementExistsSql([scope.user('no-activity')], new Date(now - 86400000), new Date(now))} order by created_at desc,id desc limit 20`,
    );
    const plan = (result[0]['QUERY PLAN'] as Array<{ Plan: Record<string, unknown> }>)[0].Plan;
    const nodes: Record<string, unknown>[] = [];
    const walk = (node: Record<string, unknown>) => {
      nodes.push(node);
      for (const child of (node.Plans ?? []) as Record<string, unknown>[]) walk(child);
    };
    walk(plan);
    const targetReads = nodes.filter(
      (node) => node['Relation Name'] === 'posts' && node.Alias === 'posts',
    );
    expect(targetReads.length).toBeGreaterThan(0);
    expect(targetReads.every((node) => node['Actual Loops'] === 0)).toBe(true);
    expect(plan['Actual Rows']).toBe(0);
  });
});
