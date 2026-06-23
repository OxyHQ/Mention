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
}));

vi.mock('../../models/Post', () => ({ Post: { aggregate: mocks.postAggregate } }));

// Trending pulls in a handful of side-effecting collaborators we don't exercise
// here; stub them so the singleton imports cleanly and the methods stay pure.
vi.mock('../../models/Trending', () => ({
  __esModule: true,
  default: { collection: {}, insertMany: vi.fn(), find: vi.fn(), findOne: vi.fn(), aggregate: vi.fn(), deleteMany: vi.fn() },
  TrendingType: { HASHTAG: 'hashtag', TOPIC: 'topic', ENTITY: 'entity' },
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
