import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the trending batch WRITE — the path that froze `GET /trending` on
 * one batch for over a day while answering HTTP 200 the whole time.
 *
 * Two independent defects met there:
 *
 *   1. Batch uniqueness was keyed on `{ name, calculatedAt }`, so a name trending
 *      as BOTH a hashtag and a classified topic (observed in production for
 *      `business`) was a duplicate that aborted the write. That collision is now
 *      impossible at the source rather than tolerated: hashtags and topics were
 *      merged into ONE term space, so a term is measured once and appears at most
 *      once per batch. The first test below pins THAT — the property the widened
 *      index used to protect.
 *
 *   2. The insert was ORDERED and its rejection propagated, so one bad row
 *      discarded every row after it AND skipped `TrendBatch.create` — and since
 *      `getTrending` derives its timestamp from `TrendBatch`, the endpoint went on
 *      serving the last complete batch forever. The insert is now unordered and
 *      the outcome is reported rather than swallowed. That defect is independent
 *      of what produced the rows, so its coverage is unchanged.
 */

const mocks = vi.hoisted(() => ({
  postAggregate: vi.fn(),
  postCountDocuments: vi.fn(),
  trendingInsertMany: vi.fn(),
  trendingFind: vi.fn(),
  trendingAggregate: vi.fn(),
  trendingDeleteMany: vi.fn(),
  trendBatchCreate: vi.fn(),
  trendBatchFindOne: vi.fn(),
  trendBatchDeleteMany: vi.fn(),
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

vi.mock('../../models/Trending', () => ({
  __esModule: true,
  default: {
    collection: {},
    insertMany: mocks.trendingInsertMany,
    find: mocks.trendingFind,
    findOne: vi.fn(),
    aggregate: mocks.trendingAggregate,
    deleteMany: mocks.trendingDeleteMany,
  },
  TrendingType: { HASHTAG: 'hashtag', TOPIC: 'topic', ENTITY: 'entity' },
  TRENDING_TTL_SECONDS: 90 * 24 * 60 * 60,
}));

vi.mock('../../models/TrendBatch', () => ({
  __esModule: true,
  default: {
    create: mocks.trendBatchCreate,
    findOne: mocks.trendBatchFindOne,
    deleteMany: mocks.trendBatchDeleteMany,
  },
}));

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
vi.mock('../../utils/socket', () => ({ emitTrendsUpdated: vi.fn() }));
vi.mock('../../utils/alia', () => ({ aliaChat: vi.fn(), aliaJSON: vi.fn(), isAliaEnabled: () => false }));
vi.mock('../../services/TopicService', () => ({
  topicService: {
    resolveNames: vi.fn().mockResolvedValue(new Map()),
    updatePopularityFromTrending: vi.fn().mockResolvedValue(undefined),
  },
}));

import { trendingService } from '../../services/TrendingService';
import { logger } from '../../utils/logger';
import { metrics } from '../../utils/metrics';

interface InsertedDoc {
  type: string;
  name: string;
  displayName: string;
  rank: number;
  volume: number;
  authorCount: number;
  startedAt: Date;
}

/** Stand-in for a Mongoose query chain ending in `.lean()`. */
function leanChain(value: unknown) {
  const chain = {
    sort: () => chain,
    limit: () => chain,
    select: () => chain,
    lean: () => Promise.resolve(value),
  };
  return chain;
}

/**
 * Drive the single candidate aggregation with four bursting terms — including
 * `business`, which arrives as BOTH a hashtag and a classified topic on the same
 * posts. That used to produce two colliding rows; it must now produce one.
 *
 * Every term's volume sits entirely in the recent window so all four clear the
 * burst floor; what is under test here is the WRITE, not the scoring.
 */
function stageBatch(): void {
  // Author counts are generous on purpose: these fixtures exercise the WRITE
  // path, so they must clear the concentration ceiling rather than being
  // refused by it (a term averaging more than a few posts per author is not a
  // conversation — that is `clearsFloors`' job and is covered in its own suite).
  mocks.postAggregate.mockResolvedValue([
    { _id: 'ai', volume: 40, recentVolume: 40, hashtagVolume: 40, topicVolume: 0, authorCount: 24, actorIds: ['u1'] },
    { _id: 'business', volume: 30, recentVolume: 30, hashtagVolume: 30, topicVolume: 30, authorCount: 18, actorIds: ['u2'] },
    { _id: 'politics', volume: 20, recentVolume: 20, hashtagVolume: 0, topicVolume: 20, authorCount: 12, actorIds: ['u3'] },
    { _id: 'kremer trade', volume: 12, recentVolume: 12, hashtagVolume: 0, topicVolume: 0, authorCount: 8, actorIds: ['u4'] },
  ]);
}

function insertedDocs(): InsertedDoc[] {
  return mocks.trendingInsertMany.mock.calls[0][0] as InsertedDoc[];
}

beforeEach(() => {
  vi.clearAllMocks();
  // A large corpus so the fixtures' volumes are a negligible SHARE of it: this
  // suite exercises the write path, and the vocabulary ceiling has its own.
  mocks.postCountDocuments.mockReturnValue({ maxTimeMS: () => Promise.resolve(100_000) });
  metrics.reset();
  // Every read path is a cache miss so the real queries run.
  mocks.redisGet.mockResolvedValue(null);
  mocks.redisSetEx.mockResolvedValue('OK');
  // `warmDefaultCache` re-enters getTrending after the write.
  mocks.trendBatchFindOne.mockReturnValue(leanChain({ calculatedAt: new Date(), summary: '' }));
  mocks.trendingFind.mockReturnValue(leanChain([]));
  mocks.trendingAggregate.mockResolvedValue([]);
  mocks.trendingDeleteMany.mockResolvedValue({ deletedCount: 0 });
  mocks.trendBatchDeleteMany.mockResolvedValue({ deletedCount: 0 });
  mocks.trendBatchCreate.mockResolvedValue({});
});

describe('TrendingService.calculateTrending — a name that is both a hashtag and a topic', () => {
  it('writes it ONCE and publishes the batch', async () => {
    stageBatch();
    mocks.trendingInsertMany.mockImplementation((docs: InsertedDoc[]) => Promise.resolve(docs));

    await trendingService.calculateTrending();

    const docs = insertedDocs();
    // `business` was written with a `#` on some posts and classified as a topic
    // on the same ones. That is one subject, so it is one row carrying the whole
    // count — not two rows splitting it, which is what used to collide.
    const business = docs.filter((doc) => doc.name === 'business');
    expect(business).toHaveLength(1);
    expect(business[0].volume).toBe(30);
    expect(docs).toHaveLength(4);
    expect(new Set(docs.map((doc) => doc.name)).size).toBe(docs.length);

    // The batch record is what `getTrending` reads its timestamp from. Before the
    // fix this was never reached, which is what froze the endpoint.
    expect(mocks.trendBatchCreate).toHaveBeenCalledOnce();
    expect(metrics.getCounter('trending_calculation_total', { result: 'success' })).toBe(1);
  });

  it('carries a human label and an onset on every row', async () => {
    stageBatch();
    mocks.trendingInsertMany.mockImplementation((docs: InsertedDoc[]) => Promise.resolve(docs));

    await trendingService.calculateTrending();

    for (const doc of insertedDocs()) {
      // Labelling is unconfigured in this suite, so every row gets the
      // deterministic label — which must still be present and presentable.
      expect(doc.displayName).toBeTruthy();
      expect(doc.displayName).not.toBe(doc.name);
      expect(doc.startedAt).toBeInstanceOf(Date);
      expect(doc.authorCount).toBeGreaterThan(0);
    }
  });

  it('inserts UNORDERED, so one rejected row cannot discard the rest', async () => {
    stageBatch();
    mocks.trendingInsertMany.mockImplementation((docs: InsertedDoc[]) => Promise.resolve(docs));

    await trendingService.calculateTrending();

    expect(mocks.trendingInsertMany).toHaveBeenCalledWith(expect.any(Array), { ordered: false });
  });
});

describe('TrendingService.calculateTrending — partial batch write', () => {
  /** What an unordered bulk write raises when it refuses individual documents. */
  function bulkWriteError(indexes: number[]): Error {
    const error = new Error('E11000 duplicate key error') as Error & {
      code: number;
      writeErrors: Array<{ index: number }>;
    };
    error.code = 11000;
    error.writeErrors = indexes.map((index) => ({ index }));
    return error;
  }

  it('still publishes the batch, and names the rejected rows at error level', async () => {
    stageBatch();
    // Reject one row. `docs` is score-sorted, so address it by position.
    mocks.trendingInsertMany.mockRejectedValue(bulkWriteError([1]));

    await trendingService.calculateTrending();

    expect(mocks.trendBatchCreate).toHaveBeenCalledOnce();
    expect(metrics.getCounter('trending_calculation_total', { result: 'partial' })).toBe(1);
    expect(metrics.getCounter('trending_calculation_total', { result: 'success' })).toBe(0);

    const report = vi
      .mocked(logger.error)
      .mock.calls.find(([message]) => message === '[Trending] Batch stored with rejected rows');
    expect(report).toBeDefined();
    const detail = report?.[1] as { inserted: number; expected: number; rejected: string[] };
    expect(detail.inserted).toBe(3);
    expect(detail.expected).toBe(4);
    expect(detail.rejected).toHaveLength(1);
    // The rejected row is named as `type:name`, not as an opaque index.
    expect(detail.rejected[0]).toMatch(/^(hashtag|topic|entity):/);
  });

  it('refuses to publish a batch the database accepted nothing from', async () => {
    stageBatch();
    mocks.trendingInsertMany.mockRejectedValue(bulkWriteError([0, 1, 2, 3]));

    await expect(trendingService.calculateTrending()).rejects.toThrow('inserted 0 of 4 rows');

    // Publishing here would point readers at rows that do not exist and blank the
    // widget; continuing to serve the previous batch is the better failure.
    expect(mocks.trendBatchCreate).not.toHaveBeenCalled();
    expect(metrics.getCounter('trending_calculation_total', { result: 'failure' })).toBe(1);
  });

  it('propagates an error that is not a per-document write report', async () => {
    stageBatch();
    mocks.trendingInsertMany.mockRejectedValue(new Error('connection closed'));

    await expect(trendingService.calculateTrending()).rejects.toThrow('connection closed');

    expect(mocks.trendBatchCreate).not.toHaveBeenCalled();
    expect(metrics.getCounter('trending_calculation_total', { result: 'failure' })).toBe(1);
  });
});

describe('TrendingService.getTrending — batch staleness is observable', () => {
  const THREE_CADENCES_MS = 3 * 30 * 60 * 1000;

  it('reports the age of the batch it serves', async () => {
    const calculatedAt = new Date(Date.now() - 10 * 60 * 1000);
    mocks.trendBatchFindOne.mockReturnValue(leanChain({ calculatedAt, summary: '' }));
    mocks.trendingFind.mockReturnValue(leanChain([]));

    await trendingService.getTrending(20);

    expect(metrics.getGauge('trending_batch_age_seconds')).toBeGreaterThanOrEqual(595);
    expect(metrics.getGauge('trending_batch_age_seconds')).toBeLessThanOrEqual(605);
  });

  it('logs at error level once the served batch outlives three cadences', async () => {
    const calculatedAt = new Date(Date.now() - THREE_CADENCES_MS - 60_000);
    mocks.trendBatchFindOne.mockReturnValue(leanChain({ calculatedAt, summary: '' }));
    mocks.trendingFind.mockReturnValue(leanChain([]));

    await trendingService.getTrending(20);

    expect(vi.mocked(logger.error).mock.calls.map(([message]) => message)).toContain(
      '[Trending] Serving a stale batch — recalculation is not landing',
    );
  });

  it('stays quiet for a fresh batch', async () => {
    mocks.trendBatchFindOne.mockReturnValue(leanChain({ calculatedAt: new Date(), summary: '' }));
    mocks.trendingFind.mockReturnValue(leanChain([]));

    await trendingService.getTrending(20);

    expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
  });
});

describe('TrendingService.getTrending — volume series are per TERM', () => {
  it('gives each term one continuous series', async () => {
    const calculatedAt = new Date();
    mocks.trendBatchFindOne.mockReturnValue(leanChain({ calculatedAt, summary: '' }));
    mocks.trendingFind.mockReturnValue(
      leanChain([
        { name: 'business', type: 'hashtag', score: 10, rank: 1, volume: 30 },
        { name: 'politics', type: 'entity', score: 9, rank: 2, volume: 4 },
      ]),
    );
    mocks.trendingAggregate.mockResolvedValue([
      { _id: 'business', volumes: [10, 20, 30, 40, 50, 60] },
      { _id: 'politics', volumes: [1, 2, 3, 4, 5, 6] },
    ]);

    const result = await trendingService.getTrending(20);

    const business = result.trending.find((trend) => trend.name === 'business');
    const politics = result.trending.find((trend) => trend.name === 'politics');
    expect(business?.series).toBeDefined();
    expect(politics?.series).toBeDefined();
    expect(business?.series).not.toEqual(politics?.series);
    expect(Math.max(...(business?.series ?? []))).toBeGreaterThan(
      Math.max(...(politics?.series ?? [])),
    );
  });

  it('groups the series by NAME alone, so a provenance flip cannot cut a history in two', async () => {
    const calculatedAt = new Date();
    mocks.trendBatchFindOne.mockReturnValue(leanChain({ calculatedAt, summary: '' }));
    mocks.trendingFind.mockReturnValue(
      leanChain([{ name: 'business', type: 'hashtag', score: 10, rank: 1, volume: 30 }]),
    );
    mocks.trendingAggregate.mockResolvedValue([]);

    await trendingService.getTrending(20);

    const pipeline = mocks.trendingAggregate.mock.calls[0][0];
    const sort = pipeline.find((stage: Record<string, unknown>) => '$sort' in stage).$sort;
    const group = pipeline.find((stage: Record<string, unknown>) => '$group' in stage).$group;
    // A prefix of the `{ name, calculatedAt, type }` unique index, so the planner
    // still streams straight into the group with no blocking SORT.
    expect(Object.entries(sort)).toEqual([
      ['name', 1],
      ['calculatedAt', 1],
    ]);
    expect(group._id).toBe('$name');
  });
});

describe('TrendingService.getTrendingHistory — a trend is a (name, type) pair there too', () => {
  it('collapses each day to one row per (name, type), not per name', async () => {
    mocks.trendingAggregate
      .mockResolvedValueOnce([{ _id: '2026-07-28' }])
      .mockResolvedValueOnce([{ date: '2026-07-28', trends: [] }]);

    await trendingService.getTrendingHistory(1, 10);

    const grouped = mocks.trendingAggregate.mock.calls[1][0];
    const dedupe = grouped.find(
      (stage: Record<string, unknown>) =>
        '$group' in stage &&
        '$first' in ((stage.$group as { doc?: Record<string, unknown> }).doc ?? {}),
    ).$group;
    // Keying the collapse on day and name alone would silently drop whichever of
    // the two scored lower when a name trended as both a hashtag and a topic.
    expect(dedupe._id).toEqual({ day: '$day', name: '$name', type: '$type' });
  });
});
