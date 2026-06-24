import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MtnConfig } from '@mention/shared-types';

/**
 * Tests for `ExploreFeed.fetch` proving the discovery sensitive/NSFW exclusion is
 * VIEWER-CONDITIONAL on `context.showSensitiveContent`.
 *
 * Explore scores inline in its aggregation pipeline (it does NOT pass through
 * `FeedRankingService`), so its only sensitivity gate is the query-level
 * `DISCOVERY_SAFE_MATCH`. We mock `Post.aggregate` and capture the pipeline to
 * assert that `$match` carries (SFW) or omits (opted-in) the exclusion clauses.
 */

const aggregateMock = vi.fn();
const findOneMock = vi.fn();
const hydrateSlicesMock = vi.fn();
const sliceFeedMock = vi.fn();

// Capture every aggregate pipeline so the $match stage can be asserted.
const aggregatePipelines: unknown[][] = [];

vi.mock('../models/Post', () => ({
  Post: {
    aggregate: vi.fn((pipeline: unknown[]) => {
      aggregatePipelines.push(pipeline);
      return { option: () => aggregateMock() };
    }),
    findOne: vi.fn(() => ({
      select: () => ({ sort: () => ({ lean: () => findOneMock() }) }),
    })),
  },
}));

vi.mock('../services/PostHydrationService', () => ({
  postHydrationService: {
    hydratePosts: vi.fn(),
    hydrateSlices: () => hydrateSlicesMock(),
  },
}));

vi.mock('../services/ThreadSlicingService', () => ({
  threadSlicingService: { sliceFeed: (...args: unknown[]) => sliceFeedMock(...args) },
}));

import { ExploreFeed } from '../mtn/feed/feeds/ExploreFeed';

const oid = (n: number) => new mongoose.Types.ObjectId(`5f${n.toString().padStart(22, '0')}`);

beforeEach(() => {
  vi.clearAllMocks();
  aggregatePipelines.length = 0;
  aggregateMock.mockResolvedValue([]);
  sliceFeedMock.mockResolvedValue({ slices: [] });
  hydrateSlicesMock.mockResolvedValue([]);
});

/** Pull the FIRST `$match` stage from the captured aggregate pipeline. */
function firstMatch(): Record<string, unknown> {
  expect(aggregatePipelines.length).toBeGreaterThan(0);
  const pipeline = aggregatePipelines[aggregatePipelines.length - 1] as Array<Record<string, unknown>>;
  const matchStage = pipeline.find((stage) => '$match' in stage);
  expect(matchStage).toBeDefined();
  return (matchStage as { $match: Record<string, unknown> }).$match;
}

/**
 * Pull the `relevanceBoost` expression from the captured aggregate pipeline (the
 * `$addFields` stage the logged-in relevance boost injects). Returns the literal
 * value (e.g. `1` for the neutral / anonymous path) or the relevance expression
 * object for a viewer with signals.
 */
function relevanceBoostExpr(): unknown {
  const pipeline = aggregatePipelines[aggregatePipelines.length - 1] as Array<Record<string, unknown>>;
  const stage = pipeline.find(
    (s) => '$addFields' in s && 'relevanceBoost' in (s.$addFields as Record<string, unknown>),
  );
  expect(stage).toBeDefined();
  return (stage as { $addFields: { relevanceBoost: unknown } }).$addFields.relevanceBoost;
}

describe('ExploreFeed.fetch — SFW (default / anonymous)', () => {
  it('excludes sensitive/NSFW at the query level for an anonymous viewer', async () => {
    const feed = new ExploreFeed();
    await feed.fetch({ cursor: undefined, limit: 30 }, { currentUserId: undefined, followingIds: [] });

    const match = firstMatch();
    expect(match['postClassification.sensitive']).toEqual({ $ne: true });
    expect(match['metadata.isSensitive']).toEqual({ $ne: true });
    expect(match['federation.sensitive']).toEqual({ $ne: true });
    const hashtags = match.hashtags as { $nin?: string[] };
    expect(Array.isArray(hashtags?.$nin)).toBe(true);
    expect(hashtags.$nin).toContain('nsfw');
  });

  it('excludes sensitive/NSFW when showSensitiveContent is explicitly false', async () => {
    const feed = new ExploreFeed();
    await feed.fetch(
      { cursor: undefined, limit: 30 },
      { currentUserId: 'viewer', followingIds: [], showSensitiveContent: false },
    );

    const match = firstMatch();
    expect(match['postClassification.sensitive']).toEqual({ $ne: true });
    expect((match.hashtags as { $nin: string[] }).$nin).toContain('nsfw');
  });
});

describe('ExploreFeed.fetch — viewer opted in (showSensitiveContent)', () => {
  it('does NOT exclude sensitive/NSFW at the query level when the viewer opted in', async () => {
    const feed = new ExploreFeed();
    await feed.fetch(
      { cursor: undefined, limit: 30 },
      { currentUserId: 'viewer', followingIds: [], showSensitiveContent: true },
    );

    const match = firstMatch();
    expect(match['postClassification.sensitive']).toBeUndefined();
    expect(match['metadata.isSensitive']).toBeUndefined();
    expect(match['federation.sensitive']).toBeUndefined();
    expect(match.hashtags).toBeUndefined();
    // The non-safety constraints remain.
    expect(match.visibility).toBe('public');
    expect(match.status).toBe('published');
  });

  it('returns the aggregate results (sensitive included) when the viewer opted in', async () => {
    aggregateMock.mockResolvedValue([
      { _id: oid(1), oxyUserId: 'a', hashtags: ['nsfw'] },
    ]);
    sliceFeedMock.mockResolvedValue({
      slices: [{ items: [{ post: { id: oid(1).toString() } }] }],
    });
    hydrateSlicesMock.mockResolvedValue([
      { items: [{ post: { id: oid(1).toString() } }] },
    ]);

    const feed = new ExploreFeed();
    const res = await feed.fetch(
      { cursor: undefined, limit: 30 },
      { currentUserId: 'viewer', followingIds: [], showSensitiveContent: true },
    );

    // The pipeline did not filter the sensitive post, and it flowed through to slices.
    expect(res.slices.length).toBe(1);
  });
});

/**
 * RELEVANCE BOOST (logged-in viewers). Explore folds a bounded relevance
 * multiplier (`relevanceBoost`) into its ranking aggregation when the viewer has
 * learned signals — preferred topics / language / region. We capture the
 * `$addFields: { relevanceBoost }` expression and assert it is NEUTRAL (`1`) for
 * anonymous / no-signal viewers and a CLAMPED PRODUCT of the configured weights
 * when the viewer carries signals. It is a soft lift (never a filter), so the
 * `$match` stage is unchanged regardless.
 */
describe('ExploreFeed.fetch — relevance boost (logged-in)', () => {
  it('uses a NEUTRAL relevance multiplier (1) for an anonymous viewer', async () => {
    const feed = new ExploreFeed();
    await feed.fetch({ cursor: undefined, limit: 30 }, { currentUserId: undefined, followingIds: [] });

    expect(relevanceBoostExpr()).toBe(1);
  });

  it('uses a NEUTRAL relevance multiplier (1) for a logged-in viewer with NO learned signals', async () => {
    const feed = new ExploreFeed();
    await feed.fetch(
      { cursor: undefined, limit: 30 },
      { currentUserId: 'viewer', followingIds: [], userBehavior: { preferredTopics: [], preferredLanguages: [] } },
    );

    expect(relevanceBoostExpr()).toBe(1);
  });

  it('builds a clamped TOPIC-match multiplier when the viewer has preferred topics', async () => {
    const feed = new ExploreFeed();
    await feed.fetch(
      { cursor: undefined, limit: 30 },
      {
        currentUserId: 'viewer',
        followingIds: [],
        userBehavior: { preferredTopics: [{ topic: 'tech', weight: 5 }], preferredLanguages: [] },
      },
    );

    const expr = relevanceBoostExpr() as { $min: [unknown, unknown] };
    // Clamped to maxBoost.
    expect(expr.$min[0]).toEqual({ $literal: MtnConfig.ranking.exploreRelevance.maxBoost });
    // A single matched dimension → the factor itself (no $multiply wrapper).
    const product = expr.$min[1] as { $cond: [unknown, number, number] };
    expect(product.$cond[1]).toBe(MtnConfig.ranking.exploreRelevance.topicMatch);
    expect(product.$cond[2]).toBe(1);
    // The topic slug is lowercased and matched against the projected topics.
    const cond = product.$cond[0] as { $gt: [{ $size: { $setIntersection: [unknown, string[]] } }, number] };
    expect(cond.$gt[0].$size.$setIntersection[1]).toContain('tech');
  });

  it('builds the language factor as ANY-overlap over the multikey languages[]', async () => {
    const feed = new ExploreFeed();
    await feed.fetch(
      { cursor: undefined, limit: 30 },
      {
        currentUserId: 'viewer',
        followingIds: [],
        // Language-only signal → the relevance product is the single language factor.
        userBehavior: { preferredTopics: [], preferredLanguages: ['es'] },
      },
    );

    const expr = relevanceBoostExpr() as {
      $min: [
        unknown,
        {
          $cond: [
            { $gt: [{ $size: { $setIntersection: [{ $ifNull: [string, unknown[]] }, string[]] } }, number] },
            number,
            number,
          ];
        },
      ];
    };
    const cond = expr.$min[1].$cond;
    // Boost weight when matched, neutral 1.0 otherwise.
    expect(cond[1]).toBe(MtnConfig.ranking.exploreRelevance.languageMatch);
    expect(cond[2]).toBe(1);
    // Viewer's preferred languages are the intersection target.
    const setIntersection = cond[0].$gt[0].$size.$setIntersection;
    expect(setIntersection[1]).toContain('es');
    // The post-side operand reads the multikey `postClassification.languages`
    // array directly (no scalar fallback / $let — the single field is gone).
    expect(setIntersection[0]).toEqual({ $ifNull: ['$postClassification.languages', []] });
  });

  it('combines topic + language + region factors into one clamped product', async () => {
    const feed = new ExploreFeed();
    await feed.fetch(
      { cursor: undefined, limit: 30 },
      {
        currentUserId: 'viewer',
        followingIds: [],
        userBehavior: { preferredTopics: [{ topic: 'tech', weight: 5 }], preferredLanguages: ['es'] },
        viewerRegion: 'ES',
      },
    );

    const expr = relevanceBoostExpr() as { $min: [unknown, { $multiply: unknown[] }] };
    expect(expr.$min[0]).toEqual({ $literal: MtnConfig.ranking.exploreRelevance.maxBoost });
    // Three matched dimensions → a $multiply of three $cond factors.
    expect(Array.isArray(expr.$min[1].$multiply)).toBe(true);
    expect(expr.$min[1].$multiply).toHaveLength(3);
  });

  it('does NOT change the $match stage — relevance is a boost, not a filter (SFW intact)', async () => {
    const feed = new ExploreFeed();
    await feed.fetch(
      { cursor: undefined, limit: 30 },
      {
        currentUserId: 'viewer',
        followingIds: [],
        userBehavior: { preferredTopics: [{ topic: 'tech', weight: 5 }], preferredLanguages: ['es'] },
        viewerRegion: 'ES',
      },
    );

    const match = firstMatch();
    // No topic/language/region constraint leaked into the match (still discovery).
    expect(match['postClassification.topics']).toBeUndefined();
    expect(match['postClassification.languages']).toBeUndefined();
    expect(match['postClassification.region']).toBeUndefined();
    // SFW exclusion still present (viewer did not opt in to sensitive content).
    expect(match['postClassification.sensitive']).toEqual({ $ne: true });
  });

  it('only counts topics above the discovery weight floor is NOT applied — all preferred topics with non-empty slug are used', async () => {
    // The relevance boost uses ALL preferred-topic slugs (sorted by weight,
    // capped), unlike ranking's >0.3 floor — Explore is a coarse discovery lift.
    const feed = new ExploreFeed();
    await feed.fetch(
      { cursor: undefined, limit: 30 },
      {
        currentUserId: 'viewer',
        followingIds: [],
        userBehavior: { preferredTopics: [{ topic: 'TechNews', weight: 0.1 }], preferredLanguages: [] },
      },
    );

    const expr = relevanceBoostExpr() as { $min: [unknown, { $cond: [{ $gt: [{ $size: { $setIntersection: [unknown, string[]] } }, number] }, number, number] }] };
    expect(expr.$min[1].$cond[0].$gt[0].$size.$setIntersection[1]).toContain('technews');
  });
});
