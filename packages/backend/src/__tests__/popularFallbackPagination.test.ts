/**
 * The popular sources' KEYSET, walked against a real database.
 *
 * The popular sources are BOTH the anonymous For You / Videos / Media feeds and
 * the authenticated never-blank fallback, so they are handed whatever cursor the
 * ranked feed last emitted. Two halves of one contract:
 *
 *  1. a page is continued on the axis the source SORTS on —
 *     `{engagementScore, createdAt, id}` — so an adjacent pair of pages can
 *     neither repeat an item nor skip past one;
 *  2. that sort is TOTAL, so the position the cursor names actually exists.
 *
 * Before this was fixed, `popularSource` accepted a cursor only when the whole
 * string parsed as an ObjectId. A `ScoreCursor` never does, so every fallback
 * page was page ONE: an authenticated viewer past their unseen pool got the same
 * most-engaged posts over and over with `hasMore: true`. The video/media
 * fallbacks failed the other way — they fed the cursor into `buildVideosQuery`,
 * which applied an `_id` bound under an engagement sort, repeating high-engagement
 * posts while permanently skipping newer, less-engaged ones.
 *
 * ## Why this is now a row walk rather than a pipeline assertion
 *
 * The predecessor asserted the Mongo pipeline: `clauses[0]` equals
 * `{engagementScore: {$lt: 9.25}}`, `sortStages()` keys are exactly
 * `['engagementScore','createdAt','_id']`. Both of those are TRUE of a query that
 * skips a row at every page boundary, because a keyset's correctness is a
 * property of the WALK, not of any single query. It also could not see the fault
 * that was actually live in the port: `popularKeysetSql` interpolated a JS `Date`
 * into a `sql` template, which postgres.js rejects client-side with
 * `TypeError … Received an instance of Date`. Shape-perfect, and every page two
 * of every popular feed 500'd.
 *
 * ## The fixture, and why it is shaped this way
 *
 * Six posts whose sort keys are DELIBERATELY TIED at two different levels: a pair
 * tied on `engagementScore` but not on `created_at`, and a pair tied on BOTH. A
 * pool with distinct keys cannot tell a correct three-key keyset from a
 * score-only one — both walk it perfectly. The ties are what make the second and
 * third keys observable.
 *
 * ## Isolation
 *
 * Test files run in parallel against ONE database, and the popular sources have
 * either no content predicate at all or a broad one, so a concurrent suite's
 * posts are legitimately in the same result. Every assertion therefore filters to
 * this file's own ids, and the walk continues until they have all been seen. That
 * is not a weakening: a concurrent insert can only ever appear at a position the
 * walk has not passed yet, and the keys of THIS file's rows never change, so a
 * genuine skip or repeat still shows up as a wrong concatenation.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';
import type { MediaItem } from '@mention/shared-types';

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

import { closePostgres, connectPostgres, type Database } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { insertPostRecord } from '../db/posts/postRepository';
import type { PostRecordInput } from '../db/posts/postRecord';
import { ScoreCursor } from '../mtn/feed/CursorBuilder';
import {
  popularSource,
  popularVideosSource,
  popularMediaSource,
} from '../mtn/feed/engine/sources/discoverySources';
import { FeedEngine } from '../mtn/feed/engine/FeedEngine';
import { FeedModuleRegistry } from '../mtn/feed/engine/FeedModuleRegistry';
import type { FeedDefinition, FeedEngineContext, SourceModule } from '../mtn/feed/engine/types';

let db: Database;
const created: string[] = [];

const AUTHOR = 'popular-pagination-author';

/**
 * Inside the narrowest recency window `fetchWithRecencyFallback` tries first
 * (7 days), so the fixtures are reachable without widening.
 */
const NOW = Date.now();
const RECENT = new Date(NOW - 60 * 60 * 1000);
const OLDER = new Date(NOW - 3 * 60 * 60 * 1000);

const PORTRAIT_VIDEO: MediaItem = {
  id: 'popular-media-video',
  type: 'video',
  width: 1080,
  height: 1920,
  durationSec: 30,
  orientation: 'portrait',
};

/**
 * The three popular sources and the CONTENT each needs to qualify for it. Driving
 * one table over all three is the point: they share `popularKeysetSql` and
 * `popularOrder`, and a fix applied to one of them only is exactly the shape of
 * bug this file exists to catch.
 */
const SOURCES: ReadonlyArray<{
  name: string;
  source: SourceModule;
  content: () => Partial<PostRecordInput>;
}> = [
  { name: 'popular', source: popularSource, content: () => ({}) },
  {
    name: 'popularVideos',
    source: popularVideosSource,
    content: () => ({
      type: PostType.VIDEO,
      content: { variants: [{ source: 'author', text: 'clip' }], media: [PORTRAIT_VIDEO] },
    }),
  },
  {
    name: 'popularMedia',
    source: popularMediaSource,
    content: () => ({ type: PostType.IMAGE }),
  },
];

async function create(
  likes: number,
  createdAt: Date,
  content: Partial<PostRecordInput>,
): Promise<string> {
  const input: PostRecordInput = {
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'popular' }] },
    createdAt,
    ...content,
  };
  const record = await insertPostRecord(input);
  created.push(record.id);
  // `stats` is owned by the engagement batch and is not part of
  // `PostRecordInput`, so a ranking fixture writes the column directly.
  await db.update(posts).set({ statsLikesCount: likes }).where(inArray(posts.id, [record.id]));
  return record.id;
}

/**
 * Six posts in the order the popular sort must produce them.
 *
 * - `top` / `second`: distinct engagement.
 * - `sameScoreNewer` / `sameScoreOlder`: TIED on engagement, split by `created_at`.
 * - `tiedLater` / `tiedEarlier`: tied on engagement AND `created_at`, split by id
 *   descending (uuid v7 is monotonic, so the later insert leads).
 */
async function pool(content: Partial<PostRecordInput>): Promise<string[]> {
  const top = await create(50, RECENT, content);
  const second = await create(40, RECENT, content);
  const sameScoreOlder = await create(30, OLDER, content);
  const sameScoreNewer = await create(30, RECENT, content);
  const tiedEarlier = await create(10, RECENT, content);
  const tiedLater = await create(10, RECENT, content);
  return [top, second, sameScoreNewer, sameScoreOlder, tiedLater, tiedEarlier];
}

function definitionFor(sourceId: string): FeedDefinition {
  return {
    id: 'for_you',
    title: 'For You',
    mode: 'ranked',
    sources: [{ module: sourceId, enabled: true }],
    signals: [],
    filters: [],
    // An ANONYMOUS viewer plus a `popularFallback` routes `run` straight to
    // `runPopularFallback`, which is the path that mints the keyset cursor.
    execution: { popularFallback: sourceId, neverBlank: true, hydrateMaxDepth: 0 },
  };
}

/**
 * Walk the fallback with the engine's own cursors until every expected id has
 * been served, returning the pages restricted to this file's rows.
 *
 * The bound exists only so a broken keyset fails as an assertion rather than as a
 * hang; reaching it is itself a failure, asserted by the caller.
 */
async function walk(
  source: SourceModule,
  expected: readonly string[],
  limit: number,
): Promise<{ pages: string[][]; exhausted: boolean }> {
  const registry = new FeedModuleRegistry();
  registry.register(source);
  const engine = new FeedEngine(registry);
  const definition = definitionFor(source.id);

  const pages: string[][] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < 60; page += 1) {
    const response = await engine.run(definition, {} as FeedEngineContext, { limit, cursor });
    const mine = response.items.map((item) => item.id).filter((id) => expected.includes(id));
    pages.push(mine);
    for (const id of mine) seen.add(id);
    cursor = response.nextCursor;
    if (seen.size === expected.length || !cursor || !response.hasMore) break;
  }

  return { pages, exhausted: seen.size === expected.length };
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

describe('the ScoreCursor keyset payload', () => {
  const ANCHOR = '019fb000-0000-7000-8000-000000000001';
  const OTHER = '019fb000-0000-7000-8000-000000000002';

  it('round-trips the createdAt boundary the popular sort needs', () => {
    const cursor = ScoreCursor.build(12.5, ANCHOR, {
      asOf: NOW,
      tiebreakAt: NOW,
      fromPopularFallback: true,
    });
    expect(ScoreCursor.parse(cursor)).toMatchObject({
      score: 12.5,
      id: ANCHOR,
      asOf: NOW,
      tiebreakAt: NOW,
    });
  });

  it('keeps carrying the rolling exclusion list alongside it', () => {
    const cursor = ScoreCursor.build(3, ANCHOR, { asOf: NOW, tiebreakAt: NOW, excludeIds: [OTHER] });
    expect(ScoreCursor.parse(cursor)?.excludeIds).toContain(OTHER);
  });

  it('still reads a legacy cursor that predates the boundary, without inventing one', () => {
    const legacy = ScoreCursor.parse(`7:${ANCHOR}`);
    expect(legacy).toMatchObject({ score: 7, id: ANCHOR });
    expect(legacy?.tiebreakAt).toBeUndefined();
  });

  it('reads a bare id as "no keyset", not as a score of zero', () => {
    // A score of zero would be a REAL bound that filters out every zero-engagement
    // post; `Infinity` is what makes the caller treat it as "no keyset at all".
    const parsed = ScoreCursor.parse(ANCHOR);
    expect(parsed?.id).toBe(ANCHOR);
    expect(parsed?.score).toBe(Infinity);
  });
});

describe.each(SOURCES)('$name pagination', ({ source, content }) => {
  it('serves the pool in engagement, then createdAt, then id order', async () => {
    const expected = await pool(content());
    const candidates = await source.gather({} as FeedEngineContext, {}, 500);
    const mine = candidates.map((candidate) => candidate.id).filter((id) => expected.includes(id));
    expect(mine).toEqual(expected);
  });

  it('walks adjacent pages that neither overlap nor gap', async () => {
    const expected = await pool(content());
    const { pages, exhausted } = await walk(source, expected, 2);

    // The walk reached every fixture rather than running out of page budget —
    // without this a keyset that stalls after page one would still "pass" the
    // concatenation check on a prefix.
    expect(exhausted).toBe(true);

    // NO OVERLAP: no id is served twice, anywhere in the walk.
    const served = pages.flat();
    expect(new Set(served).size).toBe(served.length);
    // NO GAP, and the order is the one the sort promises. This is the assertion a
    // score-only keyset fails: it drops the sibling tied at the same score.
    expect(served).toEqual(expected);
    // Adjacent pages specifically, stated so a failure names the boundary.
    for (let i = 1; i < pages.length; i += 1) {
      expect(pages[i].filter((id) => pages[i - 1].includes(id))).toEqual([]);
    }
  });

  it('refuses to keyset on a legacy cursor it cannot fully express', async () => {
    /**
     * A bare id cannot say which score or `created_at` the previous page stopped
     * at. Filtering on `id` anyway is the original defect, so the correct
     * behaviour is to lean on the cursor's bounded exclusion list for one page
     * rather than bound an axis nothing sorts by — which shows up here as the
     * FULL pool coming back, minus only the cursor row.
     */
    const expected = await pool(content());
    const anchor = expected[2];

    const candidates = await source.gather({ cursor: anchor } as FeedEngineContext, {}, 500);
    const mine = candidates.map((candidate) => candidate.id).filter((id) => expected.includes(id));

    expect(mine).toEqual(expected.filter((id) => id !== anchor));
  });

  it('refuses to keyset on a cursor the popular regime did not mint', async () => {
    /**
     * Provenance, at the row level. The score in a ranked cursor is a
     * `finalScore` — a product of near-1 signals — while this source bounds an
     * `engagementScore` that is 0 for most posts and unbounded above. Comparing
     * them empties or no-ops the page depending on which way the mismatch falls.
     * A cursor with a COMPLETE key but no fallback stamp must still be refused.
     */
    const expected = await pool(content());
    const anchor = expected[2];
    const rankedCursor = ScoreCursor.build(1.5, anchor, { asOf: NOW, tiebreakAt: NOW });

    const candidates = await source.gather({ cursor: rankedCursor } as FeedEngineContext, {}, 500);
    const mine = candidates.map((candidate) => candidate.id).filter((id) => expected.includes(id));

    // Unfiltered but for the cursor row's own exclusion — a `finalScore` of 1.5
    // used as an engagement bound would have cut the pool down to the two
    // zero-ish tail posts.
    expect(mine).toEqual(expected.filter((id) => id !== anchor));
  });

  it('excludes the ids the cursor is carrying', async () => {
    const expected = await pool(content());
    const [anchor, dropped] = expected;
    const cursor = ScoreCursor.build(Number.MAX_SAFE_INTEGER, anchor, {
      asOf: NOW,
      tiebreakAt: NOW,
      excludeIds: [dropped],
      fromPopularFallback: true,
    });

    const candidates = await source.gather({ cursor } as FeedEngineContext, {}, 500);
    const mine = candidates.map((candidate) => candidate.id).filter((id) => expected.includes(id));

    expect(mine).toEqual(expected.filter((id) => id !== anchor && id !== dropped));
  });

  it('excludes what the viewer has already been shown', async () => {
    /**
     * `popularSource` builds its match by hand rather than through a query
     * builder and was the only fallback that never threaded the seen set — so the
     * FIRST fallback page could re-serve exactly the posts the ranked pages had
     * just exhausted, which is the most visible possible moment to repeat
     * yourself. Asserted for all three so the omission cannot come back to one.
     */
    const expected = await pool(content());
    const seen = [expected[0], expected[3]];

    const candidates = await source.gather({ seenPostIds: seen } as FeedEngineContext, {}, 500);
    const mine = candidates.map((candidate) => candidate.id).filter((id) => expected.includes(id));

    expect(mine).toEqual(expected.filter((id) => !seen.includes(id)));
  });

  it('withholds sensitive posts from the fallback, like every discovery lane', async () => {
    // `ForYouFeed.fetchPopular` once shipped WITHOUT this filter and leaked NSFW
    // into For You. The fallback is a discovery lane and is gated like one.
    const safe = await create(50, RECENT, content());
    const sensitive = await create(60, RECENT, { ...content(), metadata: { isSensitive: true } });

    const candidates = await source.gather({} as FeedEngineContext, {}, 500);
    const mine = candidates
      .map((candidate) => candidate.id)
      .filter((id) => [safe, sensitive].includes(id));
    expect(mine).toEqual([safe]);
  });
});
