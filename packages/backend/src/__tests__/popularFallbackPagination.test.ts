import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * The popular sources are BOTH the anonymous For You / Videos / Media feeds and
 * the authenticated never-blank fallback, so they are handed whatever cursor the
 * ranked feed last emitted — a `ScoreCursor`, not a bare ObjectId.
 *
 * These tests pin the two halves of that contract:
 *
 *  1. the page is continued on the axis the source SORTS on
 *     (`{engagementScore, createdAt, _id}`), so a second page can neither repeat
 *     an item nor skip past one;
 *  2. the sort is TOTAL, so the order the cursor refers to actually exists.
 *
 * Before this was fixed, `popularSource` accepted a cursor only when the entire
 * string parsed as an ObjectId. A `ScoreCursor` never does, so every fallback page
 * was page ONE: an authenticated viewer past their unseen pool got the same
 * most-engaged posts over and over with `hasMore: true`. The video/media fallbacks
 * failed the other way — they passed the cursor into `buildVideosQuery`, which
 * applies an `_id` bound under an engagement sort, repeating high-engagement posts
 * while permanently skipping newer, less-engaged ones.
 *
 * The pipeline Mongo receives is the assertion target, because that is the thing
 * that was wrong; asserting on returned documents would pass against a mock no
 * matter which axis the query filtered on.
 */

const aggregateCalls: unknown[][] = [];
let aggregateResult: Array<Record<string, unknown>> = [];

vi.mock('../models/Post', () => ({
  Post: {
    aggregate: vi.fn((pipeline: unknown[]) => {
      aggregateCalls.push(pipeline);
      return { option: () => Promise.resolve(aggregateResult) };
    }),
    find: vi.fn(() => ({
      select: () => ({
        sort: () => ({ limit: () => ({ maxTimeMS: () => ({ lean: () => Promise.resolve([]) }) }) }),
      }),
    })),
  },
}));

import { ScoreCursor } from '../mtn/feed/CursorBuilder';
import { popularSource, popularVideosSource, popularMediaSource } from '../mtn/feed/engine/sources/discoverySources';
import type { FeedEngineContext } from '../mtn/feed/engine/types';

/** Every stage of the recorded pipeline, flattened across the recency retries. */
function stages(): Array<Record<string, unknown>> {
  return aggregateCalls.flat() as Array<Record<string, unknown>>;
}

function sortStages(): Array<Record<string, number>> {
  return stages()
    .filter((stage) => '$sort' in stage)
    .map((stage) => stage.$sort as Record<string, number>);
}

/** The keyset `$match` — the one that constrains a field the sort orders on. */
function keysetMatches(): Array<Record<string, unknown>> {
  return stages()
    .filter((stage): stage is { $match: Record<string, unknown> } => '$match' in stage)
    .map((stage) => stage.$match)
    .filter((match) => Array.isArray(match.$or)
      && (match.$or as Array<Record<string, unknown>>).some((clause) => 'engagementScore' in clause));
}

function context(overrides: Partial<FeedEngineContext> = {}): FeedEngineContext {
  return { ...overrides } as FeedEngineContext;
}

const BOUNDARY_ID = new mongoose.Types.ObjectId().toString();
const BOUNDARY_AT = Date.UTC(2026, 6, 20, 12, 0, 0);
const NEWER_ID = new mongoose.Types.ObjectId().toString();

/**
 * A cursor of the shape the fallback mints for its OWN next page.
 *
 * This used to be called `rankedCursor` and described as "the shape a ranked feed
 * hands the fallback", which it never was: a ranked feed cursors on `finalScore`
 * and never sets `tiebreakAt`. The misnomer was harmless only while `tiebreakAt`
 * presence doubled as the de facto provenance signal. Now that provenance is
 * explicit (`fromPopularFallback`), the fixture has to say which regime it is
 * imitating — and the genuinely-ranked case is covered in
 * `fallbackCursorRegime.test.ts`, which asserts the keyset is REFUSED for it.
 */
function fallbackCursor(score: number): string {
  return ScoreCursor.build(score, BOUNDARY_ID, {
    asOf: BOUNDARY_AT,
    tiebreakAt: BOUNDARY_AT,
    excludeIds: [NEWER_ID],
    fromPopularFallback: true,
  });
}

beforeEach(() => {
  aggregateCalls.length = 0;
  aggregateResult = [];
});

describe('ScoreCursor keyset metadata', () => {
  it('round-trips the createdAt boundary the popular sort needs', () => {
    const parsed = ScoreCursor.parse(fallbackCursor(12.5));
    expect(parsed).toMatchObject({ score: 12.5, id: BOUNDARY_ID, asOf: BOUNDARY_AT, tiebreakAt: BOUNDARY_AT });
  });

  it('keeps carrying the rolling exclusion list alongside it', () => {
    expect(ScoreCursor.parse(fallbackCursor(3))?.excludeIds).toContain(NEWER_ID);
  });

  it('still reads a legacy cursor that predates the boundary, without inventing one', () => {
    const legacy = ScoreCursor.parse(`7:${BOUNDARY_ID}`);
    expect(legacy).toMatchObject({ score: 7, id: BOUNDARY_ID });
    expect(legacy?.tiebreakAt).toBeUndefined();
  });

  it('reads a bare ObjectId as "no keyset", not as a score of zero', () => {
    const parsed = ScoreCursor.parse(BOUNDARY_ID);
    expect(parsed?.id).toBe(BOUNDARY_ID);
    expect(parsed?.score).toBe(Infinity);
  });
});

describe.each([
  ['popular', popularSource],
  ['popularVideos', popularVideosSource],
  ['popularMedia', popularMediaSource],
])('%s pagination', (_id, source) => {
  it('continues on engagementScore, not on _id', async () => {
    await source.gather(context({ cursor: fallbackCursor(9.25) }), {}, 10);

    const matches = keysetMatches();
    expect(matches.length).toBeGreaterThan(0);
    const clauses = matches[0].$or as Array<Record<string, unknown>>;
    expect(clauses[0]).toEqual({ engagementScore: { $lt: 9.25 } });
  });

  it('breaks a score tie by createdAt before falling back to _id', async () => {
    await source.gather(context({ cursor: fallbackCursor(9.25) }), {}, 10);

    const clauses = keysetMatches()[0].$or as Array<Record<string, unknown>>;
    expect(clauses[1]).toEqual({ engagementScore: 9.25, createdAt: { $lt: new Date(BOUNDARY_AT) } });
    expect(clauses[2]).toMatchObject({ engagementScore: 9.25, createdAt: new Date(BOUNDARY_AT) });
    expect(clauses[2]._id).toEqual({ $lt: new mongoose.Types.ObjectId(BOUNDARY_ID) });
  });

  it('sorts on a total order, so the keyset refers to a position that exists', async () => {
    await source.gather(context({ cursor: fallbackCursor(1) }), {}, 10);

    for (const sort of sortStages()) {
      expect(Object.keys(sort)).toEqual(['engagementScore', 'createdAt', '_id']);
    }
    expect(sortStages().length).toBeGreaterThan(0);
  });

  it('excludes the ids the cursor is carrying', async () => {
    await source.gather(context({ cursor: fallbackCursor(1) }), {}, 10);

    const excluded = stages()
      .filter((stage): stage is { $match: Record<string, unknown> } => '$match' in stage)
      .flatMap((stage) => (Array.isArray(stage.$match.$and) ? stage.$match.$and : []))
      .filter((clause): clause is { _id: { $nin: unknown[] } } =>
        typeof clause === 'object' && clause !== null && '_id' in clause
        && typeof (clause as { _id?: unknown })._id === 'object'
        && (clause as { _id: Record<string, unknown> })._id !== null
        && '$nin' in (clause as { _id: Record<string, unknown> })._id);

    expect(excluded.length).toBeGreaterThan(0);
    expect(excluded[0]._id.$nin.map(String)).toContain(NEWER_ID);
  });

  it('applies no keyset at all for a legacy cursor it cannot fully express', async () => {
    await source.gather(context({ cursor: BOUNDARY_ID }), {}, 10);

    // A bare ObjectId cannot say which score/createdAt the page stopped at. Filtering
    // on `_id` anyway is the original bug, so the correct behaviour is to lean on the
    // exclusion list for one page rather than filter on an unsorted axis.
    expect(keysetMatches()).toHaveLength(0);
  });

  it('never constrains _id as a range on its own', async () => {
    await source.gather(context({ cursor: fallbackCursor(4) }), {}, 10);

    const rangeOnId = stages()
      .filter((stage): stage is { $match: Record<string, unknown> } => '$match' in stage)
      .some((stage) => {
        const id = stage.$match._id;
        return typeof id === 'object' && id !== null && '$lt' in id;
      });
    expect(rangeOnId).toBe(false);
  });
});

describe('seen posts on the fallback path', () => {
  it('excludes what the viewer already saw on the video fallback', async () => {
    const seen = new mongoose.Types.ObjectId().toString();
    await popularVideosSource.gather(context({ seenPostIds: [seen] }), {}, 10);

    expect(JSON.stringify(aggregateCalls)).toContain(seen);
  });

  it('excludes what the viewer already saw on the media fallback', async () => {
    const seen = new mongoose.Types.ObjectId().toString();
    await popularMediaSource.gather(context({ seenPostIds: [seen] }), {}, 10);

    expect(JSON.stringify(aggregateCalls)).toContain(seen);
  });
});
