import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';

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
