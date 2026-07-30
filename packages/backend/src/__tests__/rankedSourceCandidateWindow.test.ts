import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * `videos` and `media` are RANKED sources: they hand the engine an unordered
 * candidate POOL, and the engine ranks it in process (`FeedRankingService`) and
 * paginates the RESULT by a score window. They are not pre-scored like `explore`,
 * and they are not chronological like `following` — so nothing about their output
 * is ordered by `_id`.
 *
 * These tests pin the two halves of that contract, which are two different
 * questions and need two different kinds of evidence:
 *
 *  1. THE SOURCE MUST NOT NARROW THE POOL ON `_id`. A candidate that legitimately
 *     belongs on page two — it scored BELOW the cursor, so the engine's score
 *     window admits it — must still be IN the pool the engine gets. An `_id`
 *     bound drops it before ranking ever sees it, and because the bound only ever
 *     moves down, it can never come back in that session.
 *
 *  2. THE ENGINE MAKES PROGRESS WITHOUT THAT BOUND. Every item the engine emits
 *     scores at or above the page's cursor anchor, so the score window excludes
 *     the whole emitted page by construction — even from a source that ignores
 *     the cursor entirely and re-offers the identical pool every time. So the
 *     `_id` bound cannot be load-bearing for forward progress.
 *
 * For You is the in-repo precedent for both: its lanes
 * (`GatherForYouCandidatesParams`) take a seen set and NO cursor, and it
 * paginates purely on the engine's score window.
 */

const findCalls: Array<Record<string, unknown>> = [];

vi.mock('../models/Post', () => ({
  Post: {
    find: vi.fn((match: Record<string, unknown>) => {
      findCalls.push(match);
      return {
        select: () => ({
          sort: () => ({ limit: () => ({ maxTimeMS: () => ({ lean: () => Promise.resolve([]) }) }) }),
        }),
      };
    }),
    aggregate: vi.fn(() => ({ option: () => Promise.resolve([]) })),
  },
}));

const rankPosts = vi.fn(async (posts: Array<Record<string, unknown>>) => {
  for (const p of posts) p.finalScore = (p._testScore as number | undefined) ?? 0;
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
import { videosSource, mediaSource } from '../mtn/feed/engine/sources/discoverySources';
import { FeedEngine } from '../mtn/feed/engine/FeedEngine';
import { FeedModuleRegistry } from '../mtn/feed/engine/FeedModuleRegistry';
import type { CandidatePost, FeedDefinition, FeedEngineContext, SourceModule } from '../mtn/feed/engine/types';

/** ObjectIds ordered by construction, so "newer" is unambiguous. */
const oid = (n: number) => new mongoose.Types.ObjectId(`5f${n.toString().padStart(22, '0')}`);

/**
 * The page-one anchor: the LOWEST-scoring slice of the emitted page, which is what
 * the engine cursors on. Its position in `_id` order is unrelated to its position
 * in score order — that is the whole point.
 */
const ANCHOR_ID = oid(500);
/**
 * A candidate that belongs on page TWO: NEWER than the anchor (higher `_id`) but
 * lower-scoring, so page one never emitted it and the engine's score window admits
 * it. For a federated post this is the common case, not a corner case — its `_id`
 * is its IMPORT time, so a post backfilled minutes ago carries a near-maximal
 * `_id` no matter when it was actually written.
 */
const PAGE_TWO_CANDIDATE_ID = oid(900);

function context(overrides: Partial<FeedEngineContext> = {}): FeedEngineContext {
  return { currentUserId: 'viewer', ...overrides } as FeedEngineContext;
}

/**
 * Every `_id` RANGE bound in a built match, at any nesting depth (these builders
 * push their clauses into `$and`). `$nin` is not a range — excluding a bounded id
 * list is exactly how the seen set works and is not what is under test here.
 */
function idRangeBounds(node: unknown): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const walk = (value: unknown, key?: string): void => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (key === '_id' && ('$lt' in record || '$lte' in record || '$gt' in record || '$gte' in record)) {
      found.push(record);
    }
    for (const [childKey, child] of Object.entries(record)) walk(child, childKey);
  };
  walk(node);
  return found;
}

/** Whether the built match would let a candidate id through its `_id` range bounds. */
function admitsId(match: Record<string, unknown>, id: mongoose.Types.ObjectId): boolean {
  return idRangeBounds(match).every((bound) => {
    const lt = bound.$lt;
    const lte = bound.$lte;
    const gt = bound.$gt;
    const gte = bound.$gte;
    if (lt instanceof mongoose.Types.ObjectId && !(id < lt)) return false;
    if (lte instanceof mongoose.Types.ObjectId && !(id <= lte)) return false;
    if (gt instanceof mongoose.Types.ObjectId && !(id > gt)) return false;
    if (gte instanceof mongoose.Types.ObjectId && !(id >= gte)) return false;
    return true;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  findCalls.length = 0;
});

describe('the idRangeBounds probe itself', () => {
  it('finds a bound nested inside $and, and reports the candidate it would exclude', () => {
    const match = { $and: [{ _id: { $lt: ANCHOR_ID } }] };
    expect(idRangeBounds(match)).toHaveLength(1);
    expect(admitsId(match, PAGE_TWO_CANDIDATE_ID)).toBe(false);
    expect(admitsId(match, oid(1))).toBe(true);
  });

  it('does not mistake the seen-set exclusion for a range bound', () => {
    expect(idRangeBounds({ $and: [{ _id: { $nin: [ANCHOR_ID] } }] })).toHaveLength(0);
  });
});

describe.each([
  ['videos', videosSource],
  ['media', mediaSource],
])('%s candidate window', (_id, source: SourceModule) => {
  /** A cursor of the shape the ranked engine mints for these feeds. */
  const rankedCursor = ScoreCursor.build(7.5, ANCHOR_ID.toString());

  it('keeps a lower-scoring but newer candidate in the pool the engine ranks', async () => {
    await source.gather(context({ cursor: rankedCursor }), {}, 10);

    expect(findCalls).toHaveLength(1);
    // The engine's score window is what decides whether this candidate is emitted.
    // The source must not have already thrown it away on an axis nothing sorts by.
    expect(admitsId(findCalls[0], PAGE_TWO_CANDIDATE_ID)).toBe(true);
  });

  it('narrows the pool by nothing but the seen set', async () => {
    const seen = oid(42).toString();
    await source.gather(context({ cursor: rankedCursor, seenPostIds: [seen] }), {}, 10);

    expect(idRangeBounds(findCalls[0])).toHaveLength(0);
    expect(JSON.stringify(findCalls[0])).toContain(seen);
  });

  it('ignores a cursor minted by the popular fallback too', async () => {
    // `neverBlank` can hand the ranked source a cursor built from the POPULAR
    // ordering, whose id and score come from a different axis entirely. Applying
    // that id as an `_id` bound is the same defect with a worse provenance.
    const fallbackCursor = ScoreCursor.build(31, ANCHOR_ID.toString(), {
      asOf: Date.now(),
      tiebreakAt: Date.now(),
    });
    await source.gather(context({ cursor: fallbackCursor }), {}, 10);

    expect(idRangeBounds(findCalls[0])).toHaveLength(0);
  });
});

describe('score-window pagination without an _id bound', () => {
  /**
   * A source that ignores the cursor and re-offers the identical pool on every
   * page — the worst case for "removing the `_id` bound stalls the feed". If the
   * engine still advances against THIS source, the bound cannot be what was
   * driving progress.
   */
  function poolSource(posts: CandidatePost[]): SourceModule {
    return { id: 'videos', kind: 'source', userComposable: false, gather: async () => posts };
  }

  const rankedDefinition: FeedDefinition = {
    id: 'videos',
    title: 'Videos',
    mode: 'ranked',
    sources: [{ module: 'videos', enabled: true }],
    signals: [],
    filters: [],
    execution: { seenPosts: true, threadGrouping: true, replyContext: false, hydrateMaxDepth: 0 },
  };

  function pool(): CandidatePost[] {
    // Score DESCENDING in `_id` ASCENDING order, so the page-one anchor is the
    // OLDEST `_id` of the emitted page and every remaining candidate is NEWER than
    // it. An `_id: { $lt: anchor }` window would leave page two with nothing.
    return Array.from({ length: 9 }, (_v, i) => ({
      _id: oid(i + 1),
      oxyUserId: `author-${i + 1}`,
      createdAt: new Date(2026, 0, i + 1),
      _testScore: 100 - i,
    })) as unknown as CandidatePost[];
  }

  it('emits a disjoint second page from a source that re-offers the same pool', async () => {
    const registry = new FeedModuleRegistry();
    registry.register(poolSource(pool()));
    const engine = new FeedEngine(registry);

    const first = await engine.run(rankedDefinition, context(), { limit: 3 });
    const firstIds = first.slices.flatMap((s) => s.items.map((i) => String(i.post.id)));
    expect(firstIds).toHaveLength(3);
    expect(first.nextCursor).toBeDefined();

    const second = await engine.run(rankedDefinition, context(), { limit: 3, cursor: first.nextCursor });
    const secondIds = second.slices.flatMap((s) => s.items.map((i) => String(i.post.id)));

    expect(secondIds).toHaveLength(3);
    expect(secondIds.filter((id) => firstIds.includes(id))).toEqual([]);
  });

  it('walks the whole pool to exhaustion, never repeating and never stalling', async () => {
    const registry = new FeedModuleRegistry();
    registry.register(poolSource(pool()));
    const engine = new FeedEngine(registry);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const response = await engine.run(rankedDefinition, context(), { limit: 3, cursor });
      seen.push(...response.slices.flatMap((s) => s.items.map((i) => String(i.post.id))));
      cursor = response.nextCursor;
      if (!cursor) break;
    }

    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
  });
});
