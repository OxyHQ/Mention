import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('../services/PostHydrationService', () => ({
  postHydrationService: {
    hydrateSlices: vi.fn(async (slices: unknown[]) => slices),
    hydratePosts: vi.fn(async (posts: unknown[]) => posts),
  },
  resolveUserSummaries: vi.fn(async () => new Map()),
}));
import { eq } from 'drizzle-orm';
import { connectPostgres, closePostgres, getDb } from '../db/postgres';
import { posts, userBehaviors } from '../db/schema';
import { updateUserBehavior } from '../db/userProfile/userBehaviorRepository';
import { clearServiceScope, seedPost, serviceScope } from './helpers/serviceFixtures';
import { loadViewerFeedContext } from '../mtn/feed/feedContext';
import { FeedEngine } from '../mtn/feed/engine/FeedEngine';
import { FeedModuleRegistry } from '../mtn/feed/engine/FeedModuleRegistry';
import { registerAllModules } from '../mtn/feed/engine';
import { exploreDefinition } from '../mtn/feed/definitions/presets';
import { exploreSource } from '../mtn/feed/engine/sources/discoverySources';
import { feedRankingService } from '../services/FeedRankingService';
import { negativePenalty } from '../services/ranking/signals/negativePenalty';
import { EXPLORE_RANKING_VERSION, ScoreCursor } from '../mtn/feed/CursorBuilder';
import type { PostRecord } from '../db/posts/postRecord';

const scope = serviceScope('explore-negative-intent');
const viewer = scope.user('viewer');
const now = Date.now();
const fixtures: PostRecord[] = [];
const registry = new FeedModuleRegistry();
registerAllModules(registry);
const engine = new FeedEngine(registry);
const definition = {
  ...exploreDefinition,
  discoveryFilters: [],
  execution: { ...exploreDefinition.execution, sessionPagination: false },
};
beforeAll(async () => {
  await connectPostgres();
  const variants = [
    { oxyUserId: scope.user('excluded') },
    { oxyUserId: scope.user('tag'), hashtags: ['UNWANTED'] },
    { oxyUserId: scope.user('baseline'), postClassification: { topics: ['UNWANTED'] } },
    { oxyUserId: scope.user('refs'), postClassification: { topicRefs: [{ name: 'UNWANTED' }] } },
    {
      oxyUserId: scope.user('refs-override'),
      postClassification: { topics: ['unwanted'], topicRefs: [{ name: 'other' }] },
    },
    { oxyUserId: scope.user('zero-engagement') },
    { oxyUserId: scope.user('low-engagement') },
  ];
  for (const variant of variants)
    fixtures.push(await seedPost(scope, { ...variant, createdAt: new Date(now - 1000) }));
  await getDb().update(posts).set({ statsLikesCount: 1 }).where(eq(posts.id, fixtures[6].id));
});
afterAll(async () => {
  await clearServiceScope(scope);
  await getDb().delete(userBehaviors).where(eq(userBehaviors.oxyUserId, viewer));
  await closePostgres();
});
async function context() {
  return { ...(await loadViewerFeedContext(viewer, undefined)), rankingAsOf: now };
}

describe('Explore source respects explicit negative intent without reapplying ranking', () => {
  it.each(['hiddenAuthors', 'mutedAuthors', 'blockedAuthors'] as const)(
    '%s excludes the author; canonical topic penalty is applied exactly once',
    async (field) => {
      await updateUserBehavior(
        viewer,
        (behavior) => {
          behavior.hiddenAuthors = [];
          behavior.mutedAuthors = [];
          behavior.blockedAuthors = [];
          behavior.hiddenTopics = [];
        },
        { createIfMissing: true },
      );
      const neutral = await exploreSource.gather(await context(), {}, 20);
      await updateUserBehavior(viewer, (behavior) => {
        behavior[field] = [scope.user('excluded')];
        behavior.hiddenTopics = ['UNWANTED'];
      });
      const ctx = await context();
      expect(ctx.userBehavior?.[field]).toEqual([scope.user('excluded')]);
      const rows = await exploreSource.gather(ctx, {}, 20);
      expect(rows.some((post) => post.id === fixtures[0].id)).toBe(false);
      for (const fixture of fixtures.slice(1)) {
        const before = neutral.find((post) => post.id === fixture.id)?.finalScore;
        const after = rows.find((post) => post.id === fixture.id)?.finalScore;
        expect(before).toBeGreaterThan(0);
        expect(after).toBeCloseTo(
          (before ?? 0) * negativePenalty(fixture, viewer, ctx.userBehavior),
          12,
        );
      }
      expect(rows.find((post) => post.id === fixtures[4].id)?.finalScore).toBe(
        neutral.find((post) => post.id === fixtures[4].id)?.finalScore,
      );
      expect(rows.find((post) => post.id === fixtures[6].id)?.finalScore).toBeGreaterThan(
        rows.find((post) => post.id === fixtures[5].id)?.finalScore ?? 0,
      );
      const ranking = vi.spyOn(feedRankingService, 'rankPosts');
      try {
        const response = await engine.run(definition, ctx, { limit: 20 });
        expect(response.items.map((post) => post.id)).toEqual(rows.map((post) => post.id));
        expect(ranking).not.toHaveBeenCalled();
      } finally {
        ranking.mockRestore();
      }
    },
  );
  it('paginates the penalized SQL order without duplicates or skipped zero-engagement posts', async () => {
    await updateUserBehavior(
      viewer,
      (behavior) => {
        behavior.hiddenAuthors = [scope.user('excluded')];
        behavior.mutedAuthors = [];
        behavior.blockedAuthors = [];
        behavior.hiddenTopics = ['UNWANTED'];
      },
      { createIfMissing: true },
    );
    const ctx = await context();
    const expected = await exploreSource.gather(ctx, {}, 20);
    const served: string[] = [];
    let cursor: string | undefined;
    let hasMore = true;
    for (let page = 0; page < 5 && hasMore; page++) {
      const result = await engine.run(definition, ctx, { limit: 2, cursor });
      served.push(...result.items.map((post) => post.id));
      cursor = result.nextCursor;
      hasMore = result.hasMore;
      if (cursor) expect(ScoreCursor.parse(cursor)?.rankingVersion).toBe(EXPLORE_RANKING_VERSION);
    }
    expect(hasMore).toBe(false);
    expect(served).toEqual(expected.map((post) => post.id));
    expect(new Set(served).size).toBe(6);
  });
  it('rejects the old pre-scored score boundary with the explicit restart contract', async () => {
    await expect(
      engine.run(definition, await context(), {
        limit: 2,
        cursor: ScoreCursor.build(1, fixtures[0].id, { asOf: now, rankingVersion: 2 }),
      }),
    ).rejects.toMatchObject({ statusCode: 410, code: 'FEED_CURSOR_EXPIRED' });
  });
});
