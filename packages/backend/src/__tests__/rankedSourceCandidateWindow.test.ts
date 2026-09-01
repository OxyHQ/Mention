/**
 * The RANKED sources' candidate window (`videos`, `media`), against a real
 * database.
 *
 * `videos` and `media` hand the engine an unordered candidate POOL. The engine
 * ranks it in process (`FeedRankingService`) and paginates the RESULT by a score
 * window (`FeedEngine.finalizeRanked`). They are not pre-scored like `explore`
 * and not chronological like `following`, so NOTHING about their output is
 * ordered by id — and `posts.id` is not even a time order any more: it is `text`
 * holding either a 24-char ObjectId hex or a uuid v7.
 *
 * Two halves of one contract, which are two different questions:
 *
 *  1. THE SOURCE MUST NOT NARROW THE POOL ON `id`. A candidate that legitimately
 *     belongs on page two — it scored BELOW the cursor, so the engine's score
 *     window admits it — must still be IN the pool the engine gets. An id bound
 *     drops it before ranking ever sees it, and because the bound only ever moves
 *     down it can never come back in that session.
 *  2. THE ENGINE MAKES PROGRESS WITHOUT THAT BOUND. Every item the engine emits
 *     scores at or above the page's cursor anchor, so the score window excludes
 *     the whole emitted page by construction — even from a source that ignores
 *     the cursor entirely and re-offers the identical pool every time. The id
 *     bound therefore cannot be what was driving forward progress.
 *
 * ## Why this is a row question now, and what the predecessor could not see
 *
 * The predecessor walked the built Mongo `$match` looking for `_id` range
 * operators, and carried a hand-written `admitsId()` that RE-IMPLEMENTED Mongo's
 * comparison semantics in TypeScript in order to judge them. Both techniques are
 * gone. There is no query object to inspect, and an interpreter of one could only
 * ever agree with itself: it cannot see a predicate Postgres evaluates
 * differently (a NULL-propagating `NOT IN`, an `EXISTS` correlated to the wrong
 * table) and it cannot see a pool that came back short for any other reason. The
 * only honest question left is WHICH ROWS COME BACK, so every assertion below is
 * an EXACT id set.
 *
 * ## Isolation
 *
 * Test files run in parallel workers against ONE database and these sources scan
 * globally, so a concurrent suite's video posts are legitimately in the result.
 * Every assertion therefore restricts the result to this file's own fixture ids.
 * That is not a weakening: the fixtures' own keys never change, so a row this
 * file created going missing — which is the entire failure mode — still shows up
 * as a wrong set.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';
import type { MediaItem } from '@mention/shared-types';

/**
 * Deterministic stand-in for `FeedRankingService`: LIKES ARE THE SCORE.
 *
 * The real service reads `UserBehavior` from Mongo and the viewer's follow graph
 * from Oxy, so it cannot run here — but the stand-in scores off a REAL column on
 * the record rather than a private marker hung on the fixture, so the pool it
 * ranks is the one Postgres returned and the tie it produces is a property of
 * the rows.
 */
const rankByLikes = vi.fn(async (candidates: CandidatePost[]): Promise<CandidatePost[]> => {
  for (const candidate of candidates) candidate.finalScore = candidate.stats.likesCount;
  return candidates;
});
// The factory is hoisted above every declaration in this file, so `rankByLikes`
// is referenced from inside a function body — naming it directly as the property
// value reads it during hoisting and dies with "Cannot access before
// initialization".
vi.mock('../services/FeedRankingService', () => ({
  feedRankingService: { rankPosts: (candidates: CandidatePost[]) => rankByLikes(candidates) },
}));

// One single-item slice per candidate, order preserved: the real slicer runs its
// own Mongo queries for thread children, and grouping is not what is under test.
vi.mock('../services/ThreadSlicingService', () => ({
  threadSlicingService: {
    sliceFeed: vi.fn(async (candidates: CandidatePost[]) => ({
      slices: candidates.map((post) => ({
        _sliceKey: post.id,
        items: [{ post, isThreadParent: false, isThreadChild: false, isThreadLastChild: false }],
        isIncompleteThread: false,
      })),
      additionalPostIds: [],
    })),
  },
}));

// Hydration is the one collaborator that would reach Oxy over the network. It is
// a pass-through, so every id asserted below is a real row read out of Postgres.
vi.mock('../services/PostHydrationService', () => ({
  postHydrationService: {
    hydrateSlices: vi.fn(async (slices: unknown[]) => slices),
    hydratePosts: vi.fn(async (records: unknown[]) => records),
  },
  resolveUserSummaries: vi.fn(async () => new Map()),
}));

// An empty seen set on every page, so the pool the engine sees is never narrowed
// by anything except the thing under test.
vi.mock('../services/FeedSeenPostsService', () => ({
  feedSeenPostsService: {
    getSeenPostIds: vi.fn(async () => []),
    markPostsAsSeen: vi.fn(async () => undefined),
  },
}));

import { closePostgres, connectPostgres, type Database } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { insertPostRecord } from '../db/posts/postRepository';
import type { PostRecordInput } from '../db/posts/postRecord';
import { ScoreCursor } from '../mtn/feed/CursorBuilder';
import { videosSource, mediaSource } from '../mtn/feed/engine/sources/discoverySources';
import { FeedEngine } from '../mtn/feed/engine/FeedEngine';
import { FeedModuleRegistry } from '../mtn/feed/engine/FeedModuleRegistry';
import type {
  CandidatePost,
  FeedDefinition,
  FeedEngineContext,
  SourceModule,
} from '../mtn/feed/engine/types';
import { sameMillisecondIds } from './helpers/tiedIds';

let db: Database;
const created: string[] = [];

/**
 * Well above any page these tests ask for, so a missing row can never be
 * explained by the fetch limit.
 */
const CAP = 500;

/** Every field the default videos predicate requires; also satisfies `media`. */
const PORTRAIT_VIDEO: MediaItem = {
  id: 'ranked-window-video',
  type: 'video',
  width: 1080,
  height: 1920,
  durationSec: 30,
  orientation: 'portrait',
};

/**
 * A distinct author per fixture, deliberately.
 *
 * `diversifyByAuthor` reorders a page to space same-author slices apart, so a
 * pool written by one author would let the reranker — not the score window —
 * decide which rows land on page one, and the pagination assertions below would
 * be measuring the wrong thing.
 */
function authorFor(index: number): string {
  return `ranked-window-author-${index}`;
}

async function create(index: number, likes: number, id?: string): Promise<string> {
  const author = authorFor(index);
  const input: PostRecordInput = {
    id,
    oxyUserId: author,
    authorship: [{ oxyUserId: author, role: 'owner', status: 'accepted' }],
    type: PostType.VIDEO,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'clip' }], media: [PORTRAIT_VIDEO] },
  };
  const record = await insertPostRecord(input);
  created.push(record.id);
  // `stats` is owned by the engagement batch and is not part of
  // `PostRecordInput`, so a ranking fixture writes the column directly.
  await db.update(posts).set({ statsLikesCount: likes }).where(eq(posts.id, record.id));
  return record.id;
}

/** The ids `source` returns, restricted to this file's rows, in source order. */
async function gatherMine(
  source: SourceModule,
  ctx: FeedEngineContext,
  fixtures: readonly string[],
): Promise<string[]> {
  const candidates = await source.gather({ ...ctx, pageLimit: CAP }, {}, CAP);
  return candidates.map((candidate) => candidate.id).filter((id) => fixtures.includes(id));
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  vi.clearAllMocks();
  if (created.length > 0) {
    await db.delete(posts).where(inArray(posts.id, created));
    created.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe.each([
  ['videos', videosSource],
  ['media', mediaSource],
])('the %s candidate window', (_name, source: SourceModule) => {
  /**
   * Five posts whose ids ASCEND, because they are supplied that way.
   *
   * They are not left to `uuidv7()`: it has no monotonic counter, so five rows
   * written back to back do not ascend at all once any two share a millisecond —
   * their order is decided by the random tail. The vacuity floor below would then
   * fail at random and name the candidate window for what is really a fixture.
   *
   * The ANCHOR is the middle row and carries the HIGHEST engagement — a page-one
   * cursor anchor is the lowest-scoring slice of the page, and its position in id
   * order is unrelated to its position in score order. Two rows sit above it in
   * id order and two below, so an id bound in EITHER direction is visible here.
   */
  async function fixtures(): Promise<{ ids: string[]; anchor: string; pageTwoCandidate: string }> {
    const ascending = sameMillisecondIds(5);
    const ids = [
      await create(0, 4, ascending[0]),
      await create(1, 3, ascending[1]),
      await create(2, 9, ascending[2]),
      await create(3, 2, ascending[3]),
      await create(4, 1, ascending[4]),
    ];
    return { ids, anchor: ids[2], pageTwoCandidate: ids[4] };
  }

  it('keeps a lower-scoring but NEWER candidate in the pool the engine ranks', async () => {
    const { ids, anchor, pageTwoCandidate } = await fixtures();

    // The vacuity floor. Without rows on both sides of the anchor, an id bound in
    // one direction would leave the pool untouched and this case would pass
    // against the very defect it exists to catch.
    expect(ids.some((id) => id > anchor)).toBe(true);
    expect(ids.some((id) => id < anchor)).toBe(true);
    expect(pageTwoCandidate > anchor).toBe(true);

    const cursor = ScoreCursor.build(7.5, anchor);
    const pool = await gatherMine(source, { currentUserId: 'viewer', cursor }, ids);

    // The engine's score window is what decides whether these are emitted. The
    // source must not have thrown any of them away on an axis nothing sorts by.
    expect(pool.sort()).toEqual([...ids].sort());
    // Stated separately so a failure names the row that matters: for a federated
    // post this is the common case, not a corner case — its id is its IMPORT
    // time, so a post backfilled minutes ago carries a near-maximal id however
    // old it actually is.
    expect(pool).toContain(pageTwoCandidate);
  });

  it('narrows the pool by nothing but the seen set', async () => {
    const { ids, anchor } = await fixtures();
    const seen = [ids[0], ids[4]];

    const cursor = ScoreCursor.build(7.5, anchor);
    const pool = await gatherMine(source, { currentUserId: 'viewer', cursor, seenPostIds: seen }, ids);

    // EXACTLY the seen rows are missing. Excluding a bounded id list is how the
    // seen set works and is not what is under test; anything else missing is.
    expect(pool.sort()).toEqual(ids.filter((id) => !seen.includes(id)).sort());
  });

  it('ignores a cursor minted by the popular fallback too', async () => {
    /**
     * `neverBlank` can hand a ranked source a cursor built from the POPULAR
     * ordering, whose score and id come from a different axis entirely. Applying
     * that id as an id bound is the same defect with a worse provenance — and
     * applying its SCORE as an engagement bound is a second one: a fallback
     * anchor of 0 admits nothing at all.
     */
    const { ids, anchor } = await fixtures();
    const fallbackCursor = ScoreCursor.build(0, anchor, {
      asOf: Date.now(),
      tiebreakAt: Date.now(),
      fromPopularFallback: true,
    });

    const pool = await gatherMine(source, { currentUserId: 'viewer', cursor: fallbackCursor }, ids);

    expect(pool.sort()).toEqual([...ids].sort());
  });
});

describe('score-window pagination without an id bound', () => {
  /**
   * The worst case for "removing the id bound stalls the feed": a source that
   * ignores the cursor and re-offers the IDENTICAL pool on every page. If the
   * engine still advances against this, the bound cannot have been what was
   * driving progress.
   *
   * The pool is read out of Postgres through the real `videosSource` and then
   * replayed verbatim. Replaying rather than re-querying is what makes the page
   * assertions exact: the engine gathers `limit × candidateMultiplier`
   * candidates ordered globally by recency, and this database is shared with
   * every other test file, so a live re-query would page over other suites'
   * rows.
   */
  function replaySource(pool: readonly CandidatePost[]): SourceModule {
    return {
      id: 'videos',
      kind: 'source',
      userComposable: false,
      gather: async () => [...pool],
    };
  }

  /** Shaped like `videosDefinition`, minus the popular fallback (not under test here). */
  const rankedDefinition: FeedDefinition = {
    id: 'videos',
    title: 'Videos',
    mode: 'ranked',
    sources: [{ module: 'videos', enabled: true }],
    signals: [],
    filters: [],
    execution: { seenPosts: true, threadGrouping: true, replyContext: false, hydrateMaxDepth: 0 },
  };

  /**
   * Six posts that all carry the SAME engagement, so the ranking stand-in scores
   * them identically and the leading sort key TIES across the whole pool.
   *
   * That tie is the point. The engine breaks it on id descending
   * (`readCandidateId(b).localeCompare(readCandidateId(a))`) and its score window
   * continues on the same key (`postId < cursor.id`). With distinct scores both
   * halves are unreachable, and a keyset missing its tiebreak walks a distinctly
   * keyed pool perfectly — so only tied rows can tell the two apart.
   */
  async function tiedPool(): Promise<{ ids: string[]; pool: CandidatePost[] }> {
    const ids: string[] = [];
    for (let index = 0; index < 6; index += 1) ids.push(await create(index, 7));

    const candidates = await videosSource.gather({ pageLimit: CAP }, {}, CAP);
    const pool = candidates.filter((candidate) => ids.includes(candidate.id));
    expect(pool).toHaveLength(ids.length);
    // Highest id first — the order the engine's tiebreak must reproduce.
    return { ids: [...ids].sort().reverse(), pool };
  }

  function runEngine(pool: readonly CandidatePost[]) {
    const registry = new FeedModuleRegistry();
    registry.register(replaySource(pool));
    const engine = new FeedEngine(registry);
    return (cursor: string | undefined) =>
      engine.run(rankedDefinition, { currentUserId: 'viewer' }, { limit: 3, cursor });
  }

  it('serves two adjacent pages that neither overlap nor gap', async () => {
    const { ids, pool } = await tiedPool();
    const run = runEngine(pool);

    const first = await run(undefined);
    const firstIds = first.items.map((item) => item.id);
    // The three highest ids, in id-descending order: the tiebreak, asserted.
    expect(firstIds).toEqual(ids.slice(0, 3));
    expect(first.nextCursor).toBeDefined();

    const second = await run(first.nextCursor);
    const secondIds = second.items.map((item) => item.id);

    // NO OVERLAP: page two re-offered every row page one showed, and the score
    // window excluded them on its own.
    expect(secondIds.filter((id) => firstIds.includes(id))).toEqual([]);
    // NO GAP: the two pages together are exactly the fixture set, in order. This
    // is the assertion a score-only window fails — every row ties, so it either
    // re-serves page one or admits nothing.
    expect(secondIds).toEqual(ids.slice(3));
    expect([...firstIds, ...secondIds]).toEqual(ids);
  });

  it('walks the tied pool to exhaustion, never repeating and never stalling', async () => {
    const { ids, pool } = await tiedPool();
    const run = runEngine(pool);

    const served: string[] = [];
    let cursor: string | undefined;
    // The bound exists so a stalled walk fails as an assertion rather than as a
    // hang; reaching it is itself a failure, which the length check states.
    for (let page = 0; page < 10; page += 1) {
      const response = await run(cursor);
      served.push(...response.items.map((item) => item.id));
      cursor = response.nextCursor;
      if (!cursor) break;
    }

    expect(served).toEqual(ids);
    expect(new Set(served).size).toBe(ids.length);
    expect(cursor).toBeUndefined();
  });
});
