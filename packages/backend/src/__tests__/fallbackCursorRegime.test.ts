import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * A `neverBlank` ranked feed has TWO pagination regimes on one cursor type, and
 * they measure different things:
 *
 *  - the RANKED regime cursors on `finalScore`, a product of near-1 multiplicative
 *    ranking signals;
 *  - the POPULAR FALLBACK regime cursors on `engagementScore`, a weighted sum of
 *    likes/boosts/comments that is 0 for most posts and unbounded above.
 *
 * Once `videos` and `for_you` gained `neverBlank`, a page served by the fallback
 * hands the NEXT request a cursor carrying an engagement score, and the ranked path
 * compared it against `finalScore` as though the two were the same quantity. A
 * fallback anchor of 0 filters out every ranked candidate; a fallback anchor of 50
 * makes the window a no-op, silently restarting the ranked feed at page one with
 * only the seen set standing between the viewer and the posts they just read.
 *
 * The fix is provenance, not arithmetic: the cursor records that the fallback
 * minted it, and the ranked path declines to compare — it stays in the regime the
 * cursor came from. See `ScoreCursorData.fromPopularFallback`.
 */

const aggregateCalls: unknown[][] = [];

vi.mock('../models/Post', () => ({
  Post: {
    find: vi.fn(() => ({
      select: () => ({
        sort: () => ({ limit: () => ({ maxTimeMS: () => ({ lean: () => Promise.resolve([]) }) }) }),
      }),
    })),
    aggregate: vi.fn((pipeline: unknown[]) => {
      aggregateCalls.push(pipeline);
      return { option: () => Promise.resolve([]) };
    }),
  },
}));

const rankPosts = vi.fn(async (posts: Array<Record<string, unknown>>) => {
  // Ranking scores are a PRODUCT of near-neutral signals, so they cluster near 1 —
  // orders of magnitude below the engagement sums the fallback cursors on.
  for (const p of posts) p.finalScore = (p._testScore as number | undefined) ?? 1.5;
  return posts;
});
vi.mock('../services/FeedRankingService', () => ({
  feedRankingService: { rankPosts: (...args: unknown[]) => rankPosts(...(args as Parameters<typeof rankPosts>)) },
}));

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

import { ScoreCursor } from '../mtn/feed/CursorBuilder';
import { FeedEngine } from '../mtn/feed/engine/FeedEngine';
import { popularVideosSource } from '../mtn/feed/engine/sources/discoverySources';
import { FeedModuleRegistry } from '../mtn/feed/engine/FeedModuleRegistry';
import type { CandidatePost, FeedDefinition, FeedEngineContext, SourceModule } from '../mtn/feed/engine/types';

const oid = (n: number) => new mongoose.Types.ObjectId(`5f${n.toString().padStart(22, '0')}`);

/** Ranked-lane posts. Ids 1-9, so a page from this lane is unmistakable. */
function rankedPool(): CandidatePost[] {
  return Array.from({ length: 9 }, (_v, i) => ({
    _id: oid(i + 1),
    oxyUserId: `ranked-author-${i + 1}`,
    createdAt: new Date(2026, 0, i + 1),
    _testScore: 2 - i * 0.1,
  })) as unknown as CandidatePost[];
}

/**
 * Fallback-lane posts. Ids 101+, and each carries the `engagementScore` the popular
 * aggregation stamps — the value `buildPopularCursor` mints the next cursor from.
 */
function popularPool(): CandidatePost[] {
  return Array.from({ length: 9 }, (_v, i) => ({
    _id: oid(101 + i),
    oxyUserId: `popular-author-${i + 1}`,
    createdAt: new Date(2026, 0, i + 1),
    engagementScore: 50 - i,
  })) as unknown as CandidatePost[];
}

function sourceReturning(id: string, posts: () => CandidatePost[]): SourceModule {
  return { id, kind: 'source', userComposable: false, gather: async () => posts() };
}

/**
 * An in-memory stand-in for the real popular source: it applies the SAME
 * `{engagementScore, createdAt, _id}` keyset that `popularKeysetStage` compiles to
 * Mongo, including the same refusal to key off a cursor the fallback did not mint.
 *
 * It is a stand-in, not the real thing — the real pipeline is asserted against the
 * real source in `popularFallbackPagination.test.ts`. It exists so the ENGINE test
 * can show the whole walk, which a source that ignored the cursor could not.
 */
function keysetPopularSource(id: string, posts: () => CandidatePost[]): SourceModule {
  return {
    id,
    kind: 'source',
    userComposable: false,
    gather: async (ctx, _params, cap) => {
      const parsed = ScoreCursor.parse(ctx.cursor);
      const ordered = posts().slice().sort((a, b) => {
        const scoreDiff = (b.engagementScore ?? 0) - (a.engagementScore ?? 0);
        if (scoreDiff !== 0) return scoreDiff;
        const timeDiff = new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime();
        if (timeDiff !== 0) return timeDiff;
        return String(b._id).localeCompare(String(a._id));
      });

      if (!parsed?.fromPopularFallback || parsed.tiebreakAt === undefined) return ordered.slice(0, cap);

      const boundary = { score: parsed.score, at: parsed.tiebreakAt, id: parsed.id };
      return ordered
        .filter((post) => {
          const score = post.engagementScore ?? 0;
          if (score < boundary.score) return true;
          if (score > boundary.score) return false;
          const at = new Date(post.createdAt ?? 0).getTime();
          if (at < boundary.at) return true;
          if (at > boundary.at) return false;
          return String(post._id) < boundary.id;
        })
        .slice(0, cap);
    },
  };
}

/** Shaped like `videosDefinition`: ranked, not pre-scored, neverBlank + fallback. */
const neverBlankDefinition: FeedDefinition = {
  id: 'videos',
  title: 'Videos',
  mode: 'ranked',
  sources: [{ module: 'videos', enabled: true }],
  signals: [],
  filters: [],
  execution: {
    seenPosts: true,
    neverBlank: true,
    popularFallback: 'popularVideos',
    threadGrouping: true,
    replyContext: false,
    hydrateMaxDepth: 0,
  },
};

function context(overrides: Partial<FeedEngineContext> = {}): FeedEngineContext {
  return { currentUserId: 'viewer', ...overrides } as FeedEngineContext;
}

function idsOf(response: { slices: Array<{ items: Array<{ post: { id?: string } }> }>; items: Array<{ id?: string }> }): string[] {
  const fromSlices = response.slices.flatMap((s) => s.items.map((i) => String(i.post.id)));
  return fromSlices.length > 0 ? fromSlices : response.items.map((p) => String(p.id));
}

let registry: FeedModuleRegistry;
let engine: FeedEngine;

beforeEach(() => {
  vi.clearAllMocks();
  aggregateCalls.length = 0;
  registry = new FeedModuleRegistry();
  engine = new FeedEngine(registry);
});

describe('ScoreCursor provenance', () => {
  it('records that the popular fallback minted it', () => {
    const cursor = ScoreCursor.build(50, oid(101).toString(), {
      asOf: Date.now(),
      tiebreakAt: Date.now(),
      fromPopularFallback: true,
    });
    expect(ScoreCursor.parse(cursor)?.fromPopularFallback).toBe(true);
  });

  it('leaves a ranked cursor unstamped, so absence means "not the fallback"', () => {
    const ranked = ScoreCursor.build(1.5, oid(1).toString());
    expect(ScoreCursor.parse(ranked)?.fromPopularFallback).toBeUndefined();
  });

  it('still parses a legacy cursor, which predates the stamp entirely', () => {
    const legacy = ScoreCursor.parse(`7:${oid(1).toString()}`);
    expect(legacy).toMatchObject({ score: 7, id: oid(1).toString() });
    expect(legacy?.fromPopularFallback).toBeUndefined();
  });

  it('does not stamp a cursor the fallback did not mint, even with a full keyset', () => {
    const cursor = ScoreCursor.build(9, oid(2).toString(), { asOf: Date.now(), tiebreakAt: Date.now() });
    expect(ScoreCursor.parse(cursor)?.tiebreakAt).toBeDefined();
    expect(ScoreCursor.parse(cursor)?.fromPopularFallback).toBeUndefined();
  });
});

describe('a neverBlank feed that has fallen back', () => {
  /**
   * Page one: the ranked lane is exhausted, so `neverBlank` serves the popular
   * fallback and the next cursor carries an ENGAGEMENT score of 50.
   */
  async function fallbackPageOne(): Promise<string> {
    registry.register(sourceReturning('videos', () => []));
    registry.register(keysetPopularSource('popularVideos', popularPool));

    const page = await engine.run(neverBlankDefinition, context(), { limit: 3 });
    expect(page.slices).toHaveLength(0);
    expect(idsOf(page)).toEqual([oid(101), oid(102), oid(103)].map(String));
    expect(page.nextCursor).toBeDefined();
    return page.nextCursor as string;
  }

  it('mints a cursor carrying an engagement score, stamped as the fallback\'s', async () => {
    const cursor = await fallbackPageOne();
    const parsed = ScoreCursor.parse(cursor);

    // 48 is post 103's `engagementScore`. Ranking `finalScore` never reaches this
    // scale — that mismatch is the whole defect.
    expect(parsed?.score).toBe(48);
    expect(parsed?.fromPopularFallback).toBe(true);
  });

  it('keeps serving the fallback rather than restarting the ranked lane', async () => {
    const cursor = await fallbackPageOne();

    // The ranked lane now has material again (the pool refilled, or the seen set
    // aged out). Before provenance, the engine took it: `finalScore` ~2 is less
    // than the cursor's 50, so the score window admitted EVERY ranked candidate
    // and page two was ranked page ONE.
    registry.register(sourceReturning('videos', rankedPool));

    const page = await engine.run(neverBlankDefinition, context(), { limit: 3, cursor });

    expect(idsOf(page)).toEqual([oid(104), oid(105), oid(106)].map(String));
    expect(page.slices).toHaveLength(0);
  });

  it('walks the fallback to exhaustion without repeating or stalling', async () => {
    let cursor: string | undefined = await fallbackPageOne();
    registry.register(sourceReturning('videos', rankedPool));

    const seen: string[] = [oid(101), oid(102), oid(103)].map(String);
    for (let page = 0; page < 5 && cursor; page += 1) {
      const response = await engine.run(neverBlankDefinition, context(), { limit: 3, cursor });
      const ids = idsOf(response);
      expect(ids.filter((id) => seen.includes(id))).toEqual([]);
      seen.push(...ids);
      cursor = response.nextCursor;
    }

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.every((id) => Number(id.slice(-3)) >= 101)).toBe(true);
  });
});

describe('the real popular source keysets only on its own cursors', () => {
  /** The keyset `$match` — the one constraining the field the sort orders on. */
  function keysetMatches(): Array<Record<string, unknown>> {
    return (aggregateCalls.flat() as Array<Record<string, unknown>>)
      .filter((stage): stage is { $match: Record<string, unknown> } => '$match' in stage)
      .map((stage) => stage.$match)
      .filter((match) => Array.isArray(match.$or)
        && (match.$or as Array<Record<string, unknown>>).some((clause) => 'engagementScore' in clause));
  }

  it('keysets on a cursor it minted itself', async () => {
    const cursor = ScoreCursor.build(9.25, oid(101).toString(), {
      asOf: Date.now(),
      tiebreakAt: Date.UTC(2026, 6, 20),
      fromPopularFallback: true,
    });
    await popularVideosSource.gather(context({ cursor }), {}, 10);

    const clauses = keysetMatches()[0]?.$or as Array<Record<string, unknown>> | undefined;
    expect(clauses?.[0]).toEqual({ engagementScore: { $lt: 9.25 } });
  });

  it('refuses a cursor with a complete key that the fallback did not mint', async () => {
    // This is the case `tiebreakAt`-presence alone cannot distinguish. Today no
    // ranked feed mints a `tiebreakAt`, so the old completeness check excluded this
    // by luck; a ranked sort that gained a `createdAt` tiebreak would have started
    // bounding `engagementScore` by a `finalScore` with no test noticing.
    const cursor = ScoreCursor.build(9.25, oid(101).toString(), {
      asOf: Date.now(),
      tiebreakAt: Date.UTC(2026, 6, 20),
    });
    await popularVideosSource.gather(context({ cursor }), {}, 10);

    expect(keysetMatches()).toHaveLength(0);
  });
});

describe('a fallback cursor outliving the fallback itself', () => {
  /**
   * The routing in `run` cannot help a definition that no longer HAS a fallback,
   * and clients hold cursors across a config change: drop `popularFallback` from
   * `videosDefinition` and every in-flight fallback cursor arrives at a ranked path
   * with nowhere to be sent. The score window has to refuse the comparison on its
   * own, which is why the guard lives there too and not only in the router.
   *
   * An engagement anchor of 0 is the damaging shape: `finalScore < 0` is false for
   * every post (`rankPosts` floors at 0), so an unguarded window empties the page
   * and the feed dead-ends rather than merely repeating.
   */
  const noFallbackDefinition: FeedDefinition = {
    ...neverBlankDefinition,
    execution: { ...neverBlankDefinition.execution, neverBlank: false, popularFallback: undefined },
  };

  it('serves the ranked page instead of filtering it away on a foreign score', async () => {
    registry.register(sourceReturning('videos', rankedPool));

    const staleFallbackCursor = ScoreCursor.build(0, oid(109).toString(), {
      asOf: Date.now(),
      tiebreakAt: Date.now(),
      fromPopularFallback: true,
    });

    const page = await engine.run(noFallbackDefinition, context(), { limit: 3, cursor: staleFallbackCursor });

    expect(idsOf(page)).toEqual([oid(1), oid(2), oid(3)].map(String));
  });
});

describe('a ranked cursor is unaffected', () => {
  it('still paginates the ranked lane by its own score window', async () => {
    registry.register(sourceReturning('videos', rankedPool));
    registry.register(keysetPopularSource('popularVideos', popularPool));

    const first = await engine.run(neverBlankDefinition, context(), { limit: 3 });
    expect(first.slices).toHaveLength(3);
    expect(ScoreCursor.parse(first.nextCursor)?.fromPopularFallback).toBeUndefined();

    const second = await engine.run(neverBlankDefinition, context(), { limit: 3, cursor: first.nextCursor });
    const firstIds = idsOf(first);
    const secondIds = idsOf(second);

    expect(secondIds).toHaveLength(3);
    expect(secondIds.filter((id) => firstIds.includes(id))).toEqual([]);
    // Still the ranked lane, not the fallback.
    expect(second.slices.length).toBeGreaterThan(0);
  });
});
