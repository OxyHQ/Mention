/**
 * The `explore` SOURCE, against a real database.
 *
 * ## What this replaces, and why none of it could stay
 *
 * The predecessor mocked `Post.aggregate`, captured the pipeline, and walked it
 * with expressions like
 * `expr.$min[1].$cond[0].$gt[0].$size.$setIntersection[1]`. Every one of those
 * paths names a Mongo aggregation node that no longer exists. More to the point,
 * the technique could not answer any of the questions the suite was FOR: it
 * asserted that a `$literal` wrapper appeared in a tree, never that a hostile
 * preference value was harmless; it asserted a `$ne: true` key was present, never
 * that a sensitive post stayed out of the result.
 *
 * Rewriting it against rows found FOUR runtime faults in the ported source that
 * the shape assertions had passed over, all of them total (every affected request
 * 500s, no partial degradation):
 *
 *  - a JS `Date` interpolated into a `sql` template is never mapped and throws
 *    inside postgres.js before a byte is sent (`exploreFinalScoreSql`);
 *  - a fractional weight bound as an untyped parameter next to the integer
 *    literal `1` in a `CASE` is resolved as `integer`, and Postgres rejects
 *    `1.25`;
 *  - the same for `least(${maxBoost}, …)`;
 *  - a JS string array interpolated as `${topics}::text[]` is stringified to
 *    `tech,news`, which Postgres rejects as a malformed array literal.
 *
 * ## The four properties this file guards
 *
 * 1. **Discovery is HARD SFW.** Explore scores inline in SQL and never passes
 *    through `FeedRankingService`, so the query-level gate is its ONLY
 *    sensitivity filter. It ignores `showSensitiveContent` on purpose.
 * 2. **Relevance is a BOOST, never a filter.** A post that matches nothing about
 *    the viewer must still appear — only lower. A relevance term that leaked into
 *    the WHERE clause would empty Explore for a viewer with narrow interests, and
 *    would read as "there is nothing to discover".
 * 3. **Viewer signals are DATA.** They arrive from a learned profile, so they are
 *    attacker-influenceable; a `$`-prefixed or quote-bearing value must change
 *    nothing.
 * 4. **A pagination session is a frozen snapshot.** `asOf` bounds both ends of
 *    the candidate window, so neither the wall clock advancing nor a new post
 *    arriving can move an existing candidate across a page boundary.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { MtnConfig, PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, type Database } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { insertPostRecord } from '../db/posts/postRepository';
import type { PostRecordInput } from '../db/posts/postRecord';
import { exploreSource } from '../mtn/feed/engine/sources/discoverySources';
import { ScoreCursor } from '../mtn/feed/CursorBuilder';
import type { CandidatePost, FeedEngineContext } from '../mtn/feed/engine/types';

let db: Database;

/** Every id this file created, so results can be scoped away from concurrent suites. */
const created: string[] = [];

const AUTHOR = 'explore-author';
const VIEWER = 'explore-viewer';

/** Inside `trendingWindowMs` (24h) of {@link AS_OF}, which bounds the window. */
const AS_OF = Date.UTC(2026, 6, 26, 12, 0, 0);
const WITHIN_WINDOW = new Date(AS_OF - 60 * 60 * 1000);

/**
 * A cap far above anything this file inserts.
 *
 * Explore has no content predicate, so a concurrent suite's public posts are
 * legitimately in the same candidate set. A generous cap guarantees this file's
 * rows are all present, and every assertion then filters down to {@link created}.
 */
const CAP = 500;

async function create(
  overrides: Partial<PostRecordInput> = {},
  engagement?: { likes: number },
): Promise<string> {
  const input: PostRecordInput = {
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'discoverable' }] },
    createdAt: WITHIN_WINDOW,
    ...overrides,
  };
  const record = await insertPostRecord(input);
  created.push(record.id);
  if (engagement) {
    // `stats` is not part of `PostRecordInput` — engagement is owned by the
    // engagement batch, so a ranking fixture writes the column directly.
    await db.update(posts).set({ statsLikesCount: engagement.likes }).where(inArray(posts.id, [record.id]));
  }
  return record.id;
}

function context(overrides: Partial<FeedEngineContext> = {}): FeedEngineContext {
  return { rankingAsOf: AS_OF, pageLimit: 30, ...overrides } as FeedEngineContext;
}

/** The candidates this file created, in the order the source returned them. */
async function gatherMine(ctx: FeedEngineContext): Promise<CandidatePost[]> {
  const candidates = await exploreSource.gather(ctx, {}, CAP);
  return candidates.filter((candidate) => created.includes(candidate.id));
}

async function idsOfMine(ctx: FeedEngineContext): Promise<string[]> {
  return (await gatherMine(ctx)).map((candidate) => candidate.id);
}

function scoreOf(candidates: readonly CandidatePost[], id: string): number {
  const found = candidates.find((candidate) => candidate.id === id);
  if (!found || typeof found.finalScore !== 'number') {
    throw new Error(`explore returned no score for ${id}`);
  }
  return found.finalScore;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  if (created.length > 0) {
    await db.delete(posts).where(inArray(posts.id, created));
    created.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('discovery is hard SFW', () => {
  it('withholds every sensitivity signal, even from a viewer who opted in', async () => {
    /**
     * All four signals in ONE set, because the value is in the set being exact:
     * dropping any single arm still leaves a query that returns plenty of posts.
     * `showSensitiveContent: true` is the whole point — Explore ignores it, which
     * is what makes this different from a personalized feed.
     */
    const safe = await create();
    const classifierFlagged = await create({ postClassification: { sensitive: true } });
    const metadataFlagged = await create({ metadata: { isSensitive: true } });
    const remoteFlagged = await create({
      federation: { activityId: 'https://remote.example/notes/cw', sensitive: true },
    });
    const nsfwTagged = await create({ hashtags: ['nsfw'] });

    for (const showSensitiveContent of [undefined, false, true]) {
      expect(await idsOfMine(context({ currentUserId: VIEWER, followingIds: [], showSensitiveContent })))
        .toEqual([safe]);
    }
    expect([classifierFlagged, metadataFlagged, remoteFlagged, nsfwTagged]).toHaveLength(4);
  });

  it('keeps an UNCLASSIFIED post, which is the common case, not a sensitive one', async () => {
    // The vacuity floor for the gate: the flags are NULLABLE, and `<> true` on a
    // NULL is NULL, which DROPS the row. `IS DISTINCT FROM TRUE` is what
    // reproduces Mongo's `$ne: true`. Get that wrong and Explore is empty for
    // essentially the whole corpus.
    const unclassified = await create();
    expect(await idsOfMine(context({ currentUserId: VIEWER, followingIds: [] }))).toEqual([unclassified]);
  });
});

describe('relevance is a boost, never a filter', () => {
  it('still returns a post that matches nothing about the viewer', async () => {
    const matching = await create({ postClassification: { topics: ['tech'] } }, { likes: 10 });
    const unrelated = await create({ postClassification: { topics: ['gardening'] } }, { likes: 10 });
    const unclassified = await create({}, { likes: 10 });

    const candidates = await gatherMine(
      context({
        currentUserId: VIEWER,
        followingIds: [],
        userBehavior: { preferredTopics: [{ topic: 'tech', weight: 5 }], preferredLanguages: [] },
      }),
    );

    // Present — all three of them.
    expect(candidates.map((candidate) => candidate.id).sort()).toEqual(
      [matching, unrelated, unclassified].sort(),
    );
    // …and the match is ranked ABOVE the others, which is the only difference a
    // boost is allowed to make. Engagement and recency are held equal, so the
    // relevance factor is the only variable.
    expect(scoreOf(candidates, matching)).toBeGreaterThan(scoreOf(candidates, unrelated));
    expect(scoreOf(candidates, unrelated)).toBeCloseTo(scoreOf(candidates, unclassified), 10);
    expect(candidates[0].id).toBe(matching);
  });

  it('lifts by the configured topic multiplier, not by an arbitrary amount', async () => {
    const matching = await create({ postClassification: { topics: ['tech'] } }, { likes: 10 });
    const unrelated = await create({ postClassification: { topics: ['gardening'] } }, { likes: 10 });

    const candidates = await gatherMine(
      context({
        currentUserId: VIEWER,
        followingIds: [],
        userBehavior: { preferredTopics: [{ topic: 'tech', weight: 5 }], preferredLanguages: [] },
      }),
    );

    expect(scoreOf(candidates, matching) / scoreOf(candidates, unrelated)).toBeCloseTo(
      MtnConfig.ranking.exploreRelevance.topicMatch,
      6,
    );
  });

  it('matches a language by ANY overlap of the multi-language array', async () => {
    // `postClassification.languages` holds EVERY detected code, primary first,
    // and the match is any-overlap — a bilingual post must match a viewer who
    // reads only its SECOND language.
    const secondaryLanguage = await create(
      { postClassification: { languages: ['en', 'es'] } },
      { likes: 10 },
    );
    const otherLanguage = await create({ postClassification: { languages: ['de'] } }, { likes: 10 });

    const candidates = await gatherMine(
      context({
        currentUserId: VIEWER,
        followingIds: [],
        userBehavior: { preferredTopics: [], preferredLanguages: ['es'] },
      }),
    );

    expect(scoreOf(candidates, secondaryLanguage) / scoreOf(candidates, otherLanguage)).toBeCloseTo(
      MtnConfig.ranking.exploreRelevance.languageMatch,
      6,
    );
  });

  it('lowercases the viewer topics, so a display-cased preference still matches', async () => {
    // Classified topics are stored as slugs. A preference learned as `TechNews`
    // must still hit `technews`.
    const matching = await create({ postClassification: { topics: ['technews'] } }, { likes: 10 });
    const unrelated = await create({ postClassification: { topics: ['gardening'] } }, { likes: 10 });

    const candidates = await gatherMine(
      context({
        currentUserId: VIEWER,
        followingIds: [],
        userBehavior: { preferredTopics: [{ topic: 'TechNews', weight: 0.1 }], preferredLanguages: [] },
      }),
    );

    expect(scoreOf(candidates, matching)).toBeGreaterThan(scoreOf(candidates, unrelated));
  });

  it('clamps the combined multiplier at maxBoost so no viewer profile runs away', async () => {
    /**
     * topic × language × region is 1.25 × 1.15 × 1.1 ≈ 1.58, above the 1.5
     * ceiling — so the clamp is the ONLY thing that can produce the observed
     * ratio, and a missing `least(...)` shows up here as 1.58.
     */
    const everything = await create(
      { postClassification: { topics: ['tech'], languages: ['es'], region: 'ES' } },
      { likes: 10 },
    );
    const nothing = await create({}, { likes: 10 });

    const candidates = await gatherMine(
      context({
        currentUserId: VIEWER,
        followingIds: [],
        viewerRegion: 'ES',
        userBehavior: {
          preferredTopics: [{ topic: 'tech', weight: 5 }],
          preferredLanguages: ['es'],
        },
      }),
    );

    expect(scoreOf(candidates, everything) / scoreOf(candidates, nothing)).toBeCloseTo(
      MtnConfig.ranking.exploreRelevance.maxBoost,
      6,
    );
  });

  it('stays neutral for an anonymous viewer and for one with no learned signals', async () => {
    const withTopic = await create({ postClassification: { topics: ['tech'] } }, { likes: 10 });
    const withoutTopic = await create({}, { likes: 10 });

    const anonymous = await gatherMine(context({ currentUserId: undefined, followingIds: [] }));
    expect(scoreOf(anonymous, withTopic)).toBeCloseTo(scoreOf(anonymous, withoutTopic), 10);

    const signalless = await gatherMine(
      context({
        currentUserId: VIEWER,
        followingIds: [],
        userBehavior: { preferredTopics: [], preferredLanguages: [] },
      }),
    );
    expect(scoreOf(signalless, withTopic)).toBeCloseTo(scoreOf(signalless, withoutTopic), 10);
  });
});

describe('viewer signals are data, never SQL', () => {
  it('treats hostile topic / language / region preferences as literal values', async () => {
    /**
     * These strings carry a Mongo aggregation sigil, a SQL string terminator and
     * a statement separator. The row-level claim is the one that matters and the
     * shape assertion could never make: the query RUNS, the result is the same as
     * with no preference at all, and the table is still there afterwards.
     */
    const post = await create({ postClassification: { topics: ['tech'] } }, { likes: 10 });

    const hostile = await gatherMine(
      context({
        currentUserId: VIEWER,
        followingIds: [],
        viewerRegion: "'; drop table posts; --",
        userBehavior: {
          preferredTopics: [{ topic: '$$bad', weight: 5 }, { topic: "') or true --", weight: 4 }],
          preferredLanguages: ['$$lang'],
        },
      }),
    );
    const neutral = await gatherMine(context({ currentUserId: VIEWER, followingIds: [] }));

    expect(hostile.map((candidate) => candidate.id)).toEqual([post]);
    // No factor matched, so the score is the neutral one — the hostile values
    // were compared as data and simply did not equal anything.
    expect(scoreOf(hostile, post)).toBeCloseTo(scoreOf(neutral, post), 10);
    // And the table the injection asked for is still readable.
    expect(await idsOfMine(context({ currentUserId: VIEWER, followingIds: [] }))).toEqual([post]);
  });
});

describe('what the candidate window excludes', () => {
  it('excludes the viewer, the accounts they follow, replies and boosts', async () => {
    const followed = 'explore-followed-author';
    const keep = await create();
    const own = await create({
      oxyUserId: VIEWER,
      authorship: [{ oxyUserId: VIEWER, role: 'owner', status: 'accepted' }],
    });
    const fromFollowed = await create({
      oxyUserId: followed,
      authorship: [{ oxyUserId: followed, role: 'owner', status: 'accepted' }],
    });
    const parent = await create();
    const reply = await create({ parentPostId: parent });
    const boost = await create({ type: PostType.BOOST, boostOf: parent, content: { variants: [] } });

    const ids = await idsOfMine(context({ currentUserId: VIEWER, followingIds: [followed] }));
    expect(ids.sort()).toEqual([keep, parent].sort());
    expect([own, fromFollowed, reply, boost].filter((id) => ids.includes(id))).toEqual([]);
  });

  it('KEEPS an author-less post, which `NOT IN` on a nullable column silently drops', async () => {
    /**
     * The NULL-propagation trap, stated as rows. `oxy_user_id` is nullable (the
     * raw federated insert path can omit it) and SQL's `col NOT IN (…)` evaluates
     * to NULL when the column is NULL — which excludes the row. Mongo's `$nin`
     * MATCHED a missing field, so the direct translation silently drops every
     * author-less post from Explore, with no error, looking exactly like a
     * ranking change. `authorNotInSql`'s `IS NULL` arm is what restores it.
     */
    const authorless = await create({ oxyUserId: null, authorship: [] });
    const attributed = await create();

    const ids = await idsOfMine(context({ currentUserId: VIEWER, followingIds: ['someone-else'] }));
    expect(ids.sort()).toEqual([authorless, attributed].sort());
  });

  it('bounds the window at both ends of the trending window', async () => {
    const inside = await create({ createdAt: new Date(AS_OF - 60 * 60 * 1000) });
    const tooOld = await create({ createdAt: new Date(AS_OF - MtnConfig.feed.trendingWindowMs - 1000) });
    const afterTheSnapshot = await create({ createdAt: new Date(AS_OF + 60 * 60 * 1000) });

    const ids = await idsOfMine(context({ currentUserId: VIEWER, followingIds: [] }));
    expect(ids).toEqual([inside]);
    expect([tooOld, afterTheSnapshot].filter((id) => ids.includes(id))).toEqual([]);
  });
});

describe('a pagination session is a frozen snapshot', () => {
  /**
   * Six posts: four with distinct engagement, then a TIED PAIR (identical
   * engagement AND identical `created_at`, so their recency decay and therefore
   * their `finalScore` are bit-identical). The tie is what forces the keyset's
   * second key — `finalScore = s AND id < cursorId` — to do real work; without a
   * tie a score-only bound is indistinguishable from a correct one.
   */
  async function pool(): Promise<string[]> {
    const tiedAt = new Date(AS_OF - 3 * 60 * 60 * 1000);
    const ids = [
      await create({ createdAt: tiedAt }, { likes: 50 }),
      await create({ createdAt: tiedAt }, { likes: 40 }),
      await create({ createdAt: tiedAt }, { likes: 30 }),
      await create({ createdAt: tiedAt }, { likes: 20 }),
      await create({ createdAt: tiedAt }, { likes: 10 }),
      await create({ createdAt: tiedAt }, { likes: 10 }),
    ];
    // The two tied posts sort by DESCENDING id, and uuid v7 is monotonic, so the
    // later insert leads.
    const [a, b, c, d, tiedFirst, tiedSecond] = ids;
    return [a, b, c, d, tiedSecond, tiedFirst];
  }

  it('walks adjacent pages that neither overlap nor gap, across a score tie', async () => {
    const expected = await pool();

    const page = async (cursor?: string): Promise<string[]> =>
      idsOfMine(context({ currentUserId: VIEWER, followingIds: [], cursor }));

    // Page one: the source is given no cursor, so it returns the whole window in
    // score order. The keyset is what the NEXT page depends on, so the cursor is
    // minted from a real emitted row rather than invented.
    const first = await page();
    expect(first).toEqual(expected);

    const anchorIndex = 2;
    const anchor = (await gatherMine(context({ currentUserId: VIEWER, followingIds: [] })))[anchorIndex];
    const anchorScore = anchor.finalScore;
    if (typeof anchorScore !== 'number') throw new Error('explore emitted no score to cursor on');

    const second = await page(
      ScoreCursor.build(anchorScore, anchor.id, {
        asOf: AS_OF,
        excludeIds: expected.slice(0, anchorIndex + 1),
      }),
    );

    // NO OVERLAP: nothing already emitted comes back.
    expect(second.filter((id) => expected.slice(0, anchorIndex + 1).includes(id))).toEqual([]);
    // NO GAP: the two pages concatenate to exactly the full ordered pool — which
    // is the assertion a score-only bound fails, because it would drop the tied
    // sibling that shares the anchor's score.
    expect([...expected.slice(0, anchorIndex + 1), ...second]).toEqual(expected);
  });

  it('breaks a score tie by id so the tied sibling is neither repeated nor skipped', async () => {
    const expected = await pool();
    const tiedLeader = expected[4];
    const tiedTrailer = expected[5];

    const candidates = await gatherMine(context({ currentUserId: VIEWER, followingIds: [] }));
    // The premise of the fixture, asserted rather than assumed: these two really
    // do tie, so the id comparison is the only thing separating them.
    expect(scoreOf(candidates, tiedLeader)).toBe(scoreOf(candidates, tiedTrailer));

    const continued = await idsOfMine(
      context({
        currentUserId: VIEWER,
        followingIds: [],
        cursor: ScoreCursor.build(scoreOf(candidates, tiedLeader), tiedLeader, {
          asOf: AS_OF,
          excludeIds: expected.slice(0, 5),
        }),
      }),
    );

    expect(continued).toEqual([tiedTrailer]);
  });

  it('freezes the candidate window, so a post published mid-session cannot enter it', async () => {
    /**
     * The reason `asOf` travels in the cursor at all. Without the frozen ceiling
     * a post created between two page requests lands at the TOP of the ordering
     * and shifts every later item down by one — silently skipping whatever fell
     * across the boundary.
     */
    // The anchor is a THROWAWAY: `ScoreCursor` always folds the cursor row into
    // its own exclusion list, so an anchor that is also an expected result can
    // never come back and the assertion would be measuring the wrong thing.
    const anchor = await create({ createdAt: new Date(AS_OF - 3 * 60 * 60 * 1000) }, { likes: 1 });
    const original = await create({ createdAt: new Date(AS_OF - 2 * 60 * 60 * 1000) }, { likes: 5 });
    // A score bound wide enough to admit everything, so the WINDOW is the only
    // thing that can exclude a row.
    const cursor = ScoreCursor.build(Number.MAX_SAFE_INTEGER, anchor, { asOf: AS_OF });

    // Published AFTER the snapshot instant, with enough engagement to outrank
    // everything, and carrying the cursor's own session.
    const arrivedLater = await create({ createdAt: new Date(AS_OF + 60 * 1000) }, { likes: 9999 });

    const ids = await idsOfMine(context({ currentUserId: VIEWER, followingIds: [], cursor }));
    expect(ids).not.toContain(arrivedLater);
    expect(ids).toEqual([original]);
  });

  it('honours the cursor exclusion list, including the cursor row itself', async () => {
    // The rolling exclusion list is what protects a page boundary while
    // engagement counts move underneath it, so it has to bite even when the score
    // window alone would have re-admitted the row.
    const anchor = await create({}, { likes: 9 });
    const kept = await create({}, { likes: 5 });
    const excluded = await create({}, { likes: 5 });

    const cursor = ScoreCursor.build(Number.MAX_SAFE_INTEGER, anchor, {
      asOf: AS_OF,
      excludeIds: [excluded],
    });
    // Both the listed id AND the anchor are gone; only the untouched post remains.
    expect(await idsOfMine(context({ currentUserId: VIEWER, followingIds: [], cursor }))).toEqual([kept]);
  });
});
