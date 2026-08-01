import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Unit tests for the generic FeedEngine with FAKE modules and mocked heavy
 * services (no DB / Redis / Oxy). Asserts the engine's orchestration:
 * cross-source dedupe, filter application, ranked-by-score ordering,
 * chronological ordering, and pagination + cursor.
 *
 * Every fixture is a WHOLE `CandidatePost` and every stand-in signal is a real
 * field on it — the ranking stub scores by `stats.likesCount`, the filter keys
 * off `hashtags`. The old fixtures hung private markers (`_testScore`) on a
 * `Record<string, unknown>` bag, which is what let them keep saying `_id` after
 * the engine had stopped reading it.
 */

// --- Mock the heavy collaborators the engine calls. ---
const rankPosts = vi.fn(async (
  posts: Array<Record<string, unknown>>,
  _userId?: unknown,
  _ctx?: unknown,
) => {
  // Deterministic stand-in for FeedRankingService: likes ARE the score.
  for (const p of posts) {
    const stats = p.stats as { likesCount?: number } | undefined;
    p.finalScore = stats?.likesCount ?? 0;
  }
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
        _sliceKey: String(post.id),
        items: [{ post, isThreadParent: false, isThreadChild: false, isThreadLastChild: false }],
        isIncompleteThread: false,
      })),
      additionalPostIds: [],
    })),
  },
}));

// hydrateSlices / hydratePosts → passthrough. A candidate already carries `id`
// (that IS the record's id), so hydration has nothing to stamp here.
vi.mock('../services/PostHydrationService', () => ({
  postHydrationService: {
    hydrateSlices: vi.fn(async (slices: unknown[]) => slices),
    hydratePosts: vi.fn(async (posts: unknown[]) => posts),
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
import { ScoreCursor } from '../mtn/feed/CursorBuilder';
import type { CandidatePost, FeedDefinition, SourceModule, FilterModule } from '../mtn/feed/engine/types';
import { feedCandidate, postStats } from './fixtures/feedCandidate';

/**
 * A pre-cutover ObjectId-hex id. Ids are plain `text` now, but they are not
 * arbitrary: `isLiveEntityId` accepts exactly the two shapes this database
 * stores (24-char ObjectId hex, uuid v7), and `ScoreCursor` refuses to mint or
 * parse a cursor around anything else. A fixture id like `post-1` silently
 * produces NO cursor and every page becomes page one.
 */
const id = (n: number) => `5f${n.toString().padStart(22, '0')}`;

function makePost(n: number, overrides: Partial<CandidatePost> = {}): CandidatePost {
  return feedCandidate({
    id: id(n),
    oxyUserId: `author-${n}`,
    createdAt: new Date(2020, 0, n),
    ...overrides,
  });
}

/** A candidate the ranking stub will score at `likes`. */
function scored(n: number, likes: number, overrides: Partial<CandidatePost> = {}): CandidatePost {
  return makePost(n, { stats: postStats({ likesCount: likes }), ...overrides });
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
    registry.register(sourceReturning('a', [scored(1, 1), scored(2, 5)]));
    registry.register(sourceReturning('b', [scored(2, 5), scored(3, 9, { hashtags: ['dropme'] })]));
    const dropThree: FilterModule = {
      id: 'dropThree',
      kind: 'filter',
      keep: (post) => !post.hashtags.includes('dropme'),
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
    expect(ids).toEqual([id(2), id(1)]);
    expect(rankPosts).toHaveBeenCalledOnce();
  });

  it('paginates: respects limit and returns an advancing cursor', async () => {
    registry.register(sourceReturning('a', [scored(1, 9), scored(2, 1)]));
    const def: FeedDefinition = {
      id: 'test-page',
      title: 'Test',
      mode: 'ranked',
      sources: [{ module: 'a', enabled: true }],
      signals: [],
      filters: [],
    };

    const result = await engine.run(def, { currentUserId: 'viewer' }, { limit: 1 });
    expect(result.items.map((i) => i.id)).toEqual([id(1)]);
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
            if (excluded.has(post.id)) return false;
            if (!parsed || parsed.score === Infinity) return true;
            const score = post.finalScore ?? 0;
            return score < parsed.score || (score === parsed.score && post.id < parsed.id);
          })
          .sort((a, b) => {
            const scoreDiff = (b.finalScore ?? 0) - (a.finalScore ?? 0);
            return scoreDiff || b.id.localeCompare(a.id);
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
      expect(first.items.map((item) => item.id)).toEqual([id(1), id(2)]);
      expect(parsedCursor).toMatchObject({
        score: 0.8765432109876543,
        id: id(2),
        asOf: initialTime,
      });
      expect(new Set(parsedCursor?.excludeIds)).toEqual(new Set([id(1), id(2)]));

      // The top item loses engagement and would cross below the old watermark;
      // advancing the clock must not create a duplicate on page two.
      candidates[0].finalScore = 0.1;
      vi.setSystemTime(initialTime + 6 * 60 * 60 * 1000);

      const second = await engine.run(def, {}, { limit: 2, cursor: first.nextCursor });
      expect(second.items.map((item) => item.id)).toEqual([id(3), id(4)]);
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
        if (excluded.has(post.id)) return false;
        if (!parsed || parsed.score === Infinity) return true;
        const score = post.finalScore ?? 0;
        return score < parsed.score || (score === parsed.score && post.id < parsed.id);
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

    expect(first.items.map((item) => item.id)).toEqual([id(10), id(9)]);
    expect(second.items.map((item) => item.id)).toEqual([id(8)]);
    expect(new Set([
      ...first.items.map((item) => item.id),
      ...second.items.map((item) => item.id),
    ])).toEqual(new Set([id(10), id(9), id(8)]));
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
    expect(result.items.map((i) => i.id)).toEqual([id(3), id(2), id(1)]);
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
    expect(result.items.map((i) => i.id)).toEqual([id(1)]);
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
    const laneGather = vi.fn(async () => [scored(1, 5)]);
    const popularGather = vi.fn(async () => [makePost(9)]);
    registry.register({ id: 'lane', kind: 'source', userComposable: false, gather: laneGather });
    registry.register({ id: 'popular', kind: 'source', userComposable: false, gather: popularGather });

    const result = await engine.run(rankedDef(), {}, { limit: 30 });
    expect(popularGather).toHaveBeenCalledOnce();
    expect(laneGather).not.toHaveBeenCalled();
    expect(result.items.map((i) => i.id)).toEqual([id(9)]);
  });

  it('falls back to popular when the authenticated ranked pool is empty (never-blank)', async () => {
    registry.register({ id: 'lane', kind: 'source', userComposable: false, gather: async () => [] });
    const popularGather = vi.fn(async () => [makePost(9)]);
    registry.register({ id: 'popular', kind: 'source', userComposable: false, gather: popularGather });

    const result = await engine.run(rankedDef(), { currentUserId: 'viewer' }, { limit: 30 });
    expect(popularGather).toHaveBeenCalledOnce();
    expect(result.items.map((i) => i.id)).toEqual([id(9)]);
  });

  it('does not pass showSensitiveContent into rankPosts', async () => {
    registry.register({ id: 'lane', kind: 'source', userComposable: false, gather: async () => [scored(1, 5)] });
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
