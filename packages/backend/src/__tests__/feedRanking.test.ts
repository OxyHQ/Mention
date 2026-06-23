import { describe, it, expect, vi } from 'vitest';
import { MtnConfig } from '@mention/shared-types';

// Redis is unavailable in unit tests. Return a client whose connect() rejects
// with a recognized connection error so `withRedisFallback` degrades to its
// fallback (no cache) instead of throwing on the stub's missing methods. This
// keeps `rankPosts`' engagement-score cache path on the compute branch.
vi.mock('../utils/redis', () => ({
  getRedisClient: vi.fn().mockReturnValue({
    isReady: false,
    isOpen: false,
    connect: vi.fn().mockRejectedValue(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })),
    ping: vi.fn().mockRejectedValue(new Error('not connected')),
    get: vi.fn(),
    set: vi.fn(),
    setEx: vi.fn(),
    del: vi.fn(),
  }),
}));

import { FeedRankingService } from '../services/FeedRankingService';

/**
 * Unit tests for the ranking signals added/recalibrated in the feed overhaul:
 *  - the author-authority multiplier (`calculateAuthorityScore`), and
 *  - the recalibrated quality/diversity behavior surfaced through the public
 *    `calculatePostScore` (the quality method is private, so it's exercised via
 *    the score it produces).
 *
 * These are PURE-ish: Redis is mocked to an unready stub by the global test
 * setup, and every `calculatePostScore` call supplies a pre-populated
 * `engagementScoreCache` so no Redis path is touched.
 */

const service = new FeedRankingService();

/** A minimal lean-Post-like object sufficient for the scoring code paths. */
function makePost(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: 'post-1',
    oxyUserId: 'author-1',
    createdAt: new Date(), // very recent → recency ~1.0
    type: 'text',
    hashtags: [],
    stats: { likesCount: 0, boostsCount: 0, commentsCount: 0, viewsCount: 0 },
    metadata: {},
    ...overrides,
  };
}

/** Score a post with the engagement base pinned to 1 so other factors are visible. */
async function scoreWith(
  post: Record<string, unknown>,
  context: Parameters<FeedRankingService['calculatePostScore']>[2] = {},
): Promise<number> {
  const engagementScoreCache = new Map<string, number>([[String(post._id), 1]]);
  return service.calculatePostScore(post, undefined, { ...context, engagementScoreCache });
}

describe('FeedRankingService.calculateAuthorityScore', () => {
  it('is neutral (1.0) when the follower count is unknown', () => {
    expect(service.calculateAuthorityScore(undefined)).toBe(1.0);
  });

  it('is neutral (1.0) for negative / non-finite follower counts (never crashes)', () => {
    expect(service.calculateAuthorityScore(-5)).toBe(1.0);
    expect(service.calculateAuthorityScore(Number.NaN)).toBe(1.0);
    expect(service.calculateAuthorityScore(Number.POSITIVE_INFINITY)).toBe(1.0);
  });

  it('gives a small creator a value at/near the floor (no domination)', () => {
    const { min, max } = MtnConfig.ranking.authority;
    const small = service.calculateAuthorityScore(0);
    expect(small).toBeGreaterThanOrEqual(min);
    expect(small).toBeLessThanOrEqual(max);
    // A zero-follower author: 1 + k*log1p(0) = 1, clamped up to the floor.
    expect(small).toBeCloseTo(Math.max(min, 1), 5);
  });

  it('increases monotonically with follower count', () => {
    const a = service.calculateAuthorityScore(10);
    const b = service.calculateAuthorityScore(1_000);
    const c = service.calculateAuthorityScore(1_000_000);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThanOrEqual(c);
  });

  it('clamps a huge account to the configured ceiling', () => {
    const { max } = MtnConfig.ranking.authority;
    expect(service.calculateAuthorityScore(1_000_000_000)).toBeCloseTo(max, 5);
  });

  it('keeps the gap between a small and a large creator MODEST (popularity floor philosophy)', () => {
    const small = service.calculateAuthorityScore(50);
    const large = service.calculateAuthorityScore(500_000);
    // Big accounts get a lift, but bounded well under 2x — not a takeover.
    expect(large / small).toBeLessThan(1.6);
  });
});

describe('FeedRankingService authority signal in calculatePostScore', () => {
  it('lifts a post whose author has many followers above an unknown-author post', async () => {
    const post = makePost();
    const authorFollowerCounts = new Map<string, number>([['author-1', 500_000]]);

    const withAuthority = await scoreWith(post, { authorFollowerCounts });
    const withoutAuthority = await scoreWith(post, { authorFollowerCounts: new Map() });

    expect(withAuthority).toBeGreaterThan(withoutAuthority);
  });

  it('does not penalize a post whose author follower count is missing', async () => {
    const post = makePost();
    // No authorFollowerCounts → authority multiplier is exactly 1.0 (neutral).
    const neutral = await scoreWith(post, {});
    const explicitEmpty = await scoreWith(post, { authorFollowerCounts: new Map() });
    expect(neutral).toBeCloseTo(explicitEmpty, 5);
  });
});

describe('FeedRankingService recalibrated quality behavior', () => {
  it('does NOT promote a post with a tiny view count to high quality (robust low-view rate)', async () => {
    // 2 views, 1 like → naive rate 0.5 would historically score "high quality".
    // Below minViewsForRate the rate is untrusted → neutral quality.
    const lowViews = makePost({
      stats: { likesCount: 1, boostsCount: 0, commentsCount: 0, viewsCount: 2 },
    });
    const neutralViews = makePost({
      stats: { likesCount: 0, boostsCount: 0, commentsCount: 0, viewsCount: 2 },
    });
    expect(MtnConfig.ranking.quality.minViewsForRate).toBeGreaterThan(2);

    const lowViewsScore = await scoreWith(lowViews, {});
    const neutralViewsScore = await scoreWith(neutralViews, {});
    // With both under the view threshold, quality is neutral for both, so the
    // tiny-denominator post is NOT artificially boosted over the bare post.
    expect(lowViewsScore).toBeCloseTo(neutralViewsScore, 5);
  });

  it('rewards a genuinely high engagement-rate post once it has enough views', async () => {
    const minViews = MtnConfig.ranking.quality.minViewsForRate;
    const highRate = makePost({
      stats: { likesCount: minViews, boostsCount: minViews, commentsCount: 0, viewsCount: minViews },
    });
    const lowRate = makePost({
      stats: { likesCount: 0, boostsCount: 0, commentsCount: 0, viewsCount: minViews * 100 },
    });

    const highRateScore = await scoreWith(highRate, {});
    const lowRateScore = await scoreWith(lowRate, {});
    expect(highRateScore).toBeGreaterThan(lowRateScore);
  });

  it('penalizes a low engagement-rate post only once it crosses the (lowered) view gate', async () => {
    const gate = MtnConfig.ranking.quality.lowEngagementMinViews;
    // Well above the gate, with near-zero engagement → low-quality penalty applies.
    const manyViewsNoEngagement = makePost({
      stats: { likesCount: 0, boostsCount: 0, commentsCount: 0, viewsCount: gate * 10 },
    });
    // A bare post with no views at all stays neutral.
    const noViews = makePost({
      stats: { likesCount: 0, boostsCount: 0, commentsCount: 0, viewsCount: 0 },
    });

    const penalizedScore = await scoreWith(manyViewsNoEngagement, {});
    const neutralScore = await scoreWith(noViews, {});
    expect(penalizedScore).toBeLessThan(neutralScore);
  });
});

describe('FeedRankingService recalibrated diversity penalties', () => {
  it('uses the strengthened same-author / same-topic penalties from config', () => {
    // Guard the recalibration itself: these are the values the ranking reads.
    expect(MtnConfig.ranking.diversity.sameAuthorPenalty).toBe(0.85);
    expect(MtnConfig.ranking.diversity.sameTopicPenalty).toBe(0.80);
  });

  it('applies the same-author diversity penalty to a repeated author in a session', async () => {
    // rankPosts applies diversity sequentially: the FIRST post by an author is
    // unpenalized; the SECOND post by the SAME author is multiplied by the
    // (strengthened) sameAuthorPenalty. We assert that effect directly on the
    // attached finalScore, which is robust to tie-break ordering.
    const now = new Date();
    // Identical, non-zero engagement so the multiplicative base score is > 0 and
    // the ONLY difference between the two is the same-author diversity penalty.
    const stats = { likesCount: 10, boostsCount: 0, commentsCount: 0, viewsCount: 0 };
    const first = makePost({ _id: 'a1', oxyUserId: 'author-A', createdAt: now, stats: { ...stats } });
    const second = makePost({ _id: 'a2', oxyUserId: 'author-A', createdAt: now, stats: { ...stats } });

    const ranked = await service.rankPosts([first, second], undefined, {
      authorFollowerCounts: new Map(),
    });

    const byId = new Map(ranked.map((p: Record<string, unknown>) => [String(p._id), p]));
    const firstScore = byId.get('a1')?.finalScore as number;
    const secondScore = byId.get('a2')?.finalScore as number;

    expect(firstScore).toBeGreaterThan(0);
    // The repeated author's post is penalized → strictly lower than the first.
    expect(secondScore).toBeLessThan(firstScore);
    // And by approximately the configured same-author penalty factor.
    expect(secondScore / firstScore).toBeCloseTo(MtnConfig.ranking.diversity.sameAuthorPenalty, 5);
  });
});
