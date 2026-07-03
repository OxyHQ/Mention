import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit coverage for the analytics controller perf fixes (RANK 6):
 *   (a) getHashtagStats matches the indexed, normalized `hashtags` array and the
 *       real `stats.*Count` fields (not an unanchored `$regex` on a non-existent
 *       `text` field / `_count.*`);
 *   (b) updateAnalytics buckets the upsert `date` to the period start so repeated
 *       updates coalesce into one document per bucket instead of one per ms.
 *
 * The Mongo models are stubbed so the pipeline / upsert filter can be asserted
 * without a database.
 */

const mocks = vi.hoisted(() => ({
  postAggregate: vi.fn(),
  analyticsFindOneAndUpdate: vi.fn(),
}));

vi.mock('../../models/Post', () => ({ default: { aggregate: mocks.postAggregate } }));
vi.mock('../../models/Analytics', () => ({
  default: { findOneAndUpdate: mocks.analyticsFindOneAndUpdate },
}));

import { getHashtagStats, updateAnalytics } from '../../controllers/analytics.controller';

interface CapturedRes {
  statusCode: number;
  body: unknown;
  status: (c: number) => CapturedRes;
  json: (b: unknown) => CapturedRes;
}
function makeRes(): CapturedRes {
  const res: CapturedRes = {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('analytics.getHashtagStats', () => {
  it('matches the normalized hashtags array + createdAt, summing real stats fields', async () => {
    mocks.postAggregate.mockResolvedValue([]);
    const req = { params: { hashtag: '#TechNews' }, query: { period: 'weekly' } } as never;

    await getHashtagStats(req, makeRes() as never);

    const pipeline = mocks.postAggregate.mock.calls[0][0];
    const match = pipeline.find((s: Record<string, unknown>) => '$match' in s).$match;
    // Normalized tag (lowercase, '#' stripped) against the indexed array field.
    expect(match.hashtags).toBe('technews');
    // No unanchored regex on a non-existent `text` field, and the time bound is
    // on the real `createdAt` field.
    expect(match.text).toBeUndefined();
    expect(match.created_at).toBeUndefined();
    expect(match.createdAt).toHaveProperty('$gte');
    expect(match.createdAt).toHaveProperty('$lte');

    const group = pipeline.find((s: Record<string, unknown>) => '$group' in s).$group;
    expect(group.totalLikes).toEqual({ $sum: { $ifNull: ['$stats.likesCount', 0] } });
    expect(group.totalBoosts).toEqual({ $sum: { $ifNull: ['$stats.boostsCount', 0] } });
    expect(group.totalReplies).toEqual({ $sum: { $ifNull: ['$stats.commentsCount', 0] } });
  });
});

describe('analytics.updateAnalytics — period date bucketing', () => {
  it('buckets the upsert date to the start of each period', async () => {
    mocks.analyticsFindOneAndUpdate.mockResolvedValue({});
    const req = { body: { userID: 'u1', type: 'postViews', data: {} } } as never;

    await updateAnalytics(req, makeRes() as never);

    // One upsert per period.
    expect(mocks.analyticsFindOneAndUpdate).toHaveBeenCalledTimes(4);

    const byPeriod = new Map<string, Date>();
    for (const call of mocks.analyticsFindOneAndUpdate.mock.calls) {
      const filter = call[0] as { period: string; date: Date };
      byPeriod.set(filter.period, filter.date);
    }

    // Every bucket starts at midnight (no time-of-day component → coalesces).
    for (const date of byPeriod.values()) {
      expect(date.getHours()).toBe(0);
      expect(date.getMinutes()).toBe(0);
      expect(date.getSeconds()).toBe(0);
      expect(date.getMilliseconds()).toBe(0);
    }

    // Monthly bucket starts on the 1st; yearly on Jan 1st.
    expect(byPeriod.get('monthly')?.getDate()).toBe(1);
    expect(byPeriod.get('yearly')?.getMonth()).toBe(0);
    expect(byPeriod.get('yearly')?.getDate()).toBe(1);
    // Weekly bucket starts on a Monday.
    expect(byPeriod.get('weekly')?.getDay()).toBe(1);
  });
});
