import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit coverage for {@link TrendingService}'s candidate aggregation — the ONE
 * pipeline that measures every term.
 *
 * The Post model, topic resolution, redis, sockets, and the AI summary are all
 * mocked so the suite is pure (no DB / network). What is asserted here is the
 * shape of the pipeline itself and the post-aggregation filtering:
 *   (a) sensitive posts are excluded at the `$match` (so their terms never
 *       count toward trending);
 *   (b) the term space is the UNION of extracted terms, hashtags and classified
 *       topic slugs — the property that stops trending being a hashtag ranking;
 *   (c) distinct authors are counted, and a null author cannot inflate them;
 *   (d) blocklisted NSFW terms are dropped even when they arrive from
 *       non-sensitive posts, while ordinary terms survive.
 */

const mocks = vi.hoisted(() => ({
  postAggregate: vi.fn(),
  postCountDocuments: vi.fn(),
  trendingAggregate: vi.fn(),
  redisGet: vi.fn(),
  redisSetEx: vi.fn(),
}));

vi.mock('../../models/Post', () => ({
  Post: {
    aggregate: mocks.postAggregate,
    // The corpus size behind the vocabulary ceiling; chained `.maxTimeMS()`.
    countDocuments: (...args: unknown[]) => mocks.postCountDocuments(...args),
  },
}));

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
vi.mock('../../utils/alia', () => ({ aliaChat: vi.fn(), aliaJSON: vi.fn(), isAliaEnabled: () => false }));
vi.mock('../../services/TopicService', () => ({
  topicService: { resolveNames: vi.fn().mockResolvedValue(new Map()), updatePopularityFromTrending: vi.fn() },
}));

import { trendingService } from '../../services/TrendingService';

// `aggregateTermCandidates` is private; reach it through a typed index signature
// rather than `as any` so the tests stay type-safe.
type PrivateTrending = {
  aggregateTermCandidates(now: Date): Promise<Array<{ measurement: { term: string; volume: number } }>>;
};
const svc = trendingService as unknown as PrivateTrending;

/** A row shaped exactly as the pipeline's final `$project` emits one. */
function row(term: string, volume: number) {
  return {
    _id: term,
    volume,
    recentVolume: volume,
    hashtagVolume: 0,
    topicVolume: 0,
    authorCount: 5,
    actorIds: ['a', 'b'],
  };
}

const stage = (pipeline: Array<Record<string, unknown>>, key: string) =>
  pipeline.find((entry) => key in entry) as Record<string, Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.postCountDocuments.mockReturnValue({ maxTimeMS: () => Promise.resolve(1_000) });
});

describe('aggregateTermCandidates — what is allowed to count', () => {
  it('excludes sensitive posts at the aggregation $match (all three flags)', async () => {
    mocks.postAggregate.mockResolvedValue([]);

    await svc.aggregateTermCandidates(new Date());

    const match = stage(mocks.postAggregate.mock.calls[0][0], '$match').$match;
    expect(match.status).toBe('published');
    expect(match.visibility).toBe('public');
    expect(match.boostOf).toEqual({ $exists: false });
    expect(match['postClassification.sensitive']).toEqual({ $ne: true });
    expect(match['metadata.isSensitive']).toEqual({ $ne: true });
    expect(match['federation.sensitive']).toEqual({ $ne: true });
    expect(match.createdAt).toHaveProperty('$gte');
  });

  it('drops blocklisted NSFW terms but keeps ordinary ones', async () => {
    // The aggregation already filtered out sensitive POSTS; these counts come
    // from non-sensitive ones. The blocklisted slugs must still be dropped.
    mocks.postAggregate.mockResolvedValue([
      row('technology', 50),
      row('nsfw', 999),
      row('sexy', 800),
      row('onlyfans', 700),
      row('art', 30),
    ]);

    const terms = (await svc.aggregateTermCandidates(new Date())).map((c) => c.measurement.term);

    expect(terms).toContain('technology');
    expect(terms).toContain('art');
    expect(terms).not.toContain('nsfw');
    expect(terms).not.toContain('sexy');
    expect(terms).not.toContain('onlyfans');
    expect(terms).toHaveLength(2);
  });
});

describe('aggregateTermCandidates — ONE term space', () => {
  it('unions extracted terms, hashtags and classified topic slugs', async () => {
    mocks.postAggregate.mockResolvedValue([]);

    await svc.aggregateTermCandidates(new Date());

    const addFields = stage(mocks.postAggregate.mock.calls[0][0], '$addFields').$addFields;
    expect(addFields._terms).toEqual({
      $setUnion: [
        { $ifNull: ['$postClassification.trendTerms', []] },
        { $ifNull: ['$hashtags', []] },
        { $ifNull: ['$postClassification.topics', []] },
      ],
    });
  });

  it('groups on the unified term, so a hashtag and the bare word are ONE candidate', async () => {
    mocks.postAggregate.mockResolvedValue([]);

    await svc.aggregateTermCandidates(new Date());

    const pipeline = mocks.postAggregate.mock.calls[0][0];
    expect(stage(pipeline, '$unwind').$unwind).toBe('$_terms');
    expect(stage(pipeline, '$group').$group._id).toBe('$_terms');
  });
});

describe('aggregateTermCandidates — authors are people, not posts', () => {
  it('collects DISTINCT authors rather than counting posts', async () => {
    mocks.postAggregate.mockResolvedValue([]);

    await svc.aggregateTermCandidates(new Date());

    const group = stage(mocks.postAggregate.mock.calls[0][0], '$group').$group;
    expect(group.authors).toEqual({ $addToSet: '$oxyUserId' });
  });

  it('filters null authors out before the count, so orphan posts cannot inflate it', async () => {
    mocks.postAggregate.mockResolvedValue([]);

    await svc.aggregateTermCandidates(new Date());

    const pipeline = mocks.postAggregate.mock.calls[0][0] as Array<Record<string, unknown>>;
    const filterStage = pipeline.find(
      (entry) => '$addFields' in entry && 'authors' in (entry.$addFields as Record<string, unknown>),
    ) as { $addFields: { authors: unknown } };
    expect(filterStage.$addFields.authors).toEqual({
      $filter: { input: '$authors', cond: { $ne: ['$$this', null] } },
    });

    // …and the count is taken from the FILTERED array, not the raw one.
    const project = pipeline.filter((entry) => '$project' in entry).at(-1) as {
      $project: Record<string, unknown>;
    };
    expect(project.$project.authorCount).toEqual({ $size: '$authors' });
  });
});

describe('aggregateTermCandidates — provenance is carried, not scored', () => {
  it('counts how often the term arrived as a hashtag and as a topic slug', async () => {
    mocks.postAggregate.mockResolvedValue([]);

    await svc.aggregateTermCandidates(new Date());

    const group = stage(mocks.postAggregate.mock.calls[0][0], '$group').$group;
    expect(group.hashtagVolume).toEqual({
      $sum: { $cond: [{ $in: ['$_terms', { $ifNull: ['$hashtags', []] }] }, 1, 0] },
    });
    expect(group.topicVolume).toEqual({
      $sum: {
        $cond: [{ $in: ['$_terms', { $ifNull: ['$postClassification.topics', []] }] }, 1, 0],
      },
    });
  });
});
