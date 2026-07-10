import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * Unit tests for the generic FeedEngine with FAKE modules and mocked heavy
 * services (no DB / Redis / Oxy). Asserts the engine's orchestration:
 * cross-source dedupe, filter application, ranked-by-score ordering,
 * chronological ordering, and pagination + cursor.
 */

// --- Mock the heavy collaborators the engine calls. ---
const rankPosts = vi.fn(async (posts: Array<Record<string, unknown>>, _userId?: unknown, _ctx?: unknown) => {
  // Attach finalScore from the fixture `_testScore` (higher = ranked first).
  for (const p of posts) p.finalScore = (p._testScore as number | undefined) ?? 0;
  return posts;
});
vi.mock('../services/FeedRankingService', () => ({
  feedRankingService: { rankPosts: (...args: unknown[]) => rankPosts(...(args as Parameters<typeof rankPosts>)) },
}));

// sliceFeed → one single-item slice per post, preserving order.
vi.mock('../services/ThreadSlicingService', () => ({
  threadSlicingService: {
    sliceFeed: vi.fn(async (posts: Array<Record<string, unknown>>) => ({
      slices: posts.map((post) => ({
        _sliceKey: String(post._id),
        items: [{ post, isThreadParent: false, isThreadChild: false, isThreadLastChild: false }],
        isIncompleteThread: false,
      })),
      additionalPostIds: [],
    })),
  },
}));

// hydrateSlices / hydratePosts → passthrough, stamping `id`.
vi.mock('../services/PostHydrationService', () => ({
  postHydrationService: {
    hydrateSlices: vi.fn(async (slices: Array<{ items: Array<{ post: Record<string, unknown> }> }>) => {
      for (const slice of slices) for (const item of slice.items) item.post.id = String(item.post._id);
      return slices;
    }),
    hydratePosts: vi.fn(async (posts: Array<Record<string, unknown>>) => {
      for (const p of posts) p.id = String(p._id);
      return posts;
    }),
  },
  resolveUserSummaries: vi.fn(async () => new Map()),
}));

vi.mock('../services/FeedSeenPostsService', () => ({
  feedSeenPostsService: {
    getSeenPostIds: vi.fn(async () => []),
    markPostsAsSeen: vi.fn(async () => undefined),
  },
}));

import { FeedEngine } from '../mtn/feed/engine/FeedEngine';
import { FeedModuleRegistry } from '../mtn/feed/engine/FeedModuleRegistry';
import type { CandidatePost, FeedDefinition, SourceModule, FilterModule } from '../mtn/feed/engine/types';

const oid = (n: number) => new mongoose.Types.ObjectId(`5f${n.toString().padStart(22, '0')}`);

function makePost(n: number, extra: Record<string, unknown> = {}): CandidatePost {
  return {
    _id: oid(n),
    oxyUserId: `author-${n}`,
    createdAt: new Date(2020, 0, n),
    ...extra,
  };
}

function sourceReturning(id: string, posts: CandidatePost[]): SourceModule {
  return { id, kind: 'source', userComposable: true, gather: async () => posts };
}

let registry: FeedModuleRegistry;
let engine: FeedEngine;

beforeEach(() => {
  vi.clearAllMocks();
  registry = new FeedModuleRegistry();
  engine = new FeedEngine(registry);
});

describe('FeedEngine — ranked mode', () => {
  it('dedupes across sources, applies a filter, and orders by composed score', async () => {
    // Two sources with an overlapping post; a filter drops post #3.
    registry.register(sourceReturning('a', [makePost(1, { _testScore: 1 }), makePost(2, { _testScore: 5 })]));
    registry.register(sourceReturning('b', [makePost(2, { _testScore: 5 }), makePost(3, { _testScore: 9 })]));
    const dropThree: FilterModule = {
      id: 'dropThree',
      kind: 'filter',
      keep: (post) => String(post._id) !== oid(3).toString(),
    };
    registry.register(dropThree);

    const def: FeedDefinition = {
      id: 'test-ranked',
      title: 'Test',
      mode: 'ranked',
      sources: [{ module: 'a', enabled: true }, { module: 'b', enabled: true }],
      signals: [],
      filters: [{ module: 'dropThree', enabled: true }],
    };

    const result = await engine.run(def, { currentUserId: 'viewer' }, { limit: 30 });
    const ids = result.items.map((i) => i.id);

    // #3 filtered out; #2 deduped to one; ordered by score desc (#2=5 before #1=1).
    expect(ids).toEqual([oid(2).toString(), oid(1).toString()]);
    expect(rankPosts).toHaveBeenCalledOnce();
  });

  it('paginates: respects limit and returns an advancing cursor', async () => {
    registry.register(sourceReturning('a', [makePost(1, { _testScore: 9 }), makePost(2, { _testScore: 1 })]));
    const def: FeedDefinition = {
      id: 'test-page',
      title: 'Test',
      mode: 'ranked',
      sources: [{ module: 'a', enabled: true }],
      signals: [],
      filters: [],
    };

    const result = await engine.run(def, { currentUserId: 'viewer' }, { limit: 1 });
    expect(result.items.map((i) => i.id)).toEqual([oid(1).toString()]);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBeTruthy();
  });
});

describe('FeedEngine — chronological mode', () => {
  it('orders by createdAt desc and dedupes', async () => {
    registry.register(sourceReturning('a', [makePost(3), makePost(1)]));
    registry.register(sourceReturning('b', [makePost(1), makePost(2)]));
    const def: FeedDefinition = {
      id: 'test-chrono',
      title: 'Test',
      mode: 'chronological',
      sources: [{ module: 'a', enabled: true }, { module: 'b', enabled: true }],
      signals: [],
      filters: [],
    };

    const result = await engine.run(def, { currentUserId: 'viewer' }, { limit: 30 });
    // createdAt = 2020-01-n, so newest first: 3, 2, 1 (deduped).
    expect(result.items.map((i) => i.id)).toEqual([oid(3).toString(), oid(2).toString(), oid(1).toString()]);
    expect(rankPosts).not.toHaveBeenCalled();
  });
});

describe('FeedEngine — soft-fail', () => {
  it('one throwing source does not sink the feed', async () => {
    const bad: SourceModule = {
      id: 'bad', kind: 'source', userComposable: true,
      gather: async () => { throw new Error('boom'); },
    };
    registry.register(bad);
    registry.register(sourceReturning('good', [makePost(1)]));
    const def: FeedDefinition = {
      id: 'test-softfail',
      title: 'Test',
      mode: 'chronological',
      sources: [{ module: 'bad', enabled: true }, { module: 'good', enabled: true }],
      signals: [],
      filters: [],
    };

    const result = await engine.run(def, { currentUserId: 'viewer' }, { limit: 30 });
    expect(result.items.map((i) => i.id)).toEqual([oid(1).toString()]);
  });
});

describe('FeedEngine — ranked fallbacks', () => {
  function rankedDef(): FeedDefinition {
    return {
      id: 'test-fallback',
      title: 'Test',
      mode: 'ranked',
      sources: [{ module: 'lane', enabled: true }],
      signals: [],
      filters: [],
      execution: { seenPosts: true, neverBlank: true, popularFallback: 'popular' },
    };
  }

  it('serves the popular fallback for an anonymous viewer (never gathering the ranked lane)', async () => {
    const laneGather = vi.fn(async () => [makePost(1, { _testScore: 5 })]);
    const popularGather = vi.fn(async () => [makePost(9)]);
    registry.register({ id: 'lane', kind: 'source', userComposable: false, gather: laneGather });
    registry.register({ id: 'popular', kind: 'source', userComposable: false, gather: popularGather });

    const result = await engine.run(rankedDef(), {}, { limit: 30 });
    expect(popularGather).toHaveBeenCalledOnce();
    expect(laneGather).not.toHaveBeenCalled();
    expect(result.items.map((i) => i.id)).toEqual([oid(9).toString()]);
  });

  it('falls back to popular when the authenticated ranked pool is empty (never-blank)', async () => {
    registry.register({ id: 'lane', kind: 'source', userComposable: false, gather: async () => [] });
    const popularGather = vi.fn(async () => [makePost(9)]);
    registry.register({ id: 'popular', kind: 'source', userComposable: false, gather: popularGather });

    const result = await engine.run(rankedDef(), { currentUserId: 'viewer' }, { limit: 30 });
    expect(popularGather).toHaveBeenCalledOnce();
    expect(result.items.map((i) => i.id)).toEqual([oid(9).toString()]);
  });

  it('does not pass showSensitiveContent into rankPosts', async () => {
    registry.register({ id: 'lane', kind: 'source', userComposable: false, gather: async () => [makePost(1, { _testScore: 5 })] });
    registry.register({ id: 'popular', kind: 'source', userComposable: false, gather: async () => [] });

    await engine.run(rankedDef(), { currentUserId: 'viewer', showSensitiveContent: true }, { limit: 30 });
    expect(rankPosts).toHaveBeenCalledOnce();
    const rankCtx = rankPosts.mock.calls[0]?.[2];
    expect(rankCtx).toBeDefined();
    expect(
      rankCtx && typeof rankCtx === 'object' && 'showSensitiveContent' in rankCtx
        ? rankCtx.showSensitiveContent
        : undefined,
    ).toBeUndefined();
  });
});
