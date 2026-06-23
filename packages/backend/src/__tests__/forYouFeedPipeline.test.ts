import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * Integration tests for `ForYouFeed.fetch` proving the multi-source candidate
 * pool flows into the EXISTING rank → dedup → never-blank → diversify → page →
 * cursor pipeline unchanged.
 *
 * `gatherForYouCandidates` and the leaf services are mocked so we can assert the
 * wiring without a live DB: the gathered union is what gets ranked, and an empty
 * union falls back to the never-blank `fetchPopular` path.
 */

const gatherMock = vi.fn();
const rankMock = vi.fn();
const aggregateMock = vi.fn();
const findOneMock = vi.fn();
const hydratePostsMock = vi.fn();
const hydrateSlicesMock = vi.fn();
const sliceFeedMock = vi.fn();
const getSeenMock = vi.fn();
const markSeenMock = vi.fn();

vi.mock('../mtn/feed/feeds/forYouCandidateSources', () => ({
  gatherForYouCandidates: (...args: unknown[]) => gatherMock(...args),
}));

// Capture the aggregate pipeline so fetchPopular's $match can be asserted.
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

vi.mock('../services/FeedRankingService', () => ({
  feedRankingService: { rankPosts: (...args: unknown[]) => rankMock(...args) },
}));

vi.mock('../services/FeedSeenPostsService', () => ({
  feedSeenPostsService: {
    getSeenPostIds: () => getSeenMock(),
    markPostsAsSeen: () => markSeenMock(),
  },
}));

vi.mock('../services/PostHydrationService', () => ({
  postHydrationService: {
    hydratePosts: (...args: unknown[]) => hydratePostsMock(...args),
    hydrateSlices: () => hydrateSlicesMock(),
  },
}));

vi.mock('../services/ThreadSlicingService', () => ({
  threadSlicingService: { sliceFeed: (...args: unknown[]) => sliceFeedMock(...args) },
}));

import { ForYouFeed } from '../mtn/feed/feeds/ForYouFeed';

const oid = (n: number) => new mongoose.Types.ObjectId(`5f${n.toString().padStart(22, '0')}`);

beforeEach(() => {
  vi.clearAllMocks();
  aggregatePipelines.length = 0;
  getSeenMock.mockResolvedValue([]);
  markSeenMock.mockResolvedValue(undefined);
});

/** Pull the `$match` stage from the captured fetchPopular aggregate pipeline. */
function popularMatch(): Record<string, unknown> {
  expect(aggregatePipelines.length).toBeGreaterThan(0);
  const pipeline = aggregatePipelines[aggregatePipelines.length - 1] as Array<Record<string, unknown>>;
  const matchStage = pipeline.find((stage) => '$match' in stage);
  expect(matchStage).toBeDefined();
  return (matchStage as { $match: Record<string, unknown> }).$match;
}

describe('ForYouFeed.fetch — multi-source wiring', () => {
  it('ranks the pool gathered by gatherForYouCandidates (not a global query)', async () => {
    const gathered = [
      { _id: oid(1), oxyUserId: 'follow-1' },
      { _id: oid(2), oxyUserId: 'affinity-1' },
      { _id: oid(3), oxyUserId: 'topic-author' },
    ];
    gatherMock.mockResolvedValue(gathered);
    rankMock.mockResolvedValue(
      gathered.map((p, i) => ({ ...p, finalScore: 10 - i })),
    );
    sliceFeedMock.mockResolvedValue({
      slices: gathered.map((p) => ({ items: [{ post: { ...p, id: p._id.toString(), finalScore: 5 } }] })),
    });
    hydrateSlicesMock.mockResolvedValue([
      { items: [{ post: { id: oid(1).toString() } }] },
    ]);

    const feed = new ForYouFeed();
    await feed.fetch({ cursor: undefined, limit: 30 }, { currentUserId: 'viewer', followingIds: ['follow-1'] });

    // gatherForYouCandidates was called and its result was passed to ranking.
    expect(gatherMock).toHaveBeenCalledOnce();
    expect(rankMock).toHaveBeenCalledOnce();
    const rankedArg = rankMock.mock.calls[0][0] as Array<{ oxyUserId: string }>;
    expect(rankedArg.map((p) => p.oxyUserId)).toEqual(['follow-1', 'affinity-1', 'topic-author']);
  });

  it('forwards the resolved followingIds/userBehavior/seenPostIds to the gatherer', async () => {
    getSeenMock.mockResolvedValue([oid(9).toString()]);
    gatherMock.mockResolvedValue([]); // empty → never-blank path (still asserts the call args)
    aggregateMock.mockResolvedValue([]);
    hydratePostsMock.mockResolvedValue([]);

    const feed = new ForYouFeed();
    const behavior = { preferredTopics: [{ topic: 'tech', weight: 1 }] };
    await feed.fetch(
      { cursor: undefined, limit: 30 },
      { currentUserId: 'viewer', followingIds: ['follow-1', 'follow-2'], userBehavior: behavior },
    );

    expect(gatherMock).toHaveBeenCalledOnce();
    const arg = gatherMock.mock.calls[0][0] as {
      viewerId: string;
      followingIds: string[];
      userBehavior: unknown;
      seenPostIds: string[];
    };
    expect(arg.viewerId).toBe('viewer');
    expect(arg.followingIds).toEqual(['follow-1', 'follow-2']);
    expect(arg.userBehavior).toBe(behavior);
    expect(arg.seenPostIds).toContain(oid(9).toString());
  });
});

describe('ForYouFeed.fetch — never-blank fallback', () => {
  it('falls back to fetchPopular (Post.aggregate) when the union is empty', async () => {
    gatherMock.mockResolvedValue([]);
    rankMock.mockResolvedValue([]); // ranking an empty pool yields an empty result
    aggregateMock.mockResolvedValue([{ _id: oid(100), oxyUserId: 'popular-author' }]);
    hydratePostsMock.mockResolvedValue([{ id: oid(100).toString() }]);

    const feed = new ForYouFeed();
    const res = await feed.fetch({ cursor: undefined, limit: 30 }, { currentUserId: 'viewer', followingIds: [] });

    // An empty deduped pool triggers the never-blank popular aggregate fallback.
    expect(aggregateMock).toHaveBeenCalled();
    expect(res.items.length).toBeGreaterThan(0);
  });

  it('falls back to fetchPopular when ranking produces zero deduped candidates', async () => {
    gatherMock.mockResolvedValue([{ _id: oid(1), oxyUserId: 'a' }]);
    rankMock.mockResolvedValue([]); // ranking dropped everything
    aggregateMock.mockResolvedValue([{ _id: oid(100), oxyUserId: 'popular-author' }]);
    hydratePostsMock.mockResolvedValue([{ id: oid(100).toString() }]);

    const feed = new ForYouFeed();
    const res = await feed.fetch({ cursor: undefined, limit: 30 }, { currentUserId: 'viewer', followingIds: [] });

    expect(aggregateMock).toHaveBeenCalled();
    expect(res.items.length).toBeGreaterThan(0);
  });
});

describe('ForYouFeed.fetch — anonymous viewer', () => {
  it('uses fetchPopular (never gathers multi-source candidates) for anon', async () => {
    aggregateMock.mockResolvedValue([{ _id: oid(100), oxyUserId: 'popular-author' }]);
    hydratePostsMock.mockResolvedValue([{ id: oid(100).toString() }]);

    const feed = new ForYouFeed();
    await feed.fetch({ cursor: undefined, limit: 30 }, { currentUserId: undefined, followingIds: [] });

    expect(gatherMock).not.toHaveBeenCalled();
    expect(aggregateMock).toHaveBeenCalled();
  });
});

describe('ForYouFeed.fetchPopular — SFW (never-blank fallback + anon)', () => {
  it('excludes sensitive/NSFW at the query level for the anonymous path', async () => {
    aggregateMock.mockResolvedValue([{ _id: oid(100), oxyUserId: 'popular-author' }]);
    hydratePostsMock.mockResolvedValue([{ id: oid(100).toString() }]);

    const feed = new ForYouFeed();
    await feed.fetch({ cursor: undefined, limit: 30 }, { currentUserId: undefined, followingIds: [] });

    const match = popularMatch();
    expect(match['postClassification.sensitive']).toEqual({ $ne: true });
    expect(match['metadata.isSensitive']).toEqual({ $ne: true });
    expect(match['federation.sensitive']).toEqual({ $ne: true });
    const hashtags = match.hashtags as { $nin?: string[] };
    expect(Array.isArray(hashtags?.$nin)).toBe(true);
    expect(hashtags.$nin).toContain('nsfw');
  });

  it('excludes sensitive/NSFW on the authed never-blank fallback too', async () => {
    gatherMock.mockResolvedValue([]); // empty union → never-blank fetchPopular
    rankMock.mockResolvedValue([]);
    aggregateMock.mockResolvedValue([{ _id: oid(100), oxyUserId: 'popular-author' }]);
    hydratePostsMock.mockResolvedValue([{ id: oid(100).toString() }]);

    const feed = new ForYouFeed();
    await feed.fetch({ cursor: undefined, limit: 30 }, { currentUserId: 'viewer', followingIds: [] });

    const match = popularMatch();
    expect(match['postClassification.sensitive']).toEqual({ $ne: true });
    expect(match['metadata.isSensitive']).toEqual({ $ne: true });
    expect(match['federation.sensitive']).toEqual({ $ne: true });
    expect((match.hashtags as { $nin: string[] }).$nin).toContain('nsfw');
  });

  it('belt-and-suspenders: drops any sensitive post that slips into the aggregate result', async () => {
    // Simulate the (impossible-after-query) case of a sensitive post in the
    // aggregate output to prove the in-code guard removes it.
    aggregateMock.mockResolvedValue([
      { _id: oid(101), oxyUserId: 'clean-author' },
      { _id: oid(102), oxyUserId: 'nsfw-author', hashtags: ['nsfw'] },
      { _id: oid(103), oxyUserId: 'flagged-author', postClassification: { sensitive: true } },
    ]);
    hydratePostsMock.mockImplementation((posts: Array<{ _id: { toString(): string } }>) =>
      Promise.resolve(posts.map((p) => ({ id: p._id.toString() }))),
    );

    const feed = new ForYouFeed();
    const res = await feed.fetch({ cursor: undefined, limit: 30 }, { currentUserId: undefined, followingIds: [] });

    const returnedIds = res.items.map((item) => item.id);
    expect(returnedIds).toContain(oid(101).toString());
    expect(returnedIds).not.toContain(oid(102).toString());
    expect(returnedIds).not.toContain(oid(103).toString());
  });
});
