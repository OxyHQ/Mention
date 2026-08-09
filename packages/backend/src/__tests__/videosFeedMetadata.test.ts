/**
 * The Videos feed's METADATA OPTIONS — orientation and minimum duration —
 * against a real database, plus the portrait-first ordering the Reels surface
 * depends on.
 *
 * ## Why the old shape had to go
 *
 * This suite used to assert the `$elemMatch` sub-object `buildVideosQuery`
 * produced (`elemMatch.orientation === 'portrait'`, `$or` containing
 * `{durationSec: {$gte: 20}}`). There is no query object any more, and even when
 * there was, the shape could not answer the only question that matters: does a
 * landscape clip appear in a portrait feed?
 *
 * The portrait-first ORDERING case was worse. It defined its own comparator
 * inside the test and then sorted three literals with it — a closed loop that
 * would stay green if `FeedEngine` stopped preferring portrait entirely. It is
 * replaced by a run of the real engine over the real `videos` source, with
 * ranking pinned to a TIE so the portrait preference is the only thing that can
 * decide the order.
 *
 * ## Division of labour with its two sibling files
 *
 * - `videosFeed.test.ts` pins the BASE predicate (public / published / not a
 *   boost / a video row with real dimensions).
 * - `videosQueryUnknownMetadata.test.ts` pins the "unknown is not a value" rule
 *   that governs an ABSENT duration or orientation.
 * - This file pins what the OPTIONS do when the metadata IS present, and the
 *   ordering that follows.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { MtnConfig, PostType, PostVisibility } from '@mention/shared-types';
import type { MediaItem } from '@mention/shared-types';

// Collaborator substitutions, NOT query-shape mocks: ranking is pinned to a tie
// so the portrait preference is measurable, slicing is one-slice-per-post so a
// row maps to a row, and hydration would otherwise reach Oxy over the network.
// Every id asserted below is a real row read back out of Postgres.
const rankPosts = vi.fn(async (candidates: Array<Record<string, unknown>>) => {
  for (const candidate of candidates) candidate.finalScore = 1;
  return candidates;
});
vi.mock('../services/FeedRankingService', () => ({
  feedRankingService: { rankPosts: (...args: unknown[]) => rankPosts(...(args as Parameters<typeof rankPosts>)) },
}));

vi.mock('../services/ThreadSlicingService', () => ({
  threadSlicingService: {
    sliceFeed: vi.fn(async (candidates: Array<{ id: string }>) => ({
      slices: candidates.map((post) => ({
        _sliceKey: post.id,
        items: [{ post, isThreadParent: false, isThreadChild: false, isThreadLastChild: false }],
        isIncompleteThread: false,
      })),
      additionalPostIds: [],
    })),
  },
}));

vi.mock('../services/PostHydrationService', () => ({
  postHydrationService: {
    hydrateSlices: vi.fn(async (slices: unknown[]) => slices),
    hydratePosts: vi.fn(async (records: unknown[]) => records),
  },
  resolveUserSummaries: vi.fn(async () => new Map()),
}));

import { closePostgres, connectPostgres, type Database } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { CHRONO_DESC, findPostRecords, insertPostRecord } from '../db/posts/postRepository';
import type { PostRecordInput } from '../db/posts/postRecord';
import { FeedQueryBuilder, type VideosQueryOptions } from '../utils/feedQueryBuilder';
import { videosSource } from '../mtn/feed/engine/sources/discoverySources';
import { FeedEngine } from '../mtn/feed/engine/FeedEngine';
import { FeedModuleRegistry } from '../mtn/feed/engine/FeedModuleRegistry';
import type { FeedDefinition, FeedEngineContext } from '../mtn/feed/engine/types';
import { sameMillisecondIds } from './helpers/tiedIds';

let db: Database;

/** Unique to this file: the suite runs in parallel against ONE database. */
const AUTHOR = 'videos-metadata-author';
/** A second author so `diversifyByAuthor` cannot be what decides the order. */
const OTHER_AUTHOR = 'videos-metadata-author-2';

function video(overrides: Partial<MediaItem> & { id: string }): MediaItem {
  return { type: 'video', width: 1080, height: 1920, ...overrides };
}

async function create(
  media: MediaItem[],
  overrides: Partial<PostRecordInput> = {},
): Promise<string> {
  const input: PostRecordInput = {
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.VIDEO,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'clip' }], media },
    ...overrides,
  };
  const record = await insertPostRecord(input);
  return record.id;
}

/** Ids the predicate admits, scoped to this file's authors. */
async function admitted(options: VideosQueryOptions): Promise<string[]> {
  const records = await findPostRecords(
    and(
      FeedQueryBuilder.buildVideosQuery([], options),
      inArray(posts.oxyUserId, [AUTHOR, OTHER_AUTHOR]),
    ),
    { orderBy: CHRONO_DESC },
  );
  return records.map((record) => record.id).sort();
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  vi.clearAllMocks();
  await db.delete(posts).where(inArray(posts.oxyUserId, [AUTHOR, OTHER_AUTHOR]));
});

afterAll(async () => {
  await closePostgres();
});

describe('the orientation option', () => {
  /**
   * Four posts, one per stored orientation plus one with none, inserted once per
   * case so each assertion is an exact set over a KNOWN universe. A predicate
   * that admits too much and a predicate that admits too little both fail.
   */
  async function orientationFixtures() {
    return {
      portrait: await create([video({ id: 'm-portrait', orientation: 'portrait', durationSec: 30 })]),
      landscape: await create([
        video({ id: 'm-landscape', width: 1920, height: 1080, orientation: 'landscape', durationSec: 30 }),
      ]),
      square: await create([
        video({ id: 'm-square', width: 1080, height: 1080, orientation: 'square', durationSec: 30 }),
      ]),
      unset: await create([video({ id: 'm-unset', durationSec: 30 })]),
    };
  }

  it('defaults to portrait — the Reels surface is portrait-first', async () => {
    const { portrait } = await orientationFixtures();
    expect(MtnConfig.videosFeed.defaultOrientation).toBe('portrait');
    expect(await admitted({})).toEqual([portrait]);
  });

  it.each(['portrait', 'landscape', 'square'] as const)(
    'restricts to %s when asked for it explicitly',
    async (orientation) => {
      const fixtures = await orientationFixtures();
      expect(await admitted({ orientation })).toEqual([fixtures[orientation]]);
    },
  );

  it("applies NO orientation filter for 'all', including to a video that has none", async () => {
    /**
     * `'all'` is the one setting whose NAME promises there is no filter, so the
     * post whose orientation was never persisted has to come back too. The
     * regression this replaces emitted `{$exists: true}` for `'all'` — still a
     * filter, and one that quietly required the column to be populated.
     */
    const { portrait, landscape, square, unset } = await orientationFixtures();
    expect(await admitted({ orientation: 'all' })).toEqual(
      [portrait, landscape, square, unset].sort(),
    );
  });

  it("still requires real dimensions under 'all', which the player needs for layout", async () => {
    const sized = await create([video({ id: 'm-sized', orientation: 'landscape', width: 1920, height: 1080 })]);
    await create([{ id: 'm-no-width', type: 'video', height: 1080, orientation: 'landscape' }]);
    await create([{ id: 'm-no-height', type: 'video', width: 1920, orientation: 'landscape' }]);
    await create([{ id: 'm-no-dimensions', type: 'video', orientation: 'landscape' }]);

    expect(await admitted({ orientation: 'all' })).toEqual([sized]);
  });
});

describe('the minimum-duration option', () => {
  it('carries the configured minimum through rather than a hardcoded one', async () => {
    const tenSeconds = await create([video({ id: 'm-10s', orientation: 'portrait', durationSec: 10 })]);
    const thirtySeconds = await create([video({ id: 'm-30s', orientation: 'portrait', durationSec: 30 })]);

    expect(await admitted({ minDurationSec: 7 })).toEqual([tenSeconds, thirtySeconds].sort());
    expect(await admitted({ minDurationSec: 20 })).toEqual([thirtySeconds]);
    expect(await admitted({ minDurationSec: 40 })).toEqual([]);
  });

  it('treats the minimum as inclusive at the boundary', async () => {
    const exactly = await create([
      video({ id: 'm-exact', orientation: 'portrait', durationSec: MtnConfig.videosFeed.minDurationSec }),
    ]);
    const justUnder = await create([
      video({
        id: 'm-under',
        orientation: 'portrait',
        durationSec: MtnConfig.videosFeed.minDurationSec - 0.5,
      }),
    ]);

    const ids = await admitted({});
    expect(ids).toEqual([exactly]);
    expect(ids).not.toContain(justUnder);
  });

  it('keeps the public / published / non-boost base match under any override', async () => {
    // The options widen the CONTENT predicate; they must never relax the base.
    const visible = await create([video({ id: 'm-ok', durationSec: 30 })]);
    await create([video({ id: 'm-private', durationSec: 30 })], { visibility: PostVisibility.PRIVATE });
    await create([video({ id: 'm-draft', durationSec: 30 })], { status: 'draft' });
    const original = await create([video({ id: 'm-original', durationSec: 30 })]);
    await create([video({ id: 'm-boost', durationSec: 30 })], {
      type: PostType.BOOST,
      boostOf: original,
    });

    expect(await admitted({ orientation: 'all', minDurationSec: 1 })).toEqual(
      [visible, original].sort(),
    );
  });
});

describe('portrait-first ordering on the served page', () => {
  /**
   * Shaped like `videosDefinition`. `id: 'videos'` is load-bearing — the
   * portrait preference in `FeedEngine.finalizeRanked` is keyed on it, so a feed
   * that renamed itself would silently lose the preference, and this fixture
   * would catch that.
   */
  const definition: FeedDefinition = {
    id: 'videos',
    title: 'Videos',
    mode: 'ranked',
    sources: [{ module: 'videos', enabled: true }],
    signals: [],
    filters: [],
    execution: { threadGrouping: false, replyContext: false, hydrateMaxDepth: 0 },
  };

  async function emittedIds(mine: readonly string[]): Promise<string[]> {
    const registry = new FeedModuleRegistry();
    registry.register(videosSource);
    const page = await new FeedEngine(registry).run(
      definition,
      { videoFilters: { orientation: 'all' } } as FeedEngineContext,
      { limit: 50 },
    );
    // Restricted to this file's fixtures: a concurrent suite's video posts are
    // legitimately in the same feed, and they are not what is under test.
    return page.slices
      .flatMap((slice) => slice.items.map((item) => item.post.id))
      .filter((id) => mine.includes(id));
  }

  /**
   * THE LANDSCAPE POST CARRIES THE HIGHER ID, AND THAT IS THE ENTIRE TEST.
   *
   * On a ranking tie `finalizeRanked` falls through to
   * `readCandidateId(b).localeCompare(readCandidateId(a))` — DESCENDING id — so
   * giving the landscape clip the higher id makes the tiebreak alone produce
   * `[landscape, portrait]`. The assertion is the OPPOSITE order, so it can only
   * pass if the portrait preference did the work.
   *
   * The ids are SUPPLIED rather than left to insertion order, and that is a
   * correctness fix rather than tidying. `uuidv7()` has no monotonic counter, so
   * two rows written back to back share a millisecond and order on their RANDOM
   * tail — "insert the portrait first" therefore bought this control only about
   * half the time, and the other half the id tiebreak agreed with the assertion
   * and it passed whether or not the preference existed. That failure mode is
   * GREEN, not red: nothing reports a check that has stopped discriminating.
   *
   * Mutation-tested — renaming the definition away from `videos` (the id the
   * preference is keyed on) had to make this go RED, and with the ids pinned this
   * way it does on every run rather than half of them.
   */
  it('emits a portrait clip before a landscape one when ranking ties', async () => {
    const [portraitId, landscapeId] = sameMillisecondIds(2);
    const portrait = await create([video({ id: 'm-port', orientation: 'portrait', durationSec: 30 })], {
      id: portraitId,
    });
    const landscape = await create(
      [video({ id: 'm-land', width: 1920, height: 1080, orientation: 'landscape', durationSec: 30 })],
      {
        id: landscapeId,
        oxyUserId: OTHER_AUTHOR,
        authorship: [{ oxyUserId: OTHER_AUTHOR, role: 'owner', status: 'accepted' }],
      },
    );

    // The control, stated rather than assumed: the id tiebreak alone would say
    // `[landscape, portrait]`, so the expected order below is the one only the
    // portrait preference can produce.
    expect(landscape > portrait).toBe(true);
    expect(await emittedIds([portrait, landscape])).toEqual([portrait, landscape]);
    expect(rankPosts).toHaveBeenCalled();
  });

  it('does not treat a portrait IMAGE as a portrait video', async () => {
    // `hasPortraitVideo` requires BOTH `type: 'video'` and the orientation. A
    // post carrying a portrait image alongside a landscape clip is landscape as
    // far as the Reels surface is concerned — so the genuinely portrait clip
    // still leads despite carrying the LOWER id, which the descending-id tiebreak
    // would otherwise place second. Supplied for the same reason as the case
    // above: minting order does not decide id order.
    const [portraitId, landscapeId] = sameMillisecondIds(2);
    const trulyPortrait = await create(
      [video({ id: 'm-tall-video', orientation: 'portrait', durationSec: 30 })],
      { id: portraitId },
    );
    const imagePlusLandscape = await create(
      [
        video({ id: 'm-wide', width: 1920, height: 1080, orientation: 'landscape', durationSec: 30 }),
        { id: 'm-tall-photo', type: 'image', width: 1080, height: 1920, orientation: 'portrait' },
      ],
      {
        id: landscapeId,
        oxyUserId: OTHER_AUTHOR,
        authorship: [{ oxyUserId: OTHER_AUTHOR, role: 'owner', status: 'accepted' }],
      },
    );

    expect(imagePlusLandscape > trulyPortrait).toBe(true);
    expect(await emittedIds([trulyPortrait, imagePlusLandscape])).toEqual([
      trulyPortrait,
      imagePlusLandscape,
    ]);
  });
});

describe('the videos source composes the predicate with the discovery safety gate', () => {
  it('withholds a sensitive video from the ranked pool', async () => {
    // The source ANDs `discoverySafeSql()` onto the content predicate. Asserting
    // it here rather than in `feedSafety`'s own suite is deliberate: the question
    // is whether THIS source wired the gate up, which a safety-module test cannot
    // answer.
    const safe = await create([video({ id: 'm-safe', orientation: 'portrait', durationSec: 30 })]);
    const sensitive = await create([video({ id: 'm-nsfw', orientation: 'portrait', durationSec: 30 })], {
      metadata: { isSensitive: true },
    });

    const pool = await videosSource.gather({} as FeedEngineContext, {}, 500);
    const mine = pool.map((candidate) => candidate.id).filter((id) => [safe, sensitive].includes(id));
    expect(mine).toEqual([safe]);
  });
});
