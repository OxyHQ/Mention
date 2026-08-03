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

import { MtnConfig } from '@mention/shared-types';
import { FeedEngine } from '../mtn/feed/engine/FeedEngine';
import { FeedModuleRegistry } from '../mtn/feed/engine/FeedModuleRegistry';
import { ScoreCursor } from '../mtn/feed/CursorBuilder';
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

  it('keeps pre-scored pages disjoint when time and engagement advance', async () => {
    vi.useFakeTimers();
    const initialTime = Date.UTC(2026, 6, 26, 12, 0, 0);
    vi.setSystemTime(initialTime);

    try {
      const candidates = [
        makePost(1, { finalScore: 0.9876543210987654 }),
        makePost(2, { finalScore: 0.8765432109876543 }),
        makePost(3, { finalScore: 0.7654321098765432 }),
        makePost(4, { finalScore: 0.6543210987654321 }),
      ];
      const observedAsOf: Array<number | undefined> = [];
      const gather = vi.fn(async (ctx: Parameters<SourceModule['gather']>[0]) => {
        observedAsOf.push(ctx.rankingAsOf);
        const parsed = ScoreCursor.parse(ctx.cursor);
        const excluded = new Set(parsed?.excludeIds ?? []);
        return candidates
          .filter((post) => {
            const id = String(post._id);
            if (excluded.has(id)) return false;
            if (!parsed || parsed.score === Infinity) return true;
            const score = post.finalScore ?? 0;
            return score < parsed.score || (score === parsed.score && id < parsed.id);
          })
          .sort((a, b) => {
            const scoreDiff = (b.finalScore ?? 0) - (a.finalScore ?? 0);
            return scoreDiff || String(b._id).localeCompare(String(a._id));
          });
      });
      registry.register({ id: 'pre-scored', kind: 'source', userComposable: false, gather });
      const def: FeedDefinition = {
        id: 'test-pre-scored',
        title: 'Test pre-scored',
        mode: 'ranked',
        sources: [{ module: 'pre-scored', enabled: true }],
        signals: [],
        filters: [],
        execution: { preScored: true },
      };

      const first = await engine.run(def, {}, { limit: 2 });
      const parsedCursor = ScoreCursor.parse(first.nextCursor);
      expect(first.items.map((item) => item.id)).toEqual([oid(1).toString(), oid(2).toString()]);
      expect(parsedCursor).toMatchObject({
        score: 0.8765432109876543,
        id: oid(2).toString(),
        asOf: initialTime,
      });
      expect(new Set(parsedCursor?.excludeIds)).toEqual(new Set([oid(1).toString(), oid(2).toString()]));

      // The top item loses engagement and would cross below the old watermark;
      // advancing the clock must not create a duplicate on page two.
      candidates[0].finalScore = 0.1;
      vi.setSystemTime(initialTime + 6 * 60 * 60 * 1000);

      const second = await engine.run(def, {}, { limit: 2, cursor: first.nextCursor });
      expect(second.items.map((item) => item.id)).toEqual([oid(3).toString(), oid(4).toString()]);
      const firstIds = new Set(first.items.map((item) => item.id));
      expect(second.items.some((item) => firstIds.has(item.id))).toBe(false);
      expect(observedAsOf).toEqual([initialTime, initialTime]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('selects a pre-scored page window before author diversification', async () => {
    const candidates = [
      makePost(10, { oxyUserId: 'author-a', finalScore: 10 }),
      makePost(9, { oxyUserId: 'author-a', finalScore: 9 }),
      makePost(8, { oxyUserId: 'author-b', finalScore: 8 }),
    ];
    const gather = async (ctx: Parameters<SourceModule['gather']>[0]) => {
      const parsed = ScoreCursor.parse(ctx.cursor);
      const excluded = new Set(parsed?.excludeIds ?? []);
      return candidates.filter((post) => {
        const id = String(post._id);
        if (excluded.has(id)) return false;
        if (!parsed || parsed.score === Infinity) return true;
        const score = post.finalScore ?? 0;
        return score < parsed.score || (score === parsed.score && id < parsed.id);
      });
    };
    registry.register({ id: 'pre-scored-window', kind: 'source', userComposable: false, gather });
    const def: FeedDefinition = {
      id: 'test-pre-scored-window',
      title: 'Test pre-scored window',
      mode: 'ranked',
      sources: [{ module: 'pre-scored-window', enabled: true }],
      signals: [],
      filters: [],
      execution: { preScored: true },
    };

    const first = await engine.run(def, {}, { limit: 2 });
    const second = await engine.run(def, {}, { limit: 2, cursor: first.nextCursor });

    expect(first.items.map((item) => item.id)).toEqual([oid(10).toString(), oid(9).toString()]);
    expect(second.items.map((item) => item.id)).toEqual([oid(8).toString()]);
    expect(new Set([
      ...first.items.map((item) => item.id),
      ...second.items.map((item) => item.id),
    ])).toEqual(new Set([oid(10).toString(), oid(9).toString(), oid(8).toString()]));
  });
});

describe('FeedEngine — ranked pagination coverage', () => {
  const PAGE_LIMIT = 6;
  const PROLIFIC_POSTS = 12;
  const SOLO_AUTHORS = 12;

  /**
   * A thin follow graph: ONE prolific author interleaved with a long tail of
   * one-post authors, strictly score-descending. This is the shape
   * `maxPerAuthorPerPage` exists for — the prolific author supplies far more
   * page-eligible candidates than the cap admits, so the reranker has to defer
   * some of them.
   */
  function thinGraphPool(): CandidatePost[] {
    const posts: CandidatePost[] = [];
    let score = PROLIFIC_POSTS + SOLO_AUTHORS;
    for (let i = 0; i < Math.max(PROLIFIC_POSTS, SOLO_AUTHORS); i += 1) {
      if (i < PROLIFIC_POSTS) {
        posts.push(makePost(posts.length + 1, { oxyUserId: 'prolific', _testScore: score }));
        score -= 1;
      }
      if (i < SOLO_AUTHORS) {
        posts.push(makePost(posts.length + 1, { oxyUserId: `solo-${i}`, _testScore: score }));
        score -= 1;
      }
    }
    return posts;
  }

  function rankedDef(sourceId: string): FeedDefinition {
    return {
      id: 'test-ranked-pagination',
      title: 'Test ranked pagination',
      mode: 'ranked',
      sources: [{ module: sourceId, enabled: true }],
      signals: [],
      filters: [],
    };
  }

  /**
   * Drain a ranked pagination session to exhaustion and report what each page
   * served.
   *
   * A SINGLE page cannot observe this class of bug: page one looks complete and
   * correctly ordered, and the loss only appears as the union of every page
   * falling short of the pool. That is why the check has to paginate.
   */
  async function drainRanked(
    def: FeedDefinition,
    limit: number,
    poolSize: number,
  ): Promise<{ pages: string[][]; served: string[] }> {
    const pages: string[][] = [];
    let cursor: string | undefined;
    // A page that reports `hasMore` must serve at least one item, so a pool of
    // N posts can never need more than N pages. Exceeding that is a loop, not a
    // long session, and must fail loudly rather than spin.
    for (let page = 0; page <= poolSize; page += 1) {
      const result = await engine.run(def, { currentUserId: 'viewer' }, { limit, cursor });
      pages.push(result.items.map((item) => item.id));
      if (!result.hasMore || !result.nextCursor) {
        return { pages, served: pages.flat() };
      }
      cursor = result.nextCursor;
    }
    throw new Error(`Ranked session did not terminate within ${poolSize} pages`);
  }

  it('serves every candidate across the session — per-author-cap overflow rolls forward, never strands', async () => {
    // Vacuity floor: the fixture only exercises the cap if the prolific author
    // brings more page-eligible posts than one page may admit from them.
    expect(PROLIFIC_POSTS).toBeGreaterThan(MtnConfig.ranking.diversity.maxPerAuthorPerPage);

    const pool = thinGraphPool();
    registry.register(sourceReturning('thin-graph', pool));

    const { served } = await drainRanked(rankedDef('thin-graph'), PAGE_LIMIT, pool.length);

    const poolIds = pool.map((post) => String(post._id));
    const servedSet = new Set(served);
    const stranded = poolIds.filter((id) => !servedSet.has(id));

    // The reranker's documented contract: it DEFERS, it never drops. A deferred
    // slice scores ABOVE the page tail, so the score cursor minted from that
    // tail excludes it from every subsequent page — it is lost, not deferred.
    expect({ strandedCount: stranded.length, strandedIds: stranded }).toEqual({
      strandedCount: 0,
      strandedIds: [],
    });
    expect(servedSet.size).toBe(poolIds.length);
    // A session must not repeat either: coverage bought with duplicates is not
    // coverage.
    expect(served.length).toBe(servedSet.size);
  });

  it('control: a pool with one post per author strands nothing (the cap never binds)', async () => {
    const pool = Array.from({ length: PROLIFIC_POSTS + SOLO_AUTHORS }, (_, i) =>
      makePost(i + 1, { oxyUserId: `solo-${i}`, _testScore: PROLIFIC_POSTS + SOLO_AUTHORS - i }));
    registry.register(sourceReturning('one-each', pool));

    const { served } = await drainRanked(rankedDef('one-each'), PAGE_LIMIT, pool.length);

    const servedSet = new Set(served);
    const stranded = pool.map((post) => String(post._id)).filter((id) => !servedSet.has(id));

    expect({ strandedCount: stranded.length, strandedIds: stranded }).toEqual({
      strandedCount: 0,
      strandedIds: [],
    });
    expect(served.length).toBe(servedSet.size);
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
