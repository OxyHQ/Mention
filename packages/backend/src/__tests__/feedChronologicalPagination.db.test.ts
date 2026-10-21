import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Keep the real source, keyset SQL, slicer and engine. Account hydration is not
// relevant to whether the engine strands or over-delivers source candidates.
vi.mock('../services/PostHydrationService', () => ({
  postHydrationService: {
    hydrateSlices: vi.fn(async (slices: unknown[]) => slices),
    hydratePosts: vi.fn(async (posts: unknown[]) => posts),
  },
  resolveUserSummaries: vi.fn(async () => new Map()),
}));

import { connectPostgres, closePostgres } from '../db/postgres';
import { clearServiceScope, seedPost, serviceScope } from './helpers/serviceFixtures';
import { FeedEngine } from '../mtn/feed/engine/FeedEngine';
import { FeedModuleRegistry } from '../mtn/feed/engine/FeedModuleRegistry';
import { keywordsSource } from '../mtn/feed/engine/sources/userSources';
import { followingSource } from '../mtn/feed/engine/sources/forYouSources';
import { followingDefinition, hashtagDefinition } from '../mtn/feed/definitions/presets';

const scope = serviceScope('chrono-page-boundary');
const author = scope.user('author');
const tag = 'chronopageboundaryfixture';
const expected: string[] = [];
beforeAll(async () => {
  await connectPostgres();
  const now = Date.now();
  for (let index = 0; index < 61; index += 1) {
    const post = await seedPost(scope, {
      oxyUserId: author,
      createdAt: new Date(now - index * 1000),
      hashtags: index === 0 ? [tag, 'hidden'] : [tag],
    });
    if (index > 0) expected.push(post.id);
  }
});
afterAll(async () => {
  await clearServiceScope(scope);
  await closePostgres();
});

describe('chronological page bounds with real source keysets', () => {
  it.each(['hashtag', 'following'] as const)(
    '%s fills a partially filtered page without over-delivery or skipping later rows',
    async (kind) => {
      const registry = new FeedModuleRegistry();
      registry.register(keywordsSource);
      registry.register(followingSource);
      registry.register({
        id: 'rejectFixture',
        kind: 'filter',
        keep: (post) => !post.hashtags.includes('hidden'),
      });
      const preset = kind === 'hashtag' ? hashtagDefinition(tag) : followingDefinition;
      const definition = { ...preset, filters: [{ module: 'rejectFixture', enabled: true }] };
      const engine = new FeedEngine(registry);
      const served: string[] = [];
      let cursor: string | undefined;
      let hasMore = true;
      for (let page = 0; page < 4 && hasMore; page += 1) {
        const result = await engine.run(
          definition,
          {
            currentUserId: scope.user('viewer'),
            followingIds: [author],
          },
          { limit: 20, cursor },
        );
        expect(result.slices).toHaveLength(20);
        expect(result.items).toHaveLength(20);
        served.push(...result.items.map((post) => post.id));
        cursor = result.nextCursor;
        hasMore = result.hasMore;
      }
      expect(hasMore).toBe(false);
      expect(served).toEqual(expected);
      expect(new Set(served).size).toBe(60);
    },
  );
});
