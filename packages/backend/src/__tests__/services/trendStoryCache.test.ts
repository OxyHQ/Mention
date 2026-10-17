/**
 * `resolveTrendStory` (the `trending` row lookup every `trend|<term>` page
 * resolves before it can match posts) is cached for 30s — see its doc comment
 * in `services/trendStoryCache.ts`.
 *
 * The global test setup mocks `utils/redis` with an always-`isReady: false`
 * client (so ordinary tests never depend on a real Redis instance — see
 * `__tests__/setup.ts`), which would make every cache in this suite a
 * permanent miss and this file unable to observe caching at all. This file
 * overrides that mock locally with a small working, Map-backed fake — the
 * same technique `utils/cache.test.ts` uses to test the shared primitive —
 * so `getOrCompute` really does hit and really does persist between calls.
 *
 * What this pins:
 * 1. A repeat lookup of the SAME term does not re-read `trending`.
 * 2. Two DIFFERENT terms are never served each other's cached story.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';

const store = new Map<string, string>();
const client = {
  isReady: true,
  get: vi.fn(async (key: string) => store.get(key) ?? null),
  setEx: vi.fn(async (key: string, _ttl: number, value: string) => {
    store.set(key, value);
    return 'OK';
  }),
  del: vi.fn(async (...keys: string[]) => {
    let removed = 0;
    for (const key of keys) {
      if (store.delete(key)) removed += 1;
    }
    return removed;
  }),
};

vi.mock('../../utils/redis', () => ({
  getRedisClient: () => client,
  reportRedisConnectionFailure: vi.fn(),
}));

import { config } from '../../config';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { trending, trendStoryPosts } from '../../db/schema/discovery';
import { insertPostRecord } from '../../db/posts/postRepository';
import { metrics } from '../../utils/metrics';
import { resolveTrendStory } from '../../services/trendStoryCache';

const seededIds: string[] = [];
const seededPostIds: string[] = [];
let previousInstrumentationSetting = false;

beforeAll(async () => {
  previousInstrumentationSetting = config.postgres.queryMetricsEnabled;
  config.postgres.queryMetricsEnabled = true;
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
  config.postgres.queryMetricsEnabled = previousInstrumentationSetting;
});

beforeEach(() => {
  store.clear();
});

afterEach(async () => {
  const ids = seededIds.splice(0);
  if (ids.length > 0) {
    await getDb().delete(trending).where(inArray(trending.id, ids));
  }
  const postIds = seededPostIds.splice(0);
  if (postIds.length > 0) {
    await getDb().delete(posts).where(inArray(posts.id, postIds));
  }
});

async function seedTrend(name: string, terms: string[]): Promise<string> {
  const [row] = await getDb()
    .insert(trending)
    .values({ type: 'entity', name, terms, score: 1, rank: 0, calculatedAt: new Date() })
    .returning({ id: trending.id });
  seededIds.push(row.id);
  return row.id;
}

async function seedMember(trendId: string, name: string): Promise<void> {
  const author = `story-cache-author-${Date.now()}`;
  const post = await insertPostRecord({
    oxyUserId: author,
    authorship: [{ oxyUserId: author, role: 'owner', status: 'accepted' }],
    status: 'published',
    visibility: 'public',
    content: { variants: [{ source: 'author', text: name }] },
  });
  seededPostIds.push(post.id);
  await getDb()
    .insert(trendStoryPosts)
    .values({ trendId, postId: post.id, relevance: 1, matchedTerms: [name] });
}

async function trendingSelectCount(): Promise<number> {
  return metrics
    .getSeries('db_query_duration_ms')
    .filter(({ labels }) => labels.table === 'trending')
    .reduce((total, { count }) => total + count, 0);
}

describe('resolveTrendStory caching', () => {
  it('reads `trending` once for repeat lookups of the SAME term', async () => {
    const term = `story-cache-alpha-${Date.now()}`;
    await seedTrend(term, [term, 'merged-alias']);

    metrics.reset();
    const first = await resolveTrendStory(term);
    const second = await resolveTrendStory(term);

    expect(first.terms).toEqual([term, 'merged-alias']);
    expect(second).toEqual(first);
    expect(await trendingSelectCount()).toBe(1);
  });

  it('never serves one term’s cached story to another', async () => {
    const termA = `story-cache-bravo-${Date.now()}`;
    const termB = `story-cache-charlie-${Date.now()}`;
    await seedTrend(termA, [termA, 'alias-a']);
    await seedTrend(termB, [termB, 'alias-b']);

    const storyA = await resolveTrendStory(termA);
    const storyB = await resolveTrendStory(termB);

    expect(storyA.terms).toEqual([termA, 'alias-a']);
    expect(storyB.terms).toEqual([termB, 'alias-b']);
    expect(storyA.trendId).not.toBe(storyB.trendId);
  });

  it('reports whether the story has members, and caches that answer too', async () => {
    const withMembers = `story-cache-members-${Date.now()}`;
    const without = `story-cache-memberless-${Date.now()}`;
    await seedMember(await seedTrend(withMembers, [withMembers]), withMembers);
    await seedTrend(without, [without]);

    expect((await resolveTrendStory(withMembers)).hasMembers).toBe(true);
    expect((await resolveTrendStory(without)).hasMembers).toBe(false);

    // Cached: a member added inside the TTL is not seen until it expires.
    await seedMember(seededIds[seededIds.length - 1], without);
    expect((await resolveTrendStory(without)).hasMembers).toBe(false);
  });

  it('falls back to the bare term, uncached, when no row exists', async () => {
    const term = `story-cache-unmatched-${Date.now()}`;

    metrics.reset();
    const first = await resolveTrendStory(term);
    const second = await resolveTrendStory(term);

    expect(first).toEqual({ terms: [term] });
    expect(second).toEqual({ terms: [term] });
    // A genuine "no row" answer is still a stable, cacheable one (unlike a
    // thrown error) — one lookup, not two.
    expect(await trendingSelectCount()).toBe(1);
  });
});
