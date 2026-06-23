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
import { BASELINE_CLASSIFIER_VERSION } from '../services/BaselineContentClassifier';

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

describe('FeedRankingService AI content-classification signals (P3a)', () => {
  /** Build a fully-classified post with explicit AI scores. */
  function classified(
    scores: Partial<{
      toxicity: number;
      constructiveness: number;
      spam: number;
      quality: number;
      controversy: number;
      negativity: number;
    }>,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return makePost({
      postClassification: {
        status: 'classified',
        topics: [],
        scores: {
          toxicity: 0,
          constructiveness: 0.5,
          spam: 0,
          quality: 0.5,
          controversy: 0,
          negativity: 0,
          ...scores,
        },
      },
      ...overrides,
    });
  }

  it('(a) SAFETY CASE — an UNSCORED post is scored NEUTRALLY (no penalty, no boost)', async () => {
    // The critical safety guarantee: a baseline/pending/failed/no-scores post must
    // be identical to a post with no classification at all. None of the AI signals
    // may fire.
    const unclassified = makePost();
    const pending = makePost({
      postClassification: { status: 'pending', topics: [] },
    });
    const baseline = makePost({
      postClassification: { status: 'baseline', topics: [], language: 'en' },
    });
    const failed = makePost({
      postClassification: { status: 'failed', topics: [] },
    });
    // A post carrying scores but NO provenance marker (not classified, and no
    // current baseline `version`) must still be neutral — the scores are the
    // schema-default placeholder, not real. This is the un-baselined / stale case.
    const scoresWithoutProvenance = makePost({
      postClassification: {
        status: 'baseline',
        topics: [],
        scores: { spam: 0.99, toxicity: 0.99, quality: 0.0 },
      },
    });

    const base = await scoreWith(unclassified, {});
    expect(await scoreWith(pending, {})).toBeCloseTo(base, 10);
    expect(await scoreWith(baseline, {})).toBeCloseTo(base, 10);
    expect(await scoreWith(failed, {})).toBeCloseTo(base, 10);
    // The high spam/toxicity scores are IGNORED because there is no provenance
    // marker (no `version`, not `classified`) — they're the default placeholder.
    expect(await scoreWith(scoresWithoutProvenance, {})).toBeCloseTo(base, 10);
  });

  it('(a) SAFETY CASE — a classified post with malformed/out-of-range scores is treated as NEUTRAL', async () => {
    const base = await scoreWith(makePost(), {});
    // out-of-range / non-finite values disqualify the whole scores object.
    const badRange = classified({ spam: 1.5, toxicity: -0.2, quality: 2 });
    const nan = classified({ spam: Number.NaN, quality: Number.NaN, toxicity: Number.NaN });
    expect(await scoreWith(badRange, {})).toBeCloseTo(base, 10);
    expect(await scoreWith(nan, {})).toBeCloseTo(base, 10);
  });

  it('(b) a classified HIGH-SPAM post is strongly downranked vs a neutral classified post', async () => {
    const { spamThreshold, highRiskPenalty } = MtnConfig.ranking.aiQuality.safety;
    const neutral = classified({ spam: 0, toxicity: 0, quality: 0.5 });
    const spammy = classified({ spam: spamThreshold, toxicity: 0, quality: 0.5 });

    const neutralScore = await scoreWith(neutral, {});
    const spammyScore = await scoreWith(spammy, {});

    expect(spammyScore).toBeLessThan(neutralScore);
    // Strong: the spam penalty multiplier is exactly the configured highRiskPenalty.
    expect(spammyScore / neutralScore).toBeCloseTo(highRiskPenalty, 5);
  });

  it('(b) a classified HIGH-TOXICITY post is strongly downranked vs a neutral classified post', async () => {
    const { toxicityThreshold, highRiskPenalty } = MtnConfig.ranking.aiQuality.safety;
    const neutral = classified({ spam: 0, toxicity: 0, quality: 0.5 });
    const toxic = classified({ spam: 0, toxicity: toxicityThreshold, quality: 0.5 });

    const neutralScore = await scoreWith(neutral, {});
    const toxicScore = await scoreWith(toxic, {});

    expect(toxicScore).toBeLessThan(neutralScore);
    expect(toxicScore / neutralScore).toBeCloseTo(highRiskPenalty, 5);
  });

  it('(c) a classified HIGH-QUALITY post is boosted above a LOW-QUALITY one', async () => {
    const { highThreshold, lowThreshold, highBoost, lowPenalty } = MtnConfig.ranking.aiQuality.quality;
    const high = classified({ quality: highThreshold, spam: 0, toxicity: 0 });
    const low = classified({ quality: lowThreshold, spam: 0, toxicity: 0 });

    const highScore = await scoreWith(high, {});
    const lowScore = await scoreWith(low, {});

    expect(highScore).toBeGreaterThan(lowScore);
    // The ONLY differing factor is the AI quality multiplier, so the ratio equals
    // highBoost / lowPenalty.
    expect(highScore / lowScore).toBeCloseTo(highBoost / lowPenalty, 5);
  });

  it('(c) AI quality REPLACES the engagement-rate heuristic when classified', async () => {
    // A post with strong engagement-rate "quality" but a LOW AI quality score is
    // downranked — the AI signal overrides the noisy engagement ratio.
    const minViews = MtnConfig.ranking.quality.minViewsForRate;
    const strongEngagement = {
      likesCount: minViews,
      boostsCount: minViews,
      commentsCount: 0,
      viewsCount: minViews,
    };
    const aiLowDespiteEngagement = classified(
      { quality: MtnConfig.ranking.aiQuality.quality.lowThreshold },
      { stats: { ...strongEngagement } },
    );
    const unclassifiedSameEngagement = makePost({ stats: { ...strongEngagement } });

    const aiScore = await scoreWith(aiLowDespiteEngagement, {});
    const engagementScore = await scoreWith(unclassifiedSameEngagement, {});
    expect(aiScore).toBeLessThan(engagementScore);
  });

  it('(d) thresholds & multipliers come from MtnConfig.ranking.aiQuality (no magic numbers)', () => {
    const ai = MtnConfig.ranking.aiQuality;
    expect(ai.safety.spamThreshold).toBeGreaterThan(0);
    expect(ai.safety.spamThreshold).toBeLessThanOrEqual(1);
    expect(ai.safety.toxicityThreshold).toBeGreaterThan(0);
    expect(ai.safety.toxicityThreshold).toBeLessThanOrEqual(1);
    expect(ai.safety.highRiskPenalty).toBeGreaterThan(0);
    expect(ai.safety.highRiskPenalty).toBeLessThan(1);
    expect(ai.quality.highThreshold).toBeGreaterThan(ai.quality.lowThreshold);
    expect(ai.quality.highBoost).toBeGreaterThan(1);
    expect(ai.quality.lowPenalty).toBeLessThan(1);
    expect(ai.quality.lowPenalty).toBeGreaterThan(0);
  });
});

describe('FeedRankingService sensitive/NSFW hard exclusion (belt-and-suspenders)', () => {
  it('zeroes the score of a classifier-flagged sensitive post', async () => {
    const sensitive = makePost({ postClassification: { status: 'baseline', topics: [], sensitive: true } });
    expect(await scoreWith(sensitive, {})).toBe(0);
  });

  it('zeroes the score of a metadata.isSensitive post', async () => {
    const sensitive = makePost({ metadata: { isSensitive: true } });
    expect(await scoreWith(sensitive, {})).toBe(0);
  });

  it('zeroes the score of a federation.sensitive post', async () => {
    const sensitive = makePost({ federation: { sensitive: true } });
    expect(await scoreWith(sensitive, {})).toBe(0);
  });

  it('zeroes the score of an NSFW-hashtag post even without any sensitive flag', async () => {
    const nsfw = makePost({ hashtags: ['nsfw'] });
    expect(await scoreWith(nsfw, {})).toBe(0);
  });

  it('is NEUTRAL for a clean post — normal ranking is unchanged', async () => {
    // A clean post keeps a positive score (the exclusion must not fire).
    const clean = makePost({ hashtags: ['tech'] });
    expect(await scoreWith(clean, {})).toBeGreaterThan(0);
  });

  it('excludes sensitive posts from a ranked batch via rankPosts (score 0)', async () => {
    // Both posts carry identical real engagement so a positive base score exists;
    // the ONLY differentiator is the NSFW hashtag, which must zero the score.
    const stats = { likesCount: 10, boostsCount: 5, commentsCount: 3, viewsCount: 100 };
    const clean = makePost({ _id: 'clean-1', oxyUserId: 'a', hashtags: ['tech'], stats: { ...stats } });
    const nsfw = makePost({ _id: 'nsfw-1', oxyUserId: 'b', hashtags: ['NSFW'], stats: { ...stats } });
    const ranked = await service.rankPosts([clean, nsfw], undefined, {});
    const byId = new Map(ranked.map((p: Record<string, unknown>) => [String(p._id), p.finalScore as number]));
    expect(byId.get('nsfw-1')).toBe(0);
    expect(byId.get('clean-1') ?? 0).toBeGreaterThan(0);
  });
});

describe('FeedRankingService sensitive/NSFW exclusion is VIEWER-CONDITIONAL (showSensitiveContent)', () => {
  it('does NOT zero a classifier-flagged sensitive post when the viewer opted in', async () => {
    const sensitive = makePost({ postClassification: { status: 'baseline', topics: [], sensitive: true } });
    expect(await scoreWith(sensitive, { showSensitiveContent: true })).toBeGreaterThan(0);
  });

  it('does NOT zero a metadata.isSensitive post when the viewer opted in', async () => {
    const sensitive = makePost({ metadata: { isSensitive: true } });
    expect(await scoreWith(sensitive, { showSensitiveContent: true })).toBeGreaterThan(0);
  });

  it('does NOT zero a federation.sensitive post when the viewer opted in', async () => {
    const sensitive = makePost({ federation: { sensitive: true } });
    expect(await scoreWith(sensitive, { showSensitiveContent: true })).toBeGreaterThan(0);
  });

  it('does NOT zero an NSFW-hashtag post when the viewer opted in', async () => {
    const nsfw = makePost({ hashtags: ['nsfw'] });
    expect(await scoreWith(nsfw, { showSensitiveContent: true })).toBeGreaterThan(0);
  });

  it('STILL zeroes a sensitive post when showSensitiveContent is explicitly false', async () => {
    const nsfw = makePost({ hashtags: ['nsfw'] });
    expect(await scoreWith(nsfw, { showSensitiveContent: false })).toBe(0);
  });

  it('STILL zeroes a sensitive post when showSensitiveContent is omitted (default SFW)', async () => {
    const nsfw = makePost({ hashtags: ['nsfw'] });
    expect(await scoreWith(nsfw, {})).toBe(0);
  });

  it('ranks a sensitive post normally in a batch when the viewer opted in (score > 0)', async () => {
    // userId is `undefined` to keep the batch on the pure compute path (a real
    // userId would lazy-load following/behavior from the server singleton); the
    // sensitive zeroing depends on showSensitiveContent, not on userId.
    const stats = { likesCount: 10, boostsCount: 5, commentsCount: 3, viewsCount: 100 };
    const clean = makePost({ _id: 'clean-1', oxyUserId: 'a', hashtags: ['tech'], stats: { ...stats } });
    const nsfw = makePost({ _id: 'nsfw-1', oxyUserId: 'b', hashtags: ['NSFW'], stats: { ...stats } });
    const ranked = await service.rankPosts([clean, nsfw], undefined, { showSensitiveContent: true });
    const byId = new Map(ranked.map((p: Record<string, unknown>) => [String(p._id), p.finalScore as number]));
    expect(byId.get('nsfw-1') ?? 0).toBeGreaterThan(0);
    expect(byId.get('clean-1') ?? 0).toBeGreaterThan(0);
  });
});

describe('FeedRankingService deterministic-baseline scores (P3d) — honored via the version marker', () => {
  /** A non-classified (pending) post carrying deterministic-baseline scores at the current version. */
  function baselineScored(
    scores: { spam: number; toxicity: number; quality: number },
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return makePost({
      postClassification: {
        status: 'pending',
        topics: [],
        version: BASELINE_CLASSIFIER_VERSION,
        scores: { ...scores, constructiveness: 0, controversy: 0, negativity: 0 },
      },
      ...overrides,
    });
  }

  it('honors a BASELINE high-spam post (no AI) and strongly downranks it', async () => {
    const { spamThreshold, highRiskPenalty } = MtnConfig.ranking.aiQuality.safety;
    const neutral = baselineScored({ spam: 0, toxicity: 0, quality: 0.5 });
    const spammy = baselineScored({ spam: spamThreshold, toxicity: 0, quality: 0.5 });

    const neutralScore = await scoreWith(neutral, {});
    const spammyScore = await scoreWith(spammy, {});

    expect(spammyScore).toBeLessThan(neutralScore);
    expect(spammyScore / neutralScore).toBeCloseTo(highRiskPenalty, 5);
  });

  it('honors a BASELINE high-toxicity post (no AI) and strongly downranks it', async () => {
    const { toxicityThreshold, highRiskPenalty } = MtnConfig.ranking.aiQuality.safety;
    const neutral = baselineScored({ spam: 0, toxicity: 0, quality: 0.5 });
    const toxic = baselineScored({ spam: 0, toxicity: toxicityThreshold, quality: 0.5 });

    const neutralScore = await scoreWith(neutral, {});
    const toxicScore = await scoreWith(toxic, {});

    expect(toxicScore).toBeLessThan(neutralScore);
    expect(toxicScore / neutralScore).toBeCloseTo(highRiskPenalty, 5);
  });

  it('honors a BASELINE quality signal (no AI): high quality outranks low quality', async () => {
    const { highThreshold, lowThreshold, highBoost, lowPenalty } = MtnConfig.ranking.aiQuality.quality;
    const high = baselineScored({ quality: highThreshold, spam: 0, toxicity: 0 });
    const low = baselineScored({ quality: lowThreshold, spam: 0, toxicity: 0 });

    const highScore = await scoreWith(high, {});
    const lowScore = await scoreWith(low, {});

    expect(highScore).toBeGreaterThan(lowScore);
    expect(highScore / lowScore).toBeCloseTo(highBoost / lowPenalty, 5);
  });

  it('is NEUTRAL when scores carry an OLD baseline version (stale placeholder)', async () => {
    const base = await scoreWith(makePost(), {});
    const stale = makePost({
      postClassification: {
        status: 'pending',
        topics: [],
        version: BASELINE_CLASSIFIER_VERSION - 1, // older ruleset → not honored
        scores: { spam: 0.99, toxicity: 0.99, quality: 0, constructiveness: 0, controversy: 0, negativity: 0 },
      },
    });
    expect(await scoreWith(stale, {})).toBeCloseTo(base, 10);
  });

  it('still honors an AI-classified post even without a baseline version', async () => {
    const { spamThreshold, highRiskPenalty } = MtnConfig.ranking.aiQuality.safety;
    const base = await scoreWith(makePost(), {});
    const classifiedSpam = makePost({
      postClassification: {
        status: 'classified',
        topics: [],
        scores: { spam: spamThreshold, toxicity: 0, quality: 0.5, constructiveness: 0, controversy: 0, negativity: 0 },
      },
    });
    expect(await scoreWith(classifiedSpam, {})).toBeCloseTo(base * highRiskPenalty, 5);
  });
});

describe('FeedRankingService canonical topics (postClassification.topicRefs → topics) — prefer / fallback / neutral', () => {
  const VIEWER = 'viewer-1';

  /** behaviorSets with one preferred topicId and one hidden topic name. */
  function behaviorSets(): NonNullable<Parameters<FeedRankingService['calculatePostScore']>[2]>['behaviorSets'] {
    return {
      hiddenAuthors: new Set<string>(),
      mutedAuthors: new Set<string>(),
      blockedAuthors: new Set<string>(),
      hiddenTopics: new Set<string>(['politics']),
      preferredTopicIds: new Set<string>(['topic-basketball']),
    };
  }

  /** Score a post AS the viewer with a userBehavior that has a preferred topic. */
  async function scoreAsViewer(post: Record<string, unknown>): Promise<number> {
    const engagementScoreCache = new Map<string, number>([[String(post._id), 1]]);
    return service.calculatePostScore(post, VIEWER, {
      userBehavior: {
        // preferredTopics drives the personalization topic-match gate; the actual
        // id match is via behaviorSets.preferredTopicIds.
        preferredTopics: [{ topic: 'basketball', weight: 0.9, topicId: 'topic-basketball' }],
      },
      behaviorSets: behaviorSets(),
      engagementScoreCache,
    });
  }

  it('PERSONALIZATION — boosts a post whose topicRefs carry a preferred topicId', async () => {
    const matched = makePost({
      postClassification: { status: 'baseline', topics: ['basketball'], topicRefs: [{ name: 'basketball', topicId: 'topic-basketball' }] },
    });
    const unmatched = makePost({
      postClassification: { status: 'baseline', topics: ['cooking'], topicRefs: [{ name: 'cooking', topicId: 'topic-cooking' }] },
    });
    expect(await scoreAsViewer(matched)).toBeGreaterThan(await scoreAsViewer(unmatched));
  });

  it('PERSONALIZATION — slug-only postClassification.topics carry no topicId, so they do not trigger the topicId boost', async () => {
    // The slug fallback yields `{ name }` only — no `topicId` — so topicId-based
    // personalization is a documented graceful no-op for slug-only posts. A post
    // whose slug name equals the preferred topic gets NO topicId boost.
    const slugOnly = makePost({
      postClassification: { status: 'baseline', topics: ['basketball'] },
    });
    const noTopics = makePost({ postClassification: { status: 'baseline', topics: [] } });
    expect(await scoreAsViewer(slugOnly)).toBeCloseTo(await scoreAsViewer(noTopics), 10);
  });

  it('PERSONALIZATION — PREFERS topicRefs over the slug list for the topicId match', async () => {
    // topicRefs carries the preferred id and must drive the match. The same post
    // also has a non-matching slug list, proving topicRefs is the source used.
    const prefersRefs = makePost({
      postClassification: { status: 'classified', topics: ['cooking'], topicRefs: [{ name: 'basketball', topicId: 'topic-basketball' }] },
    });
    const unmatched = makePost({
      postClassification: { status: 'classified', topics: ['basketball'], topicRefs: [{ name: 'cooking', topicId: 'topic-cooking' }] },
    });
    expect(await scoreAsViewer(prefersRefs)).toBeGreaterThan(await scoreAsViewer(unmatched));
  });

  it('PERSONALIZATION — NEUTRAL when neither topicRefs nor postClassification.topics is present', async () => {
    const noTopics = makePost({ postClassification: { status: 'baseline', topics: [] } });
    const noClassification = makePost();
    // Both topic-less → identical personalization (no topic-match boost either way).
    expect(await scoreAsViewer(noTopics)).toBeCloseTo(await scoreAsViewer(noClassification), 10);
  });

  it('HIDDEN-TOPIC — suppresses a post whose topicRefs name is hidden', async () => {
    const hidden = makePost({
      postClassification: { status: 'baseline', topics: ['politics'], topicRefs: [{ name: 'politics' }] },
    });
    const visible = makePost({
      postClassification: { status: 'baseline', topics: ['basketball'], topicRefs: [{ name: 'basketball', topicId: 'topic-basketball' }] },
    });
    expect(await scoreAsViewer(hidden)).toBeLessThan(await scoreAsViewer(visible));
  });

  it('HIDDEN-TOPIC — FALLS BACK to the slug-only postClassification.topics name when topicRefs is absent', async () => {
    const hiddenViaSlug = makePost({
      postClassification: { status: 'baseline', topics: ['politics'] },
    });
    const visibleViaSlug = makePost({
      postClassification: { status: 'baseline', topics: ['basketball'] },
    });
    expect(await scoreAsViewer(hiddenViaSlug)).toBeLessThan(await scoreAsViewer(visibleViaSlug));
  });

  it('HIDDEN-TOPIC — NEUTRAL when a topic-less post cannot be matched against hidden topics', async () => {
    // A post with neither source must NOT be suppressed by hidden-topic logic.
    const topicLess = makePost({ postClassification: { status: 'baseline', topics: [] } });
    const visible = makePost({
      postClassification: { status: 'baseline', topics: ['basketball'], topicRefs: [{ name: 'basketball', topicId: 'topic-basketball' }] },
    });
    // topicLess gets no topic-match boost AND no hidden penalty; visible gets the
    // basketball preference boost, so visible should score higher — but crucially
    // topicLess is NOT pushed below an unranked baseline (no suppression).
    const topicLessScore = await scoreAsViewer(topicLess);
    const baseline = await scoreAsViewer(makePost());
    expect(topicLessScore).toBeCloseTo(baseline, 10);
    expect(await scoreAsViewer(visible)).toBeGreaterThan(topicLessScore);
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
