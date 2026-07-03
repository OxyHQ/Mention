import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit coverage for {@link TrendingService} NSFW/sensitive exclusion.
 *
 * The Post model, topic resolution, redis, sockets, and the AI summary are all
 * mocked so the suite is pure (no DB / network). We drive the two aggregation
 * methods (`aggregateHashtags`, `aggregateTopics`) and assert:
 *   (a) sensitive posts are excluded at the aggregation `$match` (so their
 *       hashtags/topics never count toward trending);
 *   (b) blocklisted NSFW hashtags/topics are dropped from the results even when
 *       returned from non-sensitive posts;
 *   (c) ordinary hashtags/topics still trend.
 */

const mocks = vi.hoisted(() => ({
  postAggregate: vi.fn(),
  trendingAggregate: vi.fn(),
  redisGet: vi.fn(),
  redisSetEx: vi.fn(),
}));

vi.mock('../../models/Post', () => ({ Post: { aggregate: mocks.postAggregate } }));

// Trending pulls in a handful of side-effecting collaborators we don't exercise
// here; stub them so the singleton imports cleanly and the methods stay pure.
vi.mock('../../models/Trending', () => ({
  __esModule: true,
  default: { collection: {}, insertMany: vi.fn(), find: vi.fn(), findOne: vi.fn(), aggregate: mocks.trendingAggregate, deleteMany: vi.fn() },
  TrendingType: { HASHTAG: 'hashtag', TOPIC: 'topic', ENTITY: 'entity' },
  TRENDING_TTL_SECONDS: 90 * 24 * 60 * 60,
}));

// Override the global setup's Redis stub with a ready client whose get/setEx we
// can drive, so the history cache read/write path is exercised directly.
vi.mock('../../utils/redis', () => ({
  getRedisClient: () => ({
    isReady: true,
    get: mocks.redisGet,
    setEx: mocks.redisSetEx,
    set: vi.fn(),
    del: vi.fn(),
    keys: vi.fn().mockResolvedValue([]),
  }),
}));
vi.mock('../../models/TrendBatch', () => ({ __esModule: true, default: { create: vi.fn(), findOne: vi.fn(), deleteMany: vi.fn() } }));
vi.mock('../../utils/socket', () => ({ emitTrendsUpdated: vi.fn() }));
vi.mock('../../utils/alia', () => ({ aliaChat: vi.fn(), isAliaEnabled: () => false }));
vi.mock('../../services/TopicService', () => ({
  topicService: { resolveNames: vi.fn().mockResolvedValue(new Map()), updatePopularityFromTrending: vi.fn() },
}));

import { trendingService } from '../../services/TrendingService';

// `aggregateHashtags` / `aggregateTopics` are private; reach them through a typed
// index signature rather than `as any` so the tests stay type-safe.
type PrivateTrending = {
  aggregateHashtags(): Promise<Array<{ name: string; volume: number }>>;
  aggregateTopics(): Promise<Array<{ name: string; volume: number }>>;
};
const svc = trendingService as unknown as PrivateTrending;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TrendingService.aggregateHashtags — NSFW/sensitive exclusion', () => {
  it('excludes sensitive posts at the aggregation $match (all three flags)', async () => {
    mocks.postAggregate.mockResolvedValue([]);

    await svc.aggregateHashtags();

    const pipeline = mocks.postAggregate.mock.calls[0][0];
    const match = pipeline.find((stage: Record<string, unknown>) => '$match' in stage).$match;
    expect(match.status).toBe('published');
    expect(match.visibility).toBe('public');
    expect(match.boostOf).toEqual({ $exists: false });
    expect(match['postClassification.sensitive']).toEqual({ $ne: true });
    expect(match['metadata.isSensitive']).toEqual({ $ne: true });
    expect(match['federation.sensitive']).toEqual({ $ne: true });
  });

  it('drops blocklisted NSFW hashtags but keeps normal hashtags trending', async () => {
    // Aggregation already filtered out sensitive posts; these counts come from
    // non-sensitive posts. NSFW slugs must still be dropped post-aggregation.
    mocks.postAggregate.mockResolvedValue([
      { _id: 'technology', count24h: 50, count6h: 20 },
      { _id: 'NSFW', count24h: 999, count6h: 500 },
      { _id: 'Sexy', count24h: 800, count6h: 400 },
      { _id: 'onlyfans', count24h: 700, count6h: 300 },
      { _id: 'art', count24h: 30, count6h: 10 },
    ]);

    const result = await svc.aggregateHashtags();
    const names = result.map(t => t.name);

    expect(names).toContain('technology');
    expect(names).toContain('art');
    expect(names).not.toContain('nsfw');
    expect(names).not.toContain('sexy');
    expect(names).not.toContain('onlyfans');
    // Only the two clean hashtags survive.
    expect(result).toHaveLength(2);
  });
});

describe('TrendingService.aggregateTopics — NSFW/sensitive exclusion', () => {
  it('excludes sensitive posts at the aggregation $match', async () => {
    mocks.postAggregate.mockResolvedValue([]);

    await svc.aggregateTopics();

    const pipeline = mocks.postAggregate.mock.calls[0][0];
    const matchStages = pipeline.filter((stage: Record<string, unknown>) => '$match' in stage);
    const firstMatch = matchStages[0].$match;
    expect(firstMatch.status).toBe('published');
    expect(firstMatch.visibility).toBe('public');
    expect(firstMatch.boostOf).toEqual({ $exists: false });
    expect(firstMatch['postClassification.sensitive']).toEqual({ $ne: true });
    expect(firstMatch['metadata.isSensitive']).toEqual({ $ne: true });
    expect(firstMatch['federation.sensitive']).toEqual({ $ne: true });
  });

  it('drops blocklisted NSFW topics but keeps normal topics trending', async () => {
    mocks.postAggregate.mockResolvedValue([
      { _id: { name: 'tech', type: 'topic' }, totalRelevance: 10, postCount: 5, recentCount: 3 },
      { _id: { name: 'porn', type: 'topic' }, totalRelevance: 99, postCount: 50, recentCount: 30 },
      { _id: { name: 'hentai', type: 'topic' }, totalRelevance: 80, postCount: 40, recentCount: 20 },
      { _id: { name: 'science', type: 'topic' }, totalRelevance: 8, postCount: 4, recentCount: 2 },
    ]);

    const result = await svc.aggregateTopics();
    const names = result.map(t => t.name);

    expect(names).toContain('tech');
    expect(names).toContain('science');
    expect(names).not.toContain('porn');
    expect(names).not.toContain('hentai');
    expect(result).toHaveLength(2);
  });
});

describe('TrendingService.aggregateTopics — canonical topicRefs source with slug-topics fallback', () => {
  it('prefers postClassification.topicRefs and falls back to postClassification.topics per post', async () => {
    mocks.postAggregate.mockResolvedValue([]);

    await svc.aggregateTopics();

    const pipeline = mocks.postAggregate.mock.calls[0][0];

    // The match requires at least one of the two topic sources to be present.
    const firstMatch = pipeline.find((s: Record<string, unknown>) => '$match' in s).$match;
    expect(firstMatch.$or).toEqual([
      { 'postClassification.topicRefs': { $exists: true, $ne: [] } },
      { 'postClassification.topics': { $exists: true, $ne: [] } },
    ]);
    // The window is keyed on the post createdAt (shared time basis for both sources).
    expect(firstMatch.createdAt).toHaveProperty('$gte');

    // An $addFields stage computes the unified `_topicSource`: topicRefs when
    // non-empty, else the slug-only `postClassification.topics` mapped to `{ name }`.
    const addFields = pipeline.find((s: Record<string, unknown>) => '$addFields' in s).$addFields;
    expect(addFields._topicSource.$cond[1]).toBe('$postClassification.topicRefs');
    expect(addFields._topicSource.$cond[2]).toEqual({
      $map: {
        input: { $ifNull: ['$postClassification.topics', []] },
        as: 'name',
        in: { name: '$$name' },
      },
    });

    // The unwind + group read the unified source, defaulting absent type/relevance.
    const unwind = pipeline.find((s: Record<string, unknown>) => '$unwind' in s).$unwind;
    expect(unwind).toBe('$_topicSource');
    const group = pipeline.find((s: Record<string, unknown>) => '$group' in s).$group;
    expect(group._id.name).toBe('$_topicSource.name');
    expect(group._id.type).toEqual({ $ifNull: ['$_topicSource.type', 'topic'] });
    // Slug-only refs (no relevance) contribute the neutral default relevance.
    expect(group.totalRelevance.$sum.$ifNull[0]).toBe('$_topicSource.relevance');
    expect(typeof group.totalRelevance.$sum.$ifNull[1]).toBe('number');
  });
});

describe('TrendingService.getTrendingHistory — windowed aggregation', () => {
  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

  it('matches calculatedAt >= (now - 90d) as the FIRST stage of BOTH aggregations', async () => {
    mocks.redisGet.mockResolvedValue(null); // force a cache miss so it aggregates
    mocks.trendingAggregate
      .mockResolvedValueOnce([{ _id: '2026-07-01' }]) // distinct days
      .mockResolvedValueOnce([{ date: '2026-07-01', trends: [] }]); // grouped

    await trendingService.getTrendingHistory(1, 10);

    // Distinct-days pipeline: leading $match on calculatedAt.
    const daysPipeline = mocks.trendingAggregate.mock.calls[0][0];
    expect('$match' in daysPipeline[0]).toBe(true);
    expect(daysPipeline[0].$match.calculatedAt).toHaveProperty('$gte');
    const daysCutoff = daysPipeline[0].$match.calculatedAt.$gte as Date;
    expect(daysCutoff).toBeInstanceOf(Date);
    expect(Math.abs(daysCutoff.getTime() - (Date.now() - NINETY_DAYS_MS))).toBeLessThan(5000);

    // Grouped pipeline: leading $match on calculatedAt BEFORE the $addFields day derivation.
    const groupedPipeline = mocks.trendingAggregate.mock.calls[1][0];
    expect('$match' in groupedPipeline[0]).toBe(true);
    expect(groupedPipeline[0].$match.calculatedAt).toHaveProperty('$gte');
    expect('$addFields' in groupedPipeline[1]).toBe(true);
  });
});

describe('TrendingService.getTrendingHistory — Redis caching', () => {
  it('returns the cached payload on a hit and never runs an aggregation', async () => {
    const cached = { days: [{ date: '2026-07-01', trends: [] }], page: 1, totalPages: 1 };
    mocks.redisGet.mockResolvedValue(JSON.stringify(cached));

    const result = await trendingService.getTrendingHistory(1, 10);

    expect(result).toEqual(cached);
    expect(mocks.trendingAggregate).not.toHaveBeenCalled();
    expect(mocks.redisSetEx).not.toHaveBeenCalled();
  });

  it('writes the computed history to cache (key page:limit, ~5m TTL) on a miss', async () => {
    mocks.redisGet.mockResolvedValue(null);
    mocks.trendingAggregate
      .mockResolvedValueOnce([{ _id: '2026-07-01' }])
      .mockResolvedValueOnce([{ date: '2026-07-01', trends: [] }]);

    await trendingService.getTrendingHistory(1, 5);

    expect(mocks.redisSetEx).toHaveBeenCalledTimes(1);
    const [key, ttl] = mocks.redisSetEx.mock.calls[0];
    expect(key).toBe('trending:history:1:5');
    expect(ttl).toBe(300);
  });

  it('does not throw when the cache read fails (fail-soft) and still aggregates', async () => {
    mocks.redisGet.mockRejectedValue(new Error('redis down'));
    mocks.trendingAggregate
      .mockResolvedValueOnce([{ _id: '2026-07-01' }])
      .mockResolvedValueOnce([{ date: '2026-07-01', trends: [] }]);

    const result = await trendingService.getTrendingHistory(1, 10);

    expect(result.days).toHaveLength(1);
    expect(mocks.trendingAggregate).toHaveBeenCalledTimes(2);
  });
});
