import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postAggregate: vi.fn(),
  getRedisClient: vi.fn(),
  hGetAll: vi.fn(),
  hSet: vi.fn(),
  pushInterests: vi.fn(),
}));

vi.mock('../../models/Post', () => ({ Post: { aggregate: mocks.postAggregate } }));

vi.mock('../../utils/redis', () => ({ getRedisClient: mocks.getRedisClient }));

import { InterestScoreService } from '../../services/InterestScoreService';

const signalsClient = { pushInterests: mocks.pushInterests, pushEndorsements: vi.fn() };

function makeService() {
  return new InterestScoreService(signalsClient as unknown as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Redis disabled by default → no last-pushed history (every score is a delta).
  mocks.getRedisClient.mockReturnValue({ isReady: false, hGetAll: mocks.hGetAll, hSet: mocks.hSet });
  mocks.pushInterests.mockResolvedValue(undefined);
});

describe('InterestScoreService.aggregateAuthors', () => {
  it('builds the aggregation summing all five engagement counters and returns parsed rows', async () => {
    const now = 1_000_000_000_000;
    mocks.postAggregate.mockResolvedValue([
      { _id: 'author_1', raw: 42, postCount: 3, lastPost: new Date(now) },
    ]);

    const service = makeService();
    const result = await service.aggregateAuthors(now);

    // Verify the $group sums the five stats fields.
    const pipeline = mocks.postAggregate.mock.calls[0][0];
    const group = pipeline.find((stage: Record<string, unknown>) => '$group' in stage).$group;
    const addOperands = group.raw.$sum.$add;
    expect(addOperands).toHaveLength(5);
    // Excludes boosts and restricts to published/public in the $match.
    const match = pipeline.find((stage: Record<string, unknown>) => '$match' in stage).$match;
    expect(match.status).toBe('published');
    expect(match.visibility).toBe('public');
    expect(match.type).toEqual({ $ne: 'boost' });

    expect(result).toEqual([
      { oxyUserId: 'author_1', raw: 42, postCount: 3, lastPostMs: now },
    ]);
  });
});

describe('InterestScoreService.computeScore', () => {
  it('produces a normalized score in [0, 1]', () => {
    const service = makeService();
    const now = 2_000_000_000_000;
    const score = service.computeScore({ oxyUserId: 'a', raw: 100, postCount: 5, lastPostMs: now }, now);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('returns 0 for an author with no posts', () => {
    const service = makeService();
    expect(service.computeScore({ oxyUserId: 'a', raw: 0, postCount: 0, lastPostMs: Date.now() })).toBe(0);
  });

  it('decays the score for older activity', () => {
    const service = makeService();
    const now = 3_000_000_000_000;
    const fresh = service.computeScore({ oxyUserId: 'a', raw: 100, postCount: 5, lastPostMs: now }, now);
    const stale = service.computeScore(
      { oxyUserId: 'a', raw: 100, postCount: 5, lastPostMs: now - 60 * 24 * 60 * 60 * 1000 },
      now,
    );
    expect(stale).toBeLessThan(fresh);
  });
});

describe('InterestScoreService.run', () => {
  it('pushes a score for every author when there is no last-pushed history', async () => {
    const now = 4_000_000_000_000;
    mocks.postAggregate.mockResolvedValue([
      { _id: 'a1', raw: 50, postCount: 4, lastPost: new Date(now) },
      { _id: 'a2', raw: 10, postCount: 2, lastPost: new Date(now) },
    ]);

    const service = makeService();
    const result = await service.run(now);

    expect(result.scored).toBe(2);
    expect(result.pushed).toBe(2);
    const pushed = mocks.pushInterests.mock.calls[0][0];
    expect(pushed.map((s: { userId: string }) => s.userId).sort()).toEqual(['a1', 'a2']);
    for (const s of pushed) {
      expect(s.interestScore).toBeGreaterThanOrEqual(0);
      expect(s.interestScore).toBeLessThanOrEqual(1);
    }
  });

  it('pushes ONLY deltas that exceed epsilon vs. the last-pushed score', async () => {
    const now = 5_000_000_000_000;
    mocks.postAggregate.mockResolvedValue([
      { _id: 'a1', raw: 50, postCount: 4, lastPost: new Date(now) },
      { _id: 'a2', raw: 10, postCount: 2, lastPost: new Date(now) },
    ]);
    // Compute the would-be score for a1 to seed it as already-pushed (no delta).
    const probe = makeService();
    const a1Score = probe.computeScore({ oxyUserId: 'a1', raw: 50, postCount: 4, lastPostMs: now }, now);

    mocks.getRedisClient.mockReturnValue({
      isReady: true,
      hGetAll: mocks.hGetAll,
      hSet: mocks.hSet,
    });
    mocks.hGetAll.mockResolvedValue({ a1: String(a1Score) });
    mocks.hSet.mockResolvedValue(1);

    const service = makeService();
    const result = await service.run(now);

    expect(result.scored).toBe(2);
    expect(result.pushed).toBe(1); // only a2 moved
    expect(mocks.pushInterests.mock.calls[0][0].map((s: { userId: string }) => s.userId)).toEqual(['a2']);
  });

  it('pushes nothing when there are no authors', async () => {
    mocks.postAggregate.mockResolvedValue([]);
    const service = makeService();
    const result = await service.run();
    expect(result).toEqual({ scored: 0, pushed: 0 });
    expect(mocks.pushInterests).not.toHaveBeenCalled();
  });
});
