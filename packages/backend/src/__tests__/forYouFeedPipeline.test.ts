import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * Tests for the `popular` SOURCE module (the For You anonymous + never-blank
 * fallback, wrapping the former `ForYouFeed.fetchPopular`). It must exclude
 * sensitive/NSFW at the query level AND belt-and-suspenders filter the aggregate
 * result for safe-for-work viewers, and skip both when the viewer opted in.
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

import { popularSource } from '../mtn/feed/engine/sources/discoverySources';
import type { FeedEngineContext } from '../mtn/feed/engine/types';

const oid = (n: number) => new mongoose.Types.ObjectId(`5f${n.toString().padStart(22, '0')}`);

function gather(ctx: FeedEngineContext) {
  return popularSource.gather({ ...ctx, pageLimit: 30 }, {}, 31);
}

beforeEach(() => {
  vi.clearAllMocks();
  aggregatePipelines.length = 0;
  aggregateMock.mockResolvedValue([]);
});

function popularMatch(): Record<string, unknown> {
  expect(aggregatePipelines.length).toBeGreaterThan(0);
  const pipeline = aggregatePipelines[aggregatePipelines.length - 1] as Array<Record<string, unknown>>;
  const matchStage = pipeline.find((stage) => '$match' in stage);
  expect(matchStage).toBeDefined();
  return (matchStage as { $match: Record<string, unknown> }).$match;
}

describe('popular source — SFW (default / anonymous)', () => {
  it('excludes sensitive/NSFW at the query level for the anonymous path', async () => {
    await gather({ currentUserId: undefined });
    const match = popularMatch();
    expect(match['postClassification.sensitive']).toEqual({ $ne: true });
    expect(match['metadata.isSensitive']).toEqual({ $ne: true });
    expect(match['federation.sensitive']).toEqual({ $ne: true });
    const hashtags = match.hashtags as { $nin?: string[] };
    expect(Array.isArray(hashtags?.$nin)).toBe(true);
    expect(hashtags.$nin).toContain('nsfw');
  });

  it('defaults to SFW when showSensitiveContent is absent (authed never-blank)', async () => {
    await gather({ currentUserId: 'viewer' });
    const match = popularMatch();
    expect(match['postClassification.sensitive']).toEqual({ $ne: true });
    expect((match.hashtags as { $nin: string[] }).$nin).toContain('nsfw');
    expect(match.visibility).toBe('public');
    expect(match.status).toBe('published');
  });

  it('belt-and-suspenders: drops any sensitive post that slips into the aggregate result', async () => {
    aggregateMock.mockResolvedValue([
      { _id: oid(101), oxyUserId: 'clean-author' },
      { _id: oid(102), oxyUserId: 'nsfw-author', hashtags: ['nsfw'] },
      { _id: oid(103), oxyUserId: 'flagged-author', postClassification: { sensitive: true } },
    ]);

    const posts = await gather({ currentUserId: undefined });
    const ids = posts.map((p) => String(p._id));
    expect(ids).toContain(oid(101).toString());
    expect(ids).not.toContain(oid(102).toString());
    expect(ids).not.toContain(oid(103).toString());
  });
});

describe('popular source — viewer opted in (showSensitiveContent)', () => {
  it('does NOT add the sensitive/NSFW query exclusion when the viewer opted in', async () => {
    await gather({ currentUserId: 'viewer', showSensitiveContent: true });
    const match = popularMatch();
    expect(match['postClassification.sensitive']).toBeUndefined();
    expect(match['metadata.isSensitive']).toBeUndefined();
    expect(match['federation.sensitive']).toBeUndefined();
    expect(match.hashtags).toBeUndefined();
    expect(match.visibility).toBe('public');
  });

  it('does NOT drop sensitive posts from the aggregate result when the viewer opted in', async () => {
    aggregateMock.mockResolvedValue([
      { _id: oid(101), oxyUserId: 'clean-author' },
      { _id: oid(102), oxyUserId: 'nsfw-author', hashtags: ['nsfw'] },
      { _id: oid(103), oxyUserId: 'flagged-author', postClassification: { sensitive: true } },
    ]);

    const posts = await gather({ currentUserId: 'viewer', showSensitiveContent: true });
    const ids = posts.map((p) => String(p._id));
    expect(ids).toContain(oid(101).toString());
    expect(ids).toContain(oid(102).toString());
    expect(ids).toContain(oid(103).toString());
  });
});
