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

import { moreLikeThisSource, nearbySource } from '../mtn/feed/engine/sources/relatedSources';
import type { FeedEngineContext } from '../mtn/feed/engine/types';

const oid = (n: number) => new mongoose.Types.ObjectId(`5f${n.toString().padStart(22, '0')}`);
function makePost(n: number, extra: Record<string, unknown> = {}) {
  return { _id: oid(n), oxyUserId: `a${n}`, createdAt: new Date(), ...extra };
}

beforeEach(() => {
  findCalls.length = 0;
  findRouter = () => [];
  seedDoc = null;
  vi.clearAllMocks();
});

describe('moreLikeThis source', () => {
  it('loads the seed post, excludes it, and ranks candidates by topic/tag/author overlap', async () => {
    const seedId = oid(1);
    seedDoc = {
      postClassification: { topics: ['cats', 'pets'] },
      hashtags: ['meow'],
      oxyUserId: 'author1',
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
    seedDoc = { postClassification: { topics: [] }, hashtags: [], oxyUserId: 'author1' };
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
