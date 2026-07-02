import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MtnConfig } from '@mention/shared-types';

/**
 * Tests for the `explore` SOURCE module (which wraps the former ExploreFeed
 * aggregation) proving the discovery sensitive/NSFW exclusion is
 * VIEWER-CONDITIONAL on `ctx.showSensitiveContent` and that the logged-in
 * relevance boost is built (and injection-guarded) correctly.
 *
 * Explore scores inline in its aggregation pipeline (it does NOT pass through
 * `FeedRankingService`), so its only sensitivity gate is the query-level
 * `DISCOVERY_SAFE_MATCH`. We mock `Post.aggregate` and capture the pipeline to
 * assert that `$match` carries (SFW) or omits (opted-in) the exclusion clauses.
 */

const aggregateMock = vi.fn();
const aggregatePipelines: unknown[][] = [];

vi.mock('../models/Post', () => ({
  Post: {
    aggregate: vi.fn((pipeline: unknown[]) => {
      aggregatePipelines.push(pipeline);
      return { option: () => aggregateMock() };
    }),
  },
}));

import { exploreSource } from '../mtn/feed/engine/sources/discoverySources';
import type { FeedEngineContext } from '../mtn/feed/engine/types';

const oid = (n: number) => new mongoose.Types.ObjectId(`5f${n.toString().padStart(22, '0')}`);
const CAP = 90;

function gather(ctx: FeedEngineContext) {
  return exploreSource.gather({ ...ctx, pageLimit: 30 }, {}, CAP);
}

beforeEach(() => {
  vi.clearAllMocks();
  aggregatePipelines.length = 0;
  aggregateMock.mockResolvedValue([]);
});

function firstMatch(): Record<string, unknown> {
  expect(aggregatePipelines.length).toBeGreaterThan(0);
  const pipeline = aggregatePipelines[aggregatePipelines.length - 1] as Array<Record<string, unknown>>;
  const matchStage = pipeline.find((stage) => '$match' in stage);
  expect(matchStage).toBeDefined();
  return (matchStage as { $match: Record<string, unknown> }).$match;
}

function relevanceBoostExpr(): unknown {
  const pipeline = aggregatePipelines[aggregatePipelines.length - 1] as Array<Record<string, unknown>>;
  const stage = pipeline.find(
    (s) => '$addFields' in s && 'relevanceBoost' in (s.$addFields as Record<string, unknown>),
  );
  expect(stage).toBeDefined();
  return (stage as { $addFields: { relevanceBoost: unknown } }).$addFields.relevanceBoost;
}

describe('explore source — SFW (default / anonymous)', () => {
  it('excludes sensitive/NSFW at the query level for an anonymous viewer', async () => {
    await gather({ currentUserId: undefined, followingIds: [] });
    const match = firstMatch();
    expect(match['postClassification.sensitive']).toEqual({ $ne: true });
    expect(match['metadata.isSensitive']).toEqual({ $ne: true });
    expect(match['federation.sensitive']).toEqual({ $ne: true });
    const hashtags = match.hashtags as { $nin?: string[] };
    expect(Array.isArray(hashtags?.$nin)).toBe(true);
    expect(hashtags.$nin).toContain('nsfw');
  });

  it('excludes sensitive/NSFW when showSensitiveContent is explicitly false', async () => {
    await gather({ currentUserId: 'viewer', followingIds: [], showSensitiveContent: false });
    const match = firstMatch();
    expect(match['postClassification.sensitive']).toEqual({ $ne: true });
    expect((match.hashtags as { $nin: string[] }).$nin).toContain('nsfw');
  });
});

describe('explore source — viewer opted in (showSensitiveContent)', () => {
  it('does NOT exclude sensitive/NSFW at the query level when the viewer opted in', async () => {
    await gather({ currentUserId: 'viewer', followingIds: [], showSensitiveContent: true });
    const match = firstMatch();
    expect(match['postClassification.sensitive']).toBeUndefined();
    expect(match['metadata.isSensitive']).toBeUndefined();
    expect(match['federation.sensitive']).toBeUndefined();
    expect(match.hashtags).toBeUndefined();
    expect(match.visibility).toBe('public');
    expect(match.status).toBe('published');
  });

  it('returns the aggregate results (sensitive included) when the viewer opted in', async () => {
    aggregateMock.mockResolvedValue([{ _id: oid(1), oxyUserId: 'a', hashtags: ['nsfw'] }]);
    const posts = await gather({ currentUserId: 'viewer', followingIds: [], showSensitiveContent: true });
    expect(posts.map((p) => String(p._id))).toEqual([oid(1).toString()]);
  });
});

describe('explore source — relevance boost (logged-in)', () => {
  it('uses a NEUTRAL relevance multiplier (1) for an anonymous viewer', async () => {
    await gather({ currentUserId: undefined, followingIds: [] });
    expect(relevanceBoostExpr()).toBe(1);
  });

  it('uses a NEUTRAL relevance multiplier (1) for a logged-in viewer with NO learned signals', async () => {
    await gather({ currentUserId: 'viewer', followingIds: [], userBehavior: { preferredTopics: [], preferredLanguages: [] } });
    expect(relevanceBoostExpr()).toBe(1);
  });

  it('builds a clamped TOPIC-match multiplier when the viewer has preferred topics', async () => {
    await gather({
      currentUserId: 'viewer',
      followingIds: [],
      userBehavior: { preferredTopics: [{ topic: 'tech', weight: 5 }], preferredLanguages: [] },
    });

    const expr = relevanceBoostExpr() as { $min: [unknown, unknown] };
    expect(expr.$min[0]).toEqual({ $literal: MtnConfig.ranking.exploreRelevance.maxBoost });
    const product = expr.$min[1] as { $cond: [unknown, number, number] };
    expect(product.$cond[1]).toBe(MtnConfig.ranking.exploreRelevance.topicMatch);
    expect(product.$cond[2]).toBe(1);
    const cond = product.$cond[0] as { $gt: [{ $size: { $setIntersection: [unknown, { $literal: string[] }] } }, number] };
    expect(cond.$gt[0].$size.$setIntersection[1]).toEqual({ $literal: ['tech'] });
  });

  it('builds the language factor as ANY-overlap over the multikey languages[]', async () => {
    await gather({
      currentUserId: 'viewer',
      followingIds: [],
      userBehavior: { preferredTopics: [], preferredLanguages: ['es'] },
    });

    const expr = relevanceBoostExpr() as {
      $min: [
        unknown,
        { $cond: [{ $gt: [{ $size: { $setIntersection: [{ $ifNull: [string, unknown[]] }, { $literal: string[] }] } }, number] }, number, number] },
      ];
    };
    const cond = expr.$min[1].$cond;
    expect(cond[1]).toBe(MtnConfig.ranking.exploreRelevance.languageMatch);
    expect(cond[2]).toBe(1);
    const setIntersection = cond[0].$gt[0].$size.$setIntersection;
    expect(setIntersection[1]).toEqual({ $literal: ['es'] });
    expect(setIntersection[0]).toEqual({ $ifNull: ['$postClassification.languages', []] });
  });

  it('combines topic + language + region factors into one clamped product', async () => {
    await gather({
      currentUserId: 'viewer',
      followingIds: [],
      userBehavior: { preferredTopics: [{ topic: 'tech', weight: 5 }], preferredLanguages: ['es'] },
      viewerRegion: 'ES',
    });

    const expr = relevanceBoostExpr() as { $min: [unknown, { $multiply: unknown[] }] };
    expect(expr.$min[0]).toEqual({ $literal: MtnConfig.ranking.exploreRelevance.maxBoost });
    expect(Array.isArray(expr.$min[1].$multiply)).toBe(true);
    expect(expr.$min[1].$multiply).toHaveLength(3);
  });

  it('does NOT change the $match stage — relevance is a boost, not a filter (SFW intact)', async () => {
    await gather({
      currentUserId: 'viewer',
      followingIds: [],
      userBehavior: { preferredTopics: [{ topic: 'tech', weight: 5 }], preferredLanguages: ['es'] },
      viewerRegion: 'ES',
    });

    const match = firstMatch();
    expect(match['postClassification.topics']).toBeUndefined();
    expect(match['postClassification.languages']).toBeUndefined();
    expect(match['postClassification.region']).toBeUndefined();
    expect(match['postClassification.sensitive']).toEqual({ $ne: true });
  });

  it('wraps dynamic viewer signals in $literal so $-prefixed preferences cannot become aggregation expressions', async () => {
    await gather({
      currentUserId: 'viewer',
      followingIds: [],
      userBehavior: { preferredTopics: [{ topic: '$$bad', weight: 5 }], preferredLanguages: ['$$lang'] },
      viewerRegion: '$$region',
    });

    const expr = relevanceBoostExpr() as { $min: [unknown, { $multiply: Array<{ $cond: unknown[] }> }] };
    const factors = expr.$min[1].$multiply;
    expect(factors).toHaveLength(3);

    const setIntersectionRhs = (factor: { $cond: unknown[] }): unknown => {
      const cond = factor.$cond[0] as { $gt?: [{ $size: { $setIntersection: unknown[] } }, number] };
      return cond.$gt?.[0]?.$size?.$setIntersection?.[1];
    };
    const fieldPath = (factor: { $cond: unknown[] }): string | undefined => {
      const cond = factor.$cond[0] as {
        $gt?: [{ $size: { $setIntersection: unknown[] } }, number];
        $eq?: [string, unknown];
      };
      if (cond.$gt) {
        const lhs = cond.$gt[0].$size.$setIntersection[0] as { $ifNull?: [string, unknown] };
        return lhs.$ifNull?.[0];
      }
      return cond.$eq?.[0];
    };

    const topicFactor = factors.find((f) => fieldPath(f) === '$postClassification.topics');
    const languageFactor = factors.find((f) => fieldPath(f) === '$postClassification.languages');
    const regionFactor = factors.find((f) => fieldPath(f) === '$postClassification.region');
    expect(topicFactor).toBeDefined();
    expect(languageFactor).toBeDefined();
    expect(regionFactor).toBeDefined();

    if (!topicFactor || !languageFactor || !regionFactor) throw new Error('missing factor');
    expect(setIntersectionRhs(topicFactor)).toEqual({ $literal: ['$$bad'] });
    expect(setIntersectionRhs(languageFactor)).toEqual({ $literal: ['$$lang'] });
    expect((regionFactor.$cond[0] as { $eq: [string, unknown] }).$eq[1]).toEqual({ $literal: '$$region' });
  });

  it('uses ALL preferred-topic slugs (no discovery weight floor) lowercased', async () => {
    await gather({
      currentUserId: 'viewer',
      followingIds: [],
      userBehavior: { preferredTopics: [{ topic: 'TechNews', weight: 0.1 }], preferredLanguages: [] },
    });

    const expr = relevanceBoostExpr() as { $min: [unknown, { $cond: [{ $gt: [{ $size: { $setIntersection: [unknown, { $literal: string[] }] } }, number] }, number, number] }] };
    expect(expr.$min[1].$cond[0].$gt[0].$size.$setIntersection[1]).toEqual({ $literal: ['technews'] });
  });
});
