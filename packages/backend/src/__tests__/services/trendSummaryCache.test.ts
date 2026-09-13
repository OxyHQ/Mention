/**
 * `TrendingService.getTrendSummary` (backs `GET /trending/summary`) is a pure
 * read — no write, no counter, nothing a cache could short-circuit (verified
 * by reading its body) — now cached 30s per term via
 * `services/trending/trendSummaryCache.ts`.
 *
 * Same override as `trendStoryCache.test.ts`: the global test setup mocks
 * `utils/redis` with an always-`isReady: false` client, so this file replaces
 * it locally with a small working, Map-backed fake to actually observe the
 * cache hit/miss behaviour rather than a permanent no-op.
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
import { trendBatches, trending } from '../../db/schema/discovery';
import { metrics } from '../../utils/metrics';
import { trendingService } from '../../services/TrendingService';

const seededTrendingIds: string[] = [];
const seededBatchIds: string[] = [];
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
  const trendingIds = seededTrendingIds.splice(0);
  if (trendingIds.length > 0) {
    await getDb().delete(trending).where(inArray(trending.id, trendingIds));
  }
  const batchIds = seededBatchIds.splice(0);
  if (batchIds.length > 0) {
    await getDb().delete(trendBatches).where(inArray(trendBatches.id, batchIds));
  }
});

async function seedBatch(calculatedAt: Date): Promise<void> {
  const [batch] = await getDb()
    .insert(trendBatches)
    .values({ calculatedAt })
    .returning({ id: trendBatches.id });
  seededBatchIds.push(batch.id);
}

/** One `trending` row IN a batch already seeded via {@link seedBatch}. */
async function seedTrend(name: string, displayName: string, calculatedAt: Date): Promise<void> {
  const [row] = await getDb()
    .insert(trending)
    .values({
      type: 'entity',
      name,
      terms: [name],
      score: 1,
      rank: 0,
      calculatedAt,
      startedAt: calculatedAt,
      displayName,
      description: 'a deterministic description',
    })
    .returning({ id: trending.id });
  seededTrendingIds.push(row.id);
}

async function seedSummary(name: string, displayName: string, calculatedAt: Date): Promise<void> {
  await seedBatch(calculatedAt);
  await seedTrend(name, displayName, calculatedAt);
}

async function readStatementCount(): Promise<number> {
  let total = 0;
  for (const line of (await metrics.getPrometheusFormat()).split('\n')) {
    const match = /^db_query_duration_ms_count\{[^}]*table="(?:trending|trend_batches)"[^}]*\}\s+(\d+)/.exec(line);
    if (match) total += Number(match[1]);
  }
  return total;
}

describe('getTrendSummary caching', () => {
  it('reads the DB once for repeat lookups of the SAME term', async () => {
    const term = `summary-cache-alpha-${Date.now()}`;
    await seedSummary(term, 'Alpha Trend', new Date());

    metrics.reset();
    const first = await trendingService.getTrendSummary(term);
    const afterFirst = await readStatementCount();
    const second = await trendingService.getTrendSummary(term);
    const afterSecond = await readStatementCount();

    expect(first).toEqual({ displayName: 'Alpha Trend', description: 'a deterministic description' });
    expect(second).toEqual(first);
    expect(afterFirst).toBe(2); // trend_batches + trending, one each
    expect(afterSecond).toBe(2); // unchanged — the second call was a cache hit
  });

  it('never serves one term’s cached summary to another', async () => {
    // ONE batch, two terms in it — `getTrendSummary` resolves the LATEST batch
    // globally, then looks up `(name, thatBatch.calculatedAt)`, so termA and
    // termB have to share a batch to both count as "current".
    const now = new Date();
    await seedBatch(now);
    const termA = `summary-cache-bravo-${Date.now()}`;
    const termB = `summary-cache-charlie-${Date.now()}`;
    await seedTrend(termA, 'Bravo Trend', now);
    await seedTrend(termB, 'Charlie Trend', now);

    const summaryA = await trendingService.getTrendSummary(termA);
    const summaryB = await trendingService.getTrendSummary(termB);

    expect(summaryA.displayName).toBe('Bravo Trend');
    expect(summaryB.displayName).toBe('Charlie Trend');
  });

  it('caches the empty answer for a term with no current-batch row', async () => {
    const now = new Date();
    // A batch must exist (the function returns early with {} otherwise, before
    // ever reaching the per-term cache) — just no `trending` row for THIS term.
    const [batch] = await getDb().insert(trendBatches).values({ calculatedAt: now }).returning({ id: trendBatches.id });
    seededBatchIds.push(batch.id);
    const term = `summary-cache-unmatched-${Date.now()}`;

    metrics.reset();
    const first = await trendingService.getTrendSummary(term);
    const second = await trendingService.getTrendSummary(term);

    expect(first).toEqual({});
    expect(second).toEqual({});
    expect(await readStatementCount()).toBe(2); // one read of each table, once
  });
});
