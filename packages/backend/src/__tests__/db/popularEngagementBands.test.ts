/**
 * The banded read returns EXACTLY what the single query returns.
 *
 * `selectPostsByEngagementRank` (`db/posts/engagementRankScan.ts`) reads the
 * popular order either as one query over `posts` (`FEED_ENGAGEMENT_RANKS` off)
 * or as three runs, positive ranks from `post_engagement_ranks`, rank 0 from
 * `posts`, negative ranks from `post_engagement_ranks` (on). This file runs both
 * over the same rows and compares the ids in order, at every limit and through
 * every page of a keyset walk, and then does the same for every source that
 * reads through it.
 *
 * The fixture is built to make a wrong concatenation observable:
 *
 *  - TIES at every level: equal rank with different `created_at`, and equal
 *    rank AND `created_at` (split only by id), at a positive, a zero and a
 *    negative rank, so each tiebreak key does visible work in each run;
 *  - the run BOUNDARIES: the smallest positive ranks (0.5 from one federated
 *    repost, 1, 2, 2.5 from one native repost), the zero mass, and negative
 *    ranks (counters are floored on write; the fixture writes them anyway);
 *  - the partial set's EDGES: high-ranked posts that are not public, not
 *    published, a collapsed crosspost, a repost and a reply, so a run that read
 *    the side table without re-checking `posts` would let them in;
 *  - STALE side rows the read itself must ignore: a row for a post that is no
 *    longer public, and an orphan whose post is gone (a row with the wrong rank
 *    is `backfillPostEngagementRanks` `MODE=verify`'s to repair, and
 *    `postEngagementRanks.test.ts` covers it);
 *  - TRANSITIONS: posts whose rank went to 0 and back, and whose visibility
 *    did, through the triggers.
 *
 * Other suites write posts into the same database concurrently, so every
 * comparison is restricted to this file's ids; the two modes run back to back
 * over the same rows.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MediaItem } from '@mention/shared-types';
import { PostType, PostVisibility } from '@mention/shared-types';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import {
  type EngagementRankScan,
  selectPostIdsByEngagementRank,
  selectPostsByEngagementRank,
} from '../../db/posts/engagementRankScan';
import { postEngagementRanks, posts } from '../../db/schema/posts';
import {
  popularMediaSource,
  popularSource,
  popularVideosSource,
} from '../../mtn/feed/engine/sources/discoverySources';
import { topRepliesSource } from '../../mtn/feed/engine/sources/socialSources';
import type { FeedEngineContext } from '../../mtn/feed/engine/types';
import { gatherTrendingLane } from '../../mtn/feed/feeds/forYouCandidateSources';
import { ScoreCursor } from '../../mtn/feed/CursorBuilder';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import { sameMillisecondIds } from '../helpers/tiedIds';

const scope = postScope('engagement-bands');
const FLAG = 'FEED_ENGAGEMENT_RANKS';

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR);

const PORTRAIT_VIDEO: MediaItem = {
  id: 'engagement-bands-video',
  type: 'video',
  width: 1080,
  height: 1920,
  durationSec: 30,
  orientation: 'portrait',
};

interface Counters {
  likes?: number;
  reposts?: number;
  federatedReposts?: number;
  comments?: number;
}

const mine: string[] = [];
const orphanId = '019fb000-0000-7000-8000-00000000beef';

async function create(
  counters: Counters,
  createdAt: Date,
  overrides: Parameters<typeof seedPost>[1] = {},
): Promise<string> {
  const record = await seedPost(scope, { createdAt, ...overrides });
  mine.push(record.id);
  await setCounters(record.id, counters);
  return record.id;
}

/** Through an UPDATE, as the engagement write path does, so the triggers run. */
async function setCounters(id: string, counters: Counters): Promise<void> {
  await getDb()
    .update(posts)
    .set({
      statsLikesCount: counters.likes ?? 0,
      statsRepostsCount: counters.reposts ?? 0,
      statsFederatedRepostsCount: counters.federatedReposts ?? 0,
      statsCommentsCount: counters.comments ?? 0,
    })
    .where(eq(posts.id, id));
}

async function withFlag<T>(value: 'on' | 'off', run: () => Promise<T>): Promise<T> {
  const previous = process.env[FLAG];
  process.env[FLAG] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[FLAG];
    else process.env[FLAG] = previous;
  }
}

/** Both modes over the same rows, restricted to this file's ids. */
async function bothModes(run: () => Promise<{ id: string }[]>): Promise<[string[], string[]]> {
  const keep = (rows: { id: string }[]) =>
    rows.map((row) => row.id).filter((id) => mine.includes(id));
  const single = keep(await withFlag('off', run));
  const banded = keep(await withFlag('on', run));
  return [single, banded];
}

const scoped = (extra?: SQL): SQL =>
  and(
    eq(posts.visibility, 'public'),
    eq(posts.status, 'published'),
    inArray(posts.id, mine),
    extra,
  ) as SQL;

beforeAll(async () => {
  await connectPostgres();

  // Positive run: ties on rank (12) split by created_at, and a same-millisecond
  // pair split only by id.
  const [tieLow, tieHigh] = sameMillisecondIds(2);
  await create({ likes: 12 }, at(1), { id: tieLow });
  await create({ likes: 12 }, at(1), { id: tieHigh });
  await create({ likes: 12 }, at(30));
  await create({ likes: 4, comments: 4 }, at(2)); // 12 as well, from two counters
  await create({ likes: 5 }, at(3));
  await create({ reposts: 1 }, at(4)); // 2.5: a native repost
  await create({ comments: 1 }, at(5)); // 2
  await create({ likes: 1 }, at(6)); // 1
  await create({ likes: 1 }, at(6.5));
  await create({ reposts: 1, federatedReposts: 1 }, at(7)); // 0.5: the smallest positive
  await create({ likes: 3 }, at(24 * 10)); // outside 7 days
  await create({ likes: 40 }, at(24 * 40)); // outside 30 days

  // The zero run: ties on created_at and on both keys.
  const [zeroLow, zeroHigh] = sameMillisecondIds(2);
  await create({}, at(1.5), { id: zeroLow });
  await create({}, at(1.5), { id: zeroHigh });
  await create({}, at(2.5));
  await create({}, at(24 * 12));
  await create({ reposts: 2, federatedReposts: 4 }, at(8)); // floored native term: still 2 > 0
  await create({ likes: 0, comments: 0 }, at(24 * 50));

  // The negative run (the write path floors at 0; nothing else does).
  const [negLow, negHigh] = sameMillisecondIds(2);
  await create({ likes: -2 }, at(9), { id: negLow });
  await create({ likes: -2 }, at(9), { id: negHigh });
  await create({ likes: -1, comments: -1 }, at(10)); // -3

  // Media for the video / image fallbacks, across the runs.
  const video = {
    type: PostType.VIDEO,
    content: { variants: [{ source: 'author' as const, text: 'clip' }], media: [PORTRAIT_VIDEO] },
  };
  await create({ likes: 6 }, at(2), video);
  await create({}, at(3), video);
  await create({ likes: -1 }, at(4), video);
  await create({ comments: 3 }, at(2), { type: PostType.IMAGE });
  await create({}, at(5), { type: PostType.IMAGE });

  // Edges: ranked high, but not servable to a popular scan.
  await create({ likes: 100 }, at(1), { visibility: PostVisibility.FOLLOWERS_ONLY });
  await create({ likes: 100 }, at(1), { status: 'draft' });
  const collapsed = await create({ likes: 100 }, at(1));
  await getDb().update(posts).set({ crosspostCollapsed: true }).where(eq(posts.id, collapsed));
  const target = mine[0];
  await create({ likes: 100 }, at(1), { type: PostType.REPOST, boostOf: target });
  const parent = mine[1];
  await create({ likes: 7 }, at(2), { parentPostId: parent });
  await create({ likes: 7 }, at(3), { parentPostId: parent });
  await create({}, at(4), { parentPostId: parent });

  // Transitions through the triggers.
  const toZero = await create({ likes: 3 }, at(11));
  await setCounters(toZero, {});
  const backAgain = await create({ likes: 3 }, at(12));
  await setCounters(backAgain, {});
  await setCounters(backAgain, { likes: 8 });
  const hidden = await create({ likes: 9 }, at(13));
  await getDb()
    .update(posts)
    .set({ visibility: PostVisibility.FOLLOWERS_ONLY })
    .where(eq(posts.id, hidden));
  const shown = await create({ likes: 9 }, at(14));
  await getDb()
    .update(posts)
    .set({ visibility: PostVisibility.FOLLOWERS_ONLY })
    .where(eq(posts.id, shown));
  await getDb().update(posts).set({ visibility: PostVisibility.PUBLIC }).where(eq(posts.id, shown));

  // Languages, through the triggers: every rank shape above lands in several
  // language sets, including NULL arrays and a post readable in Spanish only
  // through a translation, so the reader-language prefilter has rows to keep and
  // rows to reject in every run.
  const LANGUAGE_SETS = [
    { classificationLanguages: ['es'], translatedLanguages: null },
    { classificationLanguages: ['en'], translatedLanguages: null },
    { classificationLanguages: [], translatedLanguages: null },
    { classificationLanguages: ['de'], translatedLanguages: ['es', 'fr'] },
    { classificationLanguages: null, translatedLanguages: null },
    { classificationLanguages: ['es', 'en'], translatedLanguages: [] },
  ];
  for (const [index, id] of mine.entries()) {
    await getDb()
      .update(posts)
      .set(LANGUAGE_SETS[index % LANGUAGE_SETS.length])
      .where(eq(posts.id, id));
  }

  // Stale rows, as an unlocked backfill batch can leave them: a post that is no
  // longer public, and a post that does not exist.
  await getDb()
    .insert(postEngagementRanks)
    .values([
      { postId: hidden, engagementRank: 9, createdAt: at(13), isReply: false, languages: ['es'] },
      { postId: orphanId, engagementRank: 50, createdAt: at(1), isReply: false, languages: ['es'] },
    ])
    .onConflictDoNothing();
});

afterAll(async () => {
  // The stale rows belong to posts the delete trigger does not consider listed.
  await getDb()
    .delete(postEngagementRanks)
    .where(inArray(postEngagementRanks.postId, [...mine, orphanId]));
  await clearPostScope(scope);
  await closePostgres();
});

/**
 * A walk in pages of one is ~2 x 60 sequential statements, and a sweep over
 * every limit is as many: well under a second alone, but it took 8 s once in a
 * full parallel run against the shared database. The bound is generous on
 * purpose; a hang still fails.
 */
const WALK_TIMEOUT_MS = 60_000;

const WINDOWS = [
  { name: 'unbounded', window: {} },
  { name: '7 days', window: { since: at(24 * 7) } },
  { name: '30 days, frozen ceiling', window: { since: at(24 * 30), until: at(1.2) } },
] as const;

/** The options the banded read applies inside its index, alone and together. */
const PREFILTERS: ReadonlyArray<{ name: string; isReply?: boolean; languages?: string[] }> = [
  { name: 'no prefilter' },
  { name: 'roots', isReply: false },
  { name: 'replies', isReply: true },
  { name: 'Spanish readers', languages: ['es'] },
  { name: 'roots for Spanish or French readers', isReply: false, languages: ['es', 'fr'] },
];

describe('selectPostsByEngagementRank: banded equals single', () => {
  for (const { name, window } of WINDOWS) {
    for (const tiebreak of ['createdAt', 'id'] as const) {
      for (const prefilter of PREFILTERS) {
        it(
          `${name}, ${tiebreak} tiebreak, ${prefilter.name}, at every limit`,
          async () => {
            const total = mine.length + 2;
            for (let limit = 1; limit <= total; limit += 1) {
              const scan: EngagementRankScan = {
                where: scoped(),
                window,
                tiebreak,
                limit,
                isReply: prefilter.isReply,
                languages: prefilter.languages,
              };
              const [single, banded] = await bothModes(() => selectPostsByEngagementRank(scan));
              expect(banded).toEqual(single);
            }
          },
          WALK_TIMEOUT_MS,
        );
      }
    }

    it(`${name}: the score each row carries is the same`, async () => {
      const scan: EngagementRankScan = {
        where: scoped(),
        window,
        tiebreak: 'createdAt',
        limit: 500,
      };
      const single = await withFlag('off', () => selectPostsByEngagementRank(scan));
      const banded = await withFlag('on', () => selectPostsByEngagementRank(scan));
      expect(banded.map((row) => [row.id, row.engagementScore])).toEqual(
        single.map((row) => [row.id, row.engagementScore]),
      );
    });

    for (const pageSize of [1, 2, 3, 5]) {
      it(
        `${name}: a keyset walk in pages of ${pageSize}`,
        async () => {
          const walk = async (): Promise<{ id: string }[]> => {
            const served: { id: string }[] = [];
            let after: EngagementRankScan['after'];
            for (let page = 0; page < 200; page += 1) {
              const rows = await selectPostsByEngagementRank({
                where: scoped(),
                window,
                tiebreak: 'createdAt',
                after,
                limit: pageSize,
              });
              served.push(...rows);
              if (rows.length < pageSize) break;
              const last = rows[rows.length - 1];
              after = { score: last.engagementScore, createdAt: last.createdAt, id: last.id };
            }
            return served;
          };
          const [single, banded] = await bothModes(walk);
          expect(banded).toEqual(single);
          // And the walk is the one-shot order: nothing skipped, nothing repeated.
          const [whole] = await bothModes(() =>
            selectPostsByEngagementRank({
              where: scoped(),
              window,
              tiebreak: 'createdAt',
              limit: 500,
            }),
          );
          expect(single).toEqual(whole);
        },
        WALK_TIMEOUT_MS,
      );
    }
  }

  it('reads every run: positive, zero and negative ranks all appear, in that order', async () => {
    const rows = await withFlag('on', () =>
      selectPostsByEngagementRank({ where: scoped(), tiebreak: 'createdAt', limit: 500 }),
    );
    const signs = rows.map((row) => Math.sign(row.engagementScore));
    expect(signs).toContain(1);
    expect(signs).toContain(0);
    expect(signs).toContain(-1);
    expect([...signs].sort((a, b) => b - a)).toEqual(signs);
  });

  it('ignores stale side rows: a post no longer public, an orphan', async () => {
    const [{ stale }] = await getDb().execute<{ stale: number }>(sql`
      select count(*)::int as stale from post_engagement_ranks r
      left join posts p on p.id = r.post_id
      where r.post_id = any(${sql.param([...mine, orphanId])}::text[])
        and (p.id is null or p.visibility <> 'public')
    `);
    expect(stale).toBe(2);
    const ids = await withFlag('on', () =>
      selectPostIdsByEngagementRank({
        where: and(eq(posts.visibility, 'public'), eq(posts.status, 'published')) as SQL,
        window: { since: at(2) },
        tiebreak: 'createdAt',
        limit: 10_000,
      }),
    );
    expect(ids.map((row) => row.id)).not.toContain(orphanId);
  });
});

describe('every source that reads through it: banded equals single', () => {
  const ctx = {} as FeedEngineContext;
  const spanish = { viewerBaseLanguages: ['es'] } as FeedEngineContext;
  let languageFlag: string | undefined;

  beforeAll(() => {
    // The reader-language predicate is a runtime lever; on here so the language
    // list reaches the scan.
    languageFlag = process.env.FOR_YOU_DISCOVERY_LANGUAGE;
    process.env.FOR_YOU_DISCOVERY_LANGUAGE = 'on';
  });

  afterAll(() => {
    if (languageFlag === undefined) delete process.env.FOR_YOU_DISCOVERY_LANGUAGE;
    else process.env.FOR_YOU_DISCOVERY_LANGUAGE = languageFlag;
  });

  it('popular, for a Spanish reader', async () => {
    const [single, banded] = await bothModes(() => popularSource.gather(spanish, {}, 500));
    expect(single.length).toBeGreaterThan(0);
    expect(banded).toEqual(single);
  });

  it('popularVideos and popularMedia, for a Spanish reader', async () => {
    for (const source of [popularVideosSource, popularMediaSource]) {
      const [single, banded] = await bothModes(() => source.gather(spanish, {}, 500));
      expect(banded).toEqual(single);
    }
  });

  it('the For You trending lane, for a Spanish reader', async () => {
    const [single, banded] = await bothModes(() =>
      gatherTrendingLane({
        viewerId: scope.user('viewer'),
        followingIds: [],
        seenPostIds: [],
        rankingAsOf: NOW,
        viewerLanguages: ['es'],
      }),
    );
    expect(single.length).toBeGreaterThan(0);
    expect(banded).toEqual(single);
  });

  it('popular', async () => {
    const [single, banded] = await bothModes(() => popularSource.gather(ctx, {}, 500));
    expect(single.length).toBeGreaterThan(0);
    expect(banded).toEqual(single);
  });

  it('popular, continued from a fallback cursor at each run', async () => {
    const page = await withFlag('off', () => popularSource.gather(ctx, {}, 500));
    const anchors = page.filter((post) => mine.includes(post.id));
    expect(anchors.length).toBeGreaterThan(3);
    for (const anchor of anchors) {
      const cursor = ScoreCursor.build(anchor.engagementScore ?? 0, anchor.id, {
        asOf: NOW,
        tiebreakAt: new Date(anchor.createdAt).getTime(),
        fromPopularFallback: true,
      });
      const [single, banded] = await bothModes(() =>
        popularSource.gather({ cursor } as FeedEngineContext, {}, 500),
      );
      expect(banded).toEqual(single);
    }
  });

  it('popularVideos', async () => {
    const [single, banded] = await bothModes(() => popularVideosSource.gather(ctx, {}, 500));
    expect(single.length).toBeGreaterThan(0);
    expect(banded).toEqual(single);
  });

  it('popularMedia', async () => {
    const [single, banded] = await bothModes(() => popularMediaSource.gather(ctx, {}, 500));
    expect(single.length).toBeGreaterThan(0);
    expect(banded).toEqual(single);
  });

  it('the For You trending lane', async () => {
    for (const candidateLimit of [undefined, 3, 500]) {
      const [single, banded] = await bothModes(() =>
        gatherTrendingLane({
          viewerId: scope.user('viewer'),
          followingIds: [],
          seenPostIds: [],
          rankingAsOf: NOW,
          candidateLimit,
        }),
      );
      expect(single.length).toBeGreaterThan(0);
      expect(banded).toEqual(single);
    }
  });

  it('topReplies', async () => {
    const [single, banded] = await bothModes(() => topRepliesSource.gather(ctx, {}, 500));
    expect(single.length).toBeGreaterThan(0);
    expect(banded).toEqual(single);
  });
});
