import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { PostVisibility } from '@mention/shared-types';

/**
 * Unit tests for the infra-heavier "related" SOURCE modules (Phase 4). The
 * Post / snapshot models are mocked and every query match is captured so tests
 * can assert the exact clause each source builds + the in-memory ranking.
 */

const findCalls: Array<Record<string, unknown>> = [];
let findRouter: (match: Record<string, unknown>) => unknown[] = () => [];
let seedDoc: Record<string, unknown> | null = null;
let snapshotGroups: Array<Record<string, unknown>> = [];

function chainable(result: unknown[]) {
  const chain = {
    select: () => chain,
    sort: () => chain,
    limit: () => chain,
    maxTimeMS: () => chain,
    lean: () => Promise.resolve(result),
  };
  return chain;
}

vi.mock('../models/Post', () => ({
  Post: {
    find: vi.fn((match: Record<string, unknown>) => {
      findCalls.push(match);
      return chainable(findRouter(match));
    }),
    findById: vi.fn(() => ({ select: () => ({ lean: () => Promise.resolve(seedDoc) }) })),
  },
}));

vi.mock('../models/AuthorFollowerSnapshot', () => ({
  AuthorFollowerSnapshot: {
    aggregate: vi.fn(() => ({ option: () => Promise.resolve(snapshotGroups) })),
  },
}));

import { moreLikeThisSource, nearbySource, risingCreatorsSource } from '../mtn/feed/engine/sources/relatedSources';
import type { FeedEngineContext } from '../mtn/feed/engine/types';

const oid = (n: number) => new mongoose.Types.ObjectId(`5f${n.toString().padStart(22, '0')}`);
function makePost(n: number, extra: Record<string, unknown> = {}) {
  return { _id: oid(n), oxyUserId: `a${n}`, createdAt: new Date(), ...extra };
}

beforeEach(() => {
  findCalls.length = 0;
  findRouter = () => [];
  seedDoc = null;
  snapshotGroups = [];
  vi.clearAllMocks();
});

describe('moreLikeThis source', () => {
  it('loads the seed post, excludes it, and ranks candidates by topic/tag/author overlap', async () => {
    const seedId = oid(1);
    seedDoc = {
      postClassification: { topics: ['cats', 'pets'] },
      hashtags: ['meow'],
      oxyUserId: 'author1',
      visibility: PostVisibility.PUBLIC,
    };
    // High overlap (2 topics + 1 tag = 3) must rank above low overlap (1 topic = 1).
    findRouter = () => [
      makePost(10, { postClassification: { topics: ['cats'] }, hashtags: [] }),
      makePost(11, { postClassification: { topics: ['cats', 'pets'] }, hashtags: ['meow'] }),
    ];
    const ctx: FeedEngineContext = { currentUserId: 'viewer' };
    const posts = await moreLikeThisSource.gather(ctx, { postId: seedId.toString() }, 30);

    expect(posts.map((p) => String(p._id))).toEqual([oid(11).toString(), oid(10).toString()]);
    expect(posts[0].finalScore).toBe(3);
    expect(posts[1].finalScore).toBe(1);

    const match = findCalls[0];
    expect(match.visibility).toBe(PostVisibility.PUBLIC);
    expect((match._id as { $ne: mongoose.Types.ObjectId }).$ne.toString()).toBe(seedId.toString());
    const andClauses = match.$and as Array<{ $or: Record<string, unknown>[] }>;
    const orConditions = andClauses[0].$or;
    expect(orConditions).toEqual(
      expect.arrayContaining([
        { 'postClassification.topics': { $in: ['cats', 'pets'] } },
        { hashtags: { $in: ['meow'] } },
        { oxyUserId: 'author1' },
      ]),
    );
  });

  it('counts an author match as overlap even without shared topics/tags', async () => {
    seedDoc = {
      postClassification: { topics: [] },
      hashtags: [],
      oxyUserId: 'author1',
      visibility: PostVisibility.PUBLIC,
    };
    findRouter = () => [makePost(20, { oxyUserId: 'author1', postClassification: { topics: [] }, hashtags: [] })];
    const posts = await moreLikeThisSource.gather({}, { postId: oid(1).toString() }, 30);
    expect(posts[0].finalScore).toBe(1);
  });

  it('supports a param-driven seed (topics/hashtags/authorId) with no seed-post lookup', async () => {
    findRouter = () => [makePost(30, { postClassification: { topics: ['music'] } })];
    const posts = await moreLikeThisSource.gather({}, { topics: ['Music'], hashtags: ['Jazz'] }, 30);
    expect(posts.map((p) => String(p._id))).toEqual([oid(30).toString()]);
    const match = findCalls[0];
    const andClauses = match.$and as Array<{ $or: Record<string, unknown>[] }>;
    expect(andClauses[0].$or).toEqual(
      expect.arrayContaining([
        { 'postClassification.topics': { $in: ['music'] } },
        { hashtags: { $in: ['jazz'] } },
      ]),
    );
    // No _id exclusion on the param-driven path (no seed post).
    expect(match._id).toBeUndefined();
  });

  it('returns [] when the seed has no topics, hashtags, or author', async () => {
    const posts = await moreLikeThisSource.gather({}, {}, 30);
    expect(posts).toEqual([]);
    expect(findCalls).toHaveLength(0);
  });

  it('returns [] for an invalid seed post id', async () => {
    const posts = await moreLikeThisSource.gather({}, { postId: 'not-an-id' }, 30);
    expect(posts).toEqual([]);
  });

  it('rejects a PRIVATE seed whose author the viewer does not follow (no query runs)', async () => {
    seedDoc = {
      postClassification: { topics: ['cats'] },
      hashtags: ['meow'],
      oxyUserId: 'author1',
      visibility: PostVisibility.PRIVATE,
    };
    // A router that WOULD return results — proves the seed was rejected before any query.
    findRouter = () => [makePost(60, { postClassification: { topics: ['cats'] } })];
    const ctx: FeedEngineContext = { currentUserId: 'viewer', followingIds: ['someoneElse'] };
    const posts = await moreLikeThisSource.gather(ctx, { postId: oid(1).toString() }, 30);
    expect(posts).toEqual([]);
    expect(findCalls).toHaveLength(0);
  });

  it('uses a FOLLOWERS_ONLY seed when the viewer follows its author', async () => {
    seedDoc = {
      postClassification: { topics: ['cats'] },
      hashtags: ['meow'],
      oxyUserId: 'author1',
      visibility: PostVisibility.FOLLOWERS_ONLY,
    };
    findRouter = () => [makePost(61, { postClassification: { topics: ['cats'] }, hashtags: ['meow'] })];
    const ctx: FeedEngineContext = { currentUserId: 'viewer', followingIds: ['author1'] };
    const posts = await moreLikeThisSource.gather(ctx, { postId: oid(1).toString() }, 30);
    expect(posts.map((p) => String(p._id))).toEqual([oid(61).toString()]);
    expect(findCalls).toHaveLength(1);
  });

  it('uses the viewer’s OWN private seed', async () => {
    seedDoc = {
      postClassification: { topics: ['cats'] },
      hashtags: ['meow'],
      oxyUserId: 'viewer',
      visibility: PostVisibility.PRIVATE,
    };
    findRouter = () => [makePost(62, { postClassification: { topics: ['cats'] } })];
    const ctx: FeedEngineContext = { currentUserId: 'viewer', followingIds: [] };
    const posts = await moreLikeThisSource.gather(ctx, { postId: oid(1).toString() }, 30);
    expect(posts.map((p) => String(p._id))).toEqual([oid(62).toString()]);
    expect(findCalls).toHaveLength(1);
  });

  it('uses a PUBLIC seed regardless of viewer follow state (unchanged behavior)', async () => {
    seedDoc = {
      postClassification: { topics: ['cats'] },
      hashtags: ['meow'],
      oxyUserId: 'author1',
      visibility: PostVisibility.PUBLIC,
    };
    findRouter = () => [makePost(63, { postClassification: { topics: ['cats'] } })];
    const ctx: FeedEngineContext = { currentUserId: 'viewer', followingIds: [] };
    const posts = await moreLikeThisSource.gather(ctx, { postId: oid(1).toString() }, 30);
    expect(posts.map((p) => String(p._id))).toEqual([oid(63).toString()]);
    expect(findCalls).toHaveLength(1);
  });
});

describe('nearby source', () => {
  it('builds a geo $near query from lat/lng with the default radius', async () => {
    findRouter = () => [makePost(40)];
    const posts = await nearbySource.gather({}, { lat: 37.7, lng: -122.4 }, 30);
    expect(posts.map((p) => String(p._id))).toEqual([oid(40).toString()]);
    const near = (findCalls[0].location as { $near: { $geometry: { coordinates: number[] }; $maxDistance: number } })
      .$near;
    // GeoJSON is [longitude, latitude].
    expect(near.$geometry.coordinates).toEqual([-122.4, 37.7]);
    expect(near.$maxDistance).toBe(50 * 1000);
    expect(findCalls[0].visibility).toBe(PostVisibility.PUBLIC);
  });

  it('clamps an oversized radiusKm to the max and honors a provided radius', async () => {
    findRouter = () => [makePost(41)];
    await nearbySource.gather({}, { lat: 0, lng: 0, radiusKm: 99999 }, 30);
    const near = (findCalls[0].location as { $near: { $maxDistance: number } }).$near;
    expect(near.$maxDistance).toBe(500 * 1000);
  });

  it('accepts numeric-string coordinates', async () => {
    findRouter = () => [makePost(42)];
    await nearbySource.gather({}, { lat: '10', lng: '20', radiusKm: '25' }, 30);
    const near = (findCalls[0].location as { $near: { $geometry: { coordinates: number[] }; $maxDistance: number } })
      .$near;
    expect(near.$geometry.coordinates).toEqual([20, 10]);
    expect(near.$maxDistance).toBe(25 * 1000);
  });

  it('falls back to the viewer region when no coordinates are given', async () => {
    findRouter = () => [makePost(43)];
    const ctx: FeedEngineContext = { currentUserId: 'viewer', viewerRegion: 'US' };
    await nearbySource.gather(ctx, {}, 30);
    expect(findCalls[0]['postClassification.region']).toBe('US');
    expect(findCalls[0].location).toBeUndefined();
  });

  it('falls back to the viewer region for out-of-range coordinates', async () => {
    findRouter = () => [makePost(44)];
    const ctx: FeedEngineContext = { viewerRegion: 'DE' };
    await nearbySource.gather(ctx, { lat: 999, lng: 999 }, 30);
    expect(findCalls[0]['postClassification.region']).toBe('DE');
  });

  it('returns [] with neither coordinates nor a viewer region', async () => {
    const posts = await nearbySource.gather({}, {}, 30);
    expect(posts).toEqual([]);
    expect(findCalls).toHaveLength(0);
  });
});

describe('risingCreators source', () => {
  it('ranks authors by follower-growth rate and scores their posts by that rate', async () => {
    // A: 100 -> 110 (delta 10, rate 10/max(100,10) = 0.1)
    // B: 5 -> 50  (delta 45, rate 45/max(5,10)  = 4.5)  -> ranks first
    // C: 100 -> 90 (delta -10)                          -> excluded (not rising)
    snapshotGroups = [
      { _id: 'A', first: 100, last: 110 },
      { _id: 'B', first: 5, last: 50 },
      { _id: 'C', first: 100, last: 90 },
    ];
    findRouter = () => [makePost(50, { oxyUserId: 'A' }), makePost(51, { oxyUserId: 'B' })];

    const posts = await risingCreatorsSource.gather({}, {}, 30);
    expect(posts.map((p) => String(p._id))).toEqual([oid(51).toString(), oid(50).toString()]);
    expect(posts[0].finalScore).toBeCloseTo(4.5, 5);
    expect(posts[1].finalScore).toBeCloseTo(0.1, 5);

    // Only rising authors (positive delta) are queried, ordered by rate desc.
    const match = findCalls[0];
    expect(match.oxyUserId).toEqual({ $in: ['B', 'A'] });
    expect(match.visibility).toBe(PostVisibility.PUBLIC);
  });

  it('returns [] when there are no snapshots', async () => {
    snapshotGroups = [];
    const posts = await risingCreatorsSource.gather({}, {}, 30);
    expect(posts).toEqual([]);
    expect(findCalls).toHaveLength(0);
  });

  it('returns [] when no author has positive growth', async () => {
    snapshotGroups = [{ _id: 'A', first: 100, last: 100 }, { _id: 'B', first: 50, last: 40 }];
    const posts = await risingCreatorsSource.gather({}, {}, 30);
    expect(posts).toEqual([]);
    expect(findCalls).toHaveLength(0);
  });
});
