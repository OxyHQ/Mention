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
import { trending } from '../../db/schema/discovery';
import { metrics } from '../../utils/metrics';
import { resolveTrendStory } from '../../services/trendStoryCache';

const seededIds: string[] = [];
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
});

async function seedTrend(name: string, terms: string[]): Promise<void> {
  const [row] = await getDb()
    .insert(trending)
    .values({ type: 'entity', name, terms, score: 1, rank: 0, calculatedAt: new Date() })
    .returning({ id: trending.id });
  seededIds.push(row.id);
}

async function trendingSelectCount(): Promise<number> {
  let total = 0;
  for (const line of (await metrics.getPrometheusFormat()).split('\n')) {
    const match = /^db_query_duration_ms_count\{[^}]*table="trending"[^}]*\}\s+(\d+)/.exec(line);
    if (match) total += Number(match[1]);
  }
  return total;
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
