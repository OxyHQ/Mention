/**
 * The TWO pagination regimes a `neverBlank` ranked feed runs, and the routing
 * between them — walked against a real database.
 *
 * One cursor type carries two quantities that are not comparable:
 *
 *  - the RANKED regime cursors on `finalScore`, a product of near-1
 *    multiplicative ranking signals;
 *  - the POPULAR FALLBACK regime cursors on `engagementScore`, a weighted sum of
 *    likes/boosts/comments that is 0 for most posts and unbounded above.
 *
 * Once `videos` and `for_you` gained `neverBlank`, a page served by the fallback
 * handed the NEXT request a cursor carrying an engagement score, and the ranked
 * path compared it against `finalScore` as though the two were one quantity. A
 * fallback anchor of 0 filters out every ranked candidate and the feed
 * dead-ends; a fallback anchor of 50 makes the window a no-op and silently
 * restarts the ranked feed at page ONE, with only the seen set standing between
 * the viewer and the posts they just read.
 *
 * The fix is PROVENANCE, not arithmetic: the cursor records that the fallback
 * minted it, the router keeps that cursor chain in the fallback, and the ranked
 * score window declines to compare. See `ScoreCursorData.fromPopularFallback`.
 *
 * ## What this file owns, and what it deliberately does not
 *
 * This is the REGIME file: the cursor's provenance stamp, and the ENGINE's
 * routing decision between the two regimes. The popular sources' own keyset —
 * that a fallback page is continued on the `{engagementScore, createdAt, id}`
 * axis it sorts by, and that `popularKeysetSql` refuses a cursor it cannot fully
 * express — belongs to `popularFallbackPagination.test.ts`, which walks all three
 * popular sources. The overlap is one walk, kept here on purpose because the
 * property is different: this one walks the fallback WHILE A RANKED LANE IS
 * AVAILABLE, which is what the router has to keep declining.
 *
 * Deleted with the Mongo port: a describe that read the built aggregation and
 * asserted `clauses[0]` equals `{engagementScore: {$lt: 9.25}}`. There is no
 * pipeline to read, and a shape assertion could not tell a correct keyset from
 * one that skips a row at every boundary — its row-level successor is the
 * provenance case in `popularFallbackPagination.test.ts`.
 *
 * ## The fixture, and why the two lanes cannot be confused
 *
 * The RANKED lane is TEXT posts, so it can never qualify for the videos content
 * predicate the fallback scans on. The FALLBACK lane is video posts whose
 * engagement is orders of magnitude above anything another suite writes, so the
 * global engagement sort puts them first even though this database is shared
 * with every other test file. Every assertion is then restricted to this file's
 * own ids.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';
import type { MediaItem } from '@mention/shared-types';

/**
 * Deterministic stand-in for `FeedRankingService`: LIKES ARE THE SCORE.
 *
 * The real service reads `UserBehavior` from Mongo and the viewer's follow graph
 * from Oxy, so it cannot run here. Scoring off a real column keeps the ranked
 * lane's order a property of the rows — and keeps every ranked score a small
 * number, orders of magnitude below the engagement sums the fallback cursors on.
 * That mismatch of scales IS the defect under test.
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
// A non-empty `slices` is also how a RANKED page is told apart from a fallback
// one, which serves flat `items` and no slices at all.
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
// a pass-through, so every id asserted below is a real row read out of Postgres,
// and the cursor between pages is minted by the REAL `buildPopularCursor`.
vi.mock('../services/PostHydrationService', () => ({
  postHydrationService: {
    hydrateSlices: vi.fn(async (slices: unknown[]) => slices),
    hydratePosts: vi.fn(async (records: unknown[]) => records),
  },
  resolveUserSummaries: vi.fn(async () => new Map()),
}));

// An empty seen set on every page: the regime the engine picks must not depend
// on a Redis-backed cache that survives between tests.
vi.mock('../services/FeedSeenPostsService', () => ({
  feedSeenPostsService: {
    getSeenPostIds: vi.fn(async () => []),
    markPostsAsSeen: vi.fn(async () => undefined),
  },
}));

import { closePostgres, connectPostgres, type Database } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { insertPostRecord, loadPostRecords } from '../db/posts/postRepository';
import type { PostRecordInput } from '../db/posts/postRecord';
import { ScoreCursor } from '../mtn/feed/CursorBuilder';
import { popularVideosSource } from '../mtn/feed/engine/sources/discoverySources';
import { FeedEngine } from '../mtn/feed/engine/FeedEngine';
import { FeedModuleRegistry } from '../mtn/feed/engine/FeedModuleRegistry';
import type {
  CandidatePost,
  FeedDefinition,
  FeedEngineContext,
  SourceModule,
} from '../mtn/feed/engine/types';

let db: Database;
const created: string[] = [];

const PAGE = 3;

/** Two instants, so the fallback fixtures can tie on score and still be ordered. */
const RECENT = new Date(Date.now() - 60 * 60 * 1000);
const OLDER = new Date(Date.now() - 3 * 60 * 60 * 1000);

/** Every field the default videos predicate requires. */
const PORTRAIT_VIDEO: MediaItem = {
  id: 'fallback-regime-video',
  type: 'video',
  width: 1080,
  height: 1920,
  durationSec: 30,
  orientation: 'portrait',
};

async function create(
  author: string,
  likes: number,
  createdAt: Date,
  overrides: Partial<PostRecordInput>,
): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: author,
    authorship: [{ oxyUserId: author, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'body' }] },
    createdAt,
    ...overrides,
  });
  created.push(record.id);
  // `stats` is owned by the engagement batch and is not part of
  // `PostRecordInput`, so a ranking fixture writes the column directly.
  await db.update(posts).set({ statsLikesCount: likes }).where(eq(posts.id, record.id));
  return record.id;
}

/**
 * The RANKED lane: six TEXT posts with distinct engagement, each by its own
 * author.
 *
 * TEXT so they can never appear in the fallback's video scan — the two lanes
 * must be tellable apart by id alone. One author each because
 * `diversifyByAuthor` reorders a page to space same-author slices, and the page
 * boundary here must be decided by the score window, not by the reranker.
 *
 * Returned in the order ranking must produce: likes descending.
 */
async function rankedLane(): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    ids.push(await create(`fallback-regime-ranked-${index}`, 6 - index, RECENT, {}));
  }
  return ids;
}

/**
 * The FALLBACK lane: six video posts in the order the popular sort must produce
 * them.
 *
 * Their sort keys are deliberately TIED at two levels — a pair tied on
 * engagement but split by `created_at`, and a pair tied on BOTH and split only
 * by id — because a pool with distinct keys cannot tell a correct three-key
 * keyset from a score-only one; both walk it perfectly.
 *
 * The engagement is far above the largest value any other suite writes, so these
 * rows lead the GLOBAL engagement sort the real `popularVideosSource` runs.
 */
async function fallbackLane(): Promise<string[]> {
  const author = 'fallback-regime-popular';
  const video: Partial<PostRecordInput> = {
    type: PostType.VIDEO,
    content: { variants: [{ source: 'author', text: 'clip' }], media: [PORTRAIT_VIDEO] },
  };

  const top = await create(author, 50_000, RECENT, video);
  const second = await create(author, 40_000, RECENT, video);
  const sameScoreNewer = await create(author, 30_000, RECENT, video);
  const sameScoreOlder = await create(author, 30_000, OLDER, video);
  const tiedEarlier = await create(author, 20_000, RECENT, video);
  const tiedLater = await create(author, 20_000, RECENT, video);

  // uuid v7 is monotonic, so the later insert leads the pair tied on both keys.
  return [top, second, sameScoreNewer, sameScoreOlder, tiedLater, tiedEarlier];
}

/**
 * The ranked lane as a source module, serving REAL rows by id.
 *
 * A stand-in, and deliberately so: what varies between the pages below is
 * whether the ranked lane HAS material at all (its pool refilled, or the seen
 * set aged out), and that is a state of the world the router reacts to rather
 * than anything a query expresses. The rows themselves are read out of Postgres.
 */
function rankedSource(ids: readonly string[]): SourceModule {
  return {
    id: 'videos',
    kind: 'source',
    userComposable: false,
    gather: async () => loadPostRecords([...ids]),
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

/** An engine whose ranked lane serves `rankedIds` and whose fallback is the REAL source. */
function engineWithRankedLane(rankedIds: readonly string[]): FeedEngine {
  const registry = new FeedModuleRegistry();
  registry.register(rankedSource(rankedIds));
  registry.register(popularVideosSource);
  return new FeedEngine(registry);
}

const VIEWER: FeedEngineContext = { currentUserId: 'fallback-regime-viewer' };

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

describe('the fallback stamp a ScoreCursor carries', () => {
  const ANCHOR = '019fb100-0000-7000-8000-000000000001';

  it('records that the popular fallback minted it', () => {
    const cursor = ScoreCursor.build(50, ANCHOR, {
      asOf: Date.now(),
      tiebreakAt: Date.now(),
      fromPopularFallback: true,
    });
    expect(ScoreCursor.parse(cursor)?.fromPopularFallback).toBe(true);
  });

  it('leaves a ranked cursor unstamped, so absence means "not the fallback"', () => {
    // The ranked path mints the LEGACY `score:id` form, which has no metadata
    // envelope to stamp — absence is the only signal it can carry.
    expect(ScoreCursor.parse(ScoreCursor.build(1.5, ANCHOR))?.fromPopularFallback).toBeUndefined();
  });

  it('still parses a legacy cursor, which predates the stamp entirely', () => {
    const legacy = ScoreCursor.parse(`7:${ANCHOR}`);
    expect(legacy).toMatchObject({ score: 7, id: ANCHOR });
    expect(legacy?.fromPopularFallback).toBeUndefined();
  });

  it('does not stamp a cursor the fallback did not mint, even with a full keyset', () => {
    /**
     * The case a `tiebreakAt`-presence check cannot distinguish. No ranked feed
     * mints a `tiebreakAt` today, so a completeness check excluded this by luck;
     * a ranked sort that gained a `createdAt` tiebreak would have started
     * bounding `engagementScore` by a `finalScore` with nothing noticing.
     */
    const cursor = ScoreCursor.build(9.25, ANCHOR, { asOf: Date.now(), tiebreakAt: Date.now() });
    expect(ScoreCursor.parse(cursor)?.tiebreakAt).toBeDefined();
    expect(ScoreCursor.parse(cursor)?.fromPopularFallback).toBeUndefined();
  });
});

describe('a neverBlank feed that has fallen back', () => {
  /**
   * Page one with an EXHAUSTED ranked lane: `neverBlank` serves the popular
   * fallback, and the cursor it hands back carries an ENGAGEMENT score.
   */
  async function fallbackPageOne(fallbackIds: readonly string[]): Promise<string> {
    const page = await engineWithRankedLane([]).run(neverBlankDefinition, VIEWER, { limit: PAGE });

    // The fallback path serves flat `items` and NO slices — a healthy fallback
    // page looks empty to anything measuring `slices.length`.
    expect(page.slices).toHaveLength(0);
    // A concurrent suite's video post can legitimately share the page; only this
    // file's rows are asserted on, and their relative order is what is at stake.
    const ids = page.items.map((item) => item.id).filter((id) => fallbackIds.includes(id));
    expect(ids).toEqual(fallbackIds.slice(0, PAGE));

    const cursor = page.nextCursor;
    expect(cursor).toBeDefined();
    if (!cursor) throw new Error('the fallback page minted no cursor');
    return cursor;
  }

  it("mints a cursor carrying an engagement score, stamped as the fallback's", async () => {
    const fallbackIds = await fallbackLane();
    const parsed = ScoreCursor.parse(await fallbackPageOne(fallbackIds));

    // 30_000 is the third fixture's engagement score (likeWeight is 1.0, so the
    // composite of a like-only post IS its like count). A ranking `finalScore`
    // never reaches this scale — that mismatch is the whole defect.
    expect(parsed?.score).toBe(30_000);
    expect(parsed?.fromPopularFallback).toBe(true);
    // The `created_at` boundary, without which the next page cannot express the
    // full key it sorts on.
    expect(parsed?.tiebreakAt).toBe(RECENT.getTime());
  });

  it('keeps serving the fallback rather than restarting the ranked lane', async () => {
    const fallbackIds = await fallbackLane();
    const rankedIds = await rankedLane();
    const cursor = await fallbackPageOne(fallbackIds);

    // The ranked lane now has material again — the pool refilled, or the seen set
    // aged out. Before provenance the engine took it: a `finalScore` of ~6 is
    // less than the cursor's 30_000, so the score window admitted EVERY ranked
    // candidate and page two was ranked page ONE.
    const page = await engineWithRankedLane(rankedIds).run(neverBlankDefinition, VIEWER, {
      limit: PAGE,
      cursor,
    });

    const ids = page.items.map((item) => item.id);
    expect(ids.filter((id) => fallbackIds.includes(id))).toEqual(fallbackIds.slice(PAGE));
    expect(ids.filter((id) => rankedIds.includes(id))).toEqual([]);
    expect(page.slices).toHaveLength(0);
  });

  it('walks the fallback to exhaustion without repeating or stalling', async () => {
    /**
     * Adjacent pages that neither overlap nor gap, with the ranked lane available
     * at every step — the door has to stay one-way for the whole cursor chain,
     * not just for the first page after the switch.
     */
    const fallbackIds = await fallbackLane();
    const rankedIds = await rankedLane();
    const engine = engineWithRankedLane(rankedIds);

    const pages: string[][] = [fallbackIds.slice(0, PAGE)];
    const served = [...pages[0]];
    let cursor: string | undefined = await fallbackPageOne(fallbackIds);

    // The bound exists so a stalled walk fails as an assertion rather than as a
    // hang; reaching it is itself a failure, which the concatenation states.
    for (let page = 0; page < 10 && cursor; page += 1) {
      const response = await engine.run(neverBlankDefinition, VIEWER, { limit: PAGE, cursor });
      const ids = response.items.map((item) => item.id);
      // A concurrent suite's video post can legitimately share the page; only
      // this file's rows are asserted on, and their keys never change.
      const mine = ids.filter((id) => fallbackIds.includes(id));
      expect(ids.filter((id) => rankedIds.includes(id))).toEqual([]);
      pages.push(mine);
      served.push(...mine);
      cursor = response.nextCursor;
      if (served.length === fallbackIds.length) break;
    }

    // NO GAP, and in the order the three-key sort promises: score, then
    // `created_at`, then id. A score-only keyset drops the sibling tied at the
    // same score; an id-only one repeats the top and skips the tail.
    expect(served).toEqual(fallbackIds);
    // NO OVERLAP, stated per boundary so a failure names the page pair.
    for (let index = 1; index < pages.length; index += 1) {
      expect(pages[index].filter((id) => pages[index - 1].includes(id))).toEqual([]);
    }
  });
});

describe('a fallback cursor outliving the fallback itself', () => {
  /**
   * The router cannot help a definition that no longer HAS a fallback, and
   * clients hold cursors across a config change: drop `popularFallback` from
   * `videosDefinition` and every in-flight fallback cursor arrives at a ranked
   * path with nowhere to be sent. The score window has to refuse the comparison
   * on its own, which is why the guard lives there too and not only in the
   * router.
   *
   * An engagement anchor of 0 is the damaging shape: no ranked candidate scores
   * BELOW zero, so an unguarded window empties the page and the feed dead-ends
   * rather than merely repeating.
   */
  const noFallbackDefinition: FeedDefinition = {
    ...neverBlankDefinition,
    execution: { ...neverBlankDefinition.execution, neverBlank: false, popularFallback: undefined },
  };

  it('serves the ranked page instead of filtering it away on a foreign score', async () => {
    const fallbackIds = await fallbackLane();
    const rankedIds = await rankedLane();

    const staleCursor = ScoreCursor.build(0, fallbackIds[fallbackIds.length - 1], {
      asOf: Date.now(),
      tiebreakAt: RECENT.getTime(),
      fromPopularFallback: true,
    });

    const page = await engineWithRankedLane(rankedIds).run(noFallbackDefinition, VIEWER, {
      limit: PAGE,
      cursor: staleCursor,
    });

    expect(page.items.map((item) => item.id)).toEqual(rankedIds.slice(0, PAGE));
  });
});

describe('a ranked cursor is unaffected', () => {
  it('paginates the ranked lane by its own score window, never entering the fallback', async () => {
    const fallbackIds = await fallbackLane();
    const rankedIds = await rankedLane();
    const engine = engineWithRankedLane(rankedIds);

    const first = await engine.run(neverBlankDefinition, VIEWER, { limit: PAGE });
    const firstIds = first.items.map((item) => item.id);
    expect(firstIds).toEqual(rankedIds.slice(0, PAGE));
    // A RANKED page carries slices; the fallback's does not.
    expect(first.slices).toHaveLength(PAGE);
    expect(ScoreCursor.parse(first.nextCursor)?.fromPopularFallback).toBeUndefined();

    const second = await engine.run(neverBlankDefinition, VIEWER, {
      limit: PAGE,
      cursor: first.nextCursor,
    });
    const secondIds = second.items.map((item) => item.id);

    expect(secondIds).toEqual(rankedIds.slice(PAGE));
    expect(secondIds.filter((id) => firstIds.includes(id))).toEqual([]);
    expect(second.slices).toHaveLength(PAGE);
    // Still the ranked lane: not one row of the fallback pool, whose engagement
    // dwarfs anything here, has leaked in.
    expect(secondIds.filter((id) => fallbackIds.includes(id))).toEqual([]);
  });
});
