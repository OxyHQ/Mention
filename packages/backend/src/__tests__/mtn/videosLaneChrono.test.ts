/**
 * The Videos lane, now that its scan drives from `post_media` instead of `posts`.
 *
 * The change bought a plan — an ordered walk of `post_media_video_chrono_idx`
 * that stops at the page, instead of a chronological walk over `posts` probing
 * this table once per candidate. It also gave up two things the correlated
 * `EXISTS` form got for free, and those are what most of this file is about:
 *
 *  1. **Set semantics.** `EXISTS` answers once per post however many media rows
 *     match; a JOIN emits one row per matching media row. A post carrying two
 *     qualifying videos would appear TWICE in one page. `DISTINCT ON` is the fix
 *     and the first test is the row that proves it.
 *  2. **Immunity to a missing timestamp.** The lane orders on a denormalized
 *     copy, and the deploy window in `0029_the_videos_lane_walks_its_own_index.sql`
 *     can leave one NULL. The lane must still SERVE that post — the JOIN is on
 *     `post_id` and the copy is only ordered on — so the symptom is a video at
 *     the bottom of the lane rather than a video that is gone.
 *
 * The parity test is the one that says the rewrite did not quietly change WHICH
 * posts the lane shows. It drives the shipped `EXISTS` predicate and the new
 * media-driven scan over the same fixtures and requires the same post ids back,
 * over exactly the shapes that distinguish them: a boost, a private post, a seen
 * post, an image-only post, a too-short video, and a landscape one.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { MtnConfig, PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { postMedia, posts } from '../../db/schema';
import { insertPostRecord } from '../../db/posts/postRepository';
import { FeedQueryBuilder } from '../../utils/feedQueryBuilder';
import { chronoOrderBy } from '../../mtn/feed/CursorBuilder';
import { discoverySafeSql } from '../../mtn/feed/feedSafety';
import { videosSource } from '../../mtn/feed/engine/sources/discoverySources';
import type { FeedEngineContext } from '../../mtn/feed/engine/types';

const OWNER = 'videos-lane-chrono-owner';
const created: string[] = [];

/**
 * Far in the future, so this file's rows sort ABOVE whatever else the shared
 * database holds and a page of 60 is this suite's fixtures rather than a sample
 * of another suite's.
 */
const BASE = new Date('2099-01-01T00:00:00.000Z');
const at = (minutes: number) => new Date(BASE.getTime() + minutes * 60_000);

const PORTRAIT = { width: 720, height: 1280, orientation: 'portrait' as const };
const LONG_ENOUGH = MtnConfig.videosFeed.minDurationSec + 5;

interface VideoFixture {
  label: string;
  createdAt: Date;
  media: Array<Record<string, unknown>>;
  type?: PostType;
  visibility?: PostVisibility;
}

async function seed(fixture: VideoFixture): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: OWNER,
    authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
    type: fixture.type ?? PostType.VIDEO,
    visibility: fixture.visibility ?? PostVisibility.PUBLIC,
    status: 'published',
    createdAt: fixture.createdAt,
    content: {
      variants: [{ source: 'author', tag: 'en', text: fixture.label }],
      media: fixture.media,
    },
  } as never);
  created.push(record.id);
  return record.id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  if (created.length > 0) {
    await getDb().delete(posts).where(inArray(posts.id, created));
    created.length = 0;
  }
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closePostgres();
});

/** The shipped `EXISTS` formulation — the specification the rewrite must match. */
async function existsFormIds(seen: readonly string[]): Promise<string[]> {
  const rows = await getDb()
    .select({ id: posts.id })
    .from(posts)
    .where(and(FeedQueryBuilder.buildVideosQuery(seen), discoverySafeSql()))
    .orderBy(...chronoOrderBy())
    .limit(60);
  return [...rows].map((row) => row.id);
}

/**
 * The lane's OWN scan — `videosSource.gather`, the shipped module, not a copy of
 * its statement.
 *
 * Driving the real source is the difference between this file testing the change
 * and testing itself. A local re-spelling of the query would keep passing after
 * someone deleted `DISTINCT ON` from production, which is the single most
 * important thing here to be able to fail.
 */
async function laneIds(seen: readonly string[]): Promise<string[]> {
  const ctx = { seenPostIds: [...seen] } as FeedEngineContext;
  const candidates = await videosSource.gather(ctx, {}, 60);
  return candidates.map((candidate) => candidate.id);
}

describe('the Videos lane scan', () => {
  it('returns a post carrying TWO qualifying videos exactly once', async () => {
    // The row the `EXISTS` form got free and the JOIN does not. Without
    // `DISTINCT ON` this page contains the same post id twice.
    const twoVideos = await seed({
      label: 'two qualifying videos',
      createdAt: at(10),
      media: [
        { id: 'm-1', type: 'video', durationSec: LONG_ENOUGH, ...PORTRAIT },
        { id: 'm-2', type: 'video', durationSec: LONG_ENOUGH, ...PORTRAIT },
      ],
    });

    // The fixture is really two matching rows — otherwise this asserts nothing.
    const mediaRows = await getDb()
      .select({ id: postMedia.id })
      .from(postMedia)
      .where(eq(postMedia.postId, twoVideos));
    expect([...mediaRows]).toHaveLength(2);

    const ids = await laneIds([]);
    expect(ids.filter((id) => id === twoVideos)).toEqual([twoVideos]);
  });

  it('selects the same posts as the shipped EXISTS predicate', async () => {
    const qualifying = [
      await seed({
        label: 'portrait video, long enough',
        createdAt: at(50),
        media: [{ id: 'q-1', type: 'video', durationSec: LONG_ENOUGH, ...PORTRAIT }],
      }),
      await seed({
        label: 'duration unknown — the lane abstains, it does not exclude',
        createdAt: at(40),
        media: [{ id: 'q-2', type: 'video', ...PORTRAIT }],
      }),
    ];

    const excluded = [
      await seed({
        label: 'landscape',
        createdAt: at(45),
        media: [{ id: 'x-1', type: 'video', durationSec: LONG_ENOUGH, width: 1280, height: 720, orientation: 'landscape' }],
      }),
      await seed({
        label: 'too short',
        createdAt: at(44),
        media: [{ id: 'x-2', type: 'video', durationSec: 1, ...PORTRAIT }],
      }),
      await seed({
        label: 'image only',
        createdAt: at(43),
        type: PostType.IMAGE,
        media: [{ id: 'x-3', type: 'image', width: 720, height: 1280, orientation: 'portrait' }],
      }),
      await seed({
        label: 'not public',
        createdAt: at(42),
        visibility: PostVisibility.FOLLOWERS_ONLY,
        media: [{ id: 'x-4', type: 'video', durationSec: LONG_ENOUGH, ...PORTRAIT }],
      }),
    ];

    const seenPost = await seed({
      label: 'already seen',
      createdAt: at(41),
      media: [{ id: 's-1', type: 'video', durationSec: LONG_ENOUGH, ...PORTRAIT }],
    });

    const mine = new Set([...qualifying, ...excluded, seenPost]);
    const onlyMine = (ids: string[]) => ids.filter((id) => mine.has(id));

    // No seen set: both formulations agree, and agree with the fixture's intent —
    // newest first, which for these stamps is q@50, seen@41, q@40.
    const noSeen = onlyMine(await laneIds([]));
    expect(noSeen).toEqual(onlyMine(await existsFormIds([])));
    expect(noSeen).toEqual([qualifying[0], seenPost, qualifying[1]]);

    // With one: still agree, and the seen post is gone from both.
    const withSeen = onlyMine(await laneIds([seenPost]));
    expect(withSeen).toEqual(onlyMine(await existsFormIds([seenPost])));
    expect(withSeen).not.toContain(seenPost);
    for (const id of excluded) expect(withSeen).not.toContain(id);
    for (const id of qualifying) expect(withSeen).toContain(id);
  });

  it('plans onto post_media_video_chrono_idx, with no sort', async () => {
    /**
     * The property the whole change exists for, and the one no behavioural test
     * can see: the same rows come back either way, and the only difference is
     * whether the lane walks an ordered index or collects every matching media
     * row and sorts it.
     *
     * The statement is rebuilt here from the shipped `FeedQueryBuilder` helpers
     * rather than driven through `videosSource.gather`, because `EXPLAIN` needs
     * the text and `gather` returns rows. The two tests above are what tie the
     * shipped source to this shape; this one is about the plan it gets.
     *
     * THE CHEAP ALTERNATIVES ARE PRICED OUT, for the reason
     * `engagementRankIndex.test.ts` records: a CI database holds a handful of
     * media rows, and over a handful of rows reading them and sorting really is
     * cheaper than any index, so the planner declines — correctly — and the
     * assertion would be measuring the size of the database rather than the
     * property. `enable_sort = off` does not FORBID a sort, it prices one at
     * about 1e10, so an index that cannot satisfy this ORDER BY still yields a
     * plan with a `Sort` node in it and this still fails.
     */
    await seed({
      label: 'a row, so the planner has something to plan over',
      createdAt: at(20),
      media: [{ id: 'p-1', type: 'video', durationSec: LONG_ENOUGH, ...PORTRAIT }],
    });

    const query = getDb()
      .selectDistinctOn([postMedia.postCreatedAt, postMedia.postId], { id: posts.id })
      .from(postMedia)
      .innerJoin(posts, eq(posts.id, postMedia.postId))
      .where(and(
        FeedQueryBuilder.videoMediaConditions(),
        FeedQueryBuilder.videoPostConditions([]),
      ))
      .orderBy(
        sql`${postMedia.postCreatedAt} desc nulls last`,
        sql`${postMedia.postId} desc nulls last`,
      )
      .limit(60);

    // `EXPLAIN` takes no bind parameters, so the placeholders are inlined —
    // quoted, because an unquoted one reads as a column name and errors.
    const { sql: text, params } = query.toSQL();
    const inlined = text.replace(/\$(\d+)/g, (_match, index: string) => {
      const value = params[Number(index) - 1];
      return typeof value === 'number' ? String(value) : `'${String(value).replace(/'/g, "''")}'`;
    });

    // `SET LOCAL` inside a transaction, so the settings cannot outlive this plan
    // and reach another suite through the pooled connection.
    const plan = await getDb().transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      await tx.execute(sql`set local enable_bitmapscan = off`);
      await tx.execute(sql`set local enable_sort = off`);
      const rows = await tx.execute<Record<string, string>>(sql.raw(`explain ${inlined}`));
      return [...rows].map((row) => Object.values(row)[0]).join('\n');
    });

    expect(plan).toContain('post_media_video_chrono_idx');
    expect(plan).toMatch(/Index Scan using post_media_video_chrono_idx/);
    expect(plan).not.toMatch(/\bSort\b/);
  });

  it('still serves a post whose denormalized timestamp is NULL', async () => {
    /**
     * The deploy window: a media row written by the old image between the
     * migration landing and the new code starting carries no copy.
     *
     * It must be SERVED, not dropped — the join is on `post_id` and this column
     * is only ordered on. `desc nulls last` puts it at the bottom of the lane,
     * which is a visible symptom rather than a silent one. A formulation that
     * joined or filtered on the copy would lose the post entirely, and this is
     * the assertion that would catch it.
     */
    const orphan = await seed({
      label: 'written during the deploy window',
      createdAt: at(30),
      media: [{ id: 'n-1', type: 'video', durationSec: LONG_ENOUGH, ...PORTRAIT }],
    });
    const newer = await seed({
      label: 'written after, with its copy',
      createdAt: at(31),
      media: [{ id: 'n-2', type: 'video', durationSec: LONG_ENOUGH, ...PORTRAIT }],
    });

    await getDb()
      .update(postMedia)
      .set({ postCreatedAt: null })
      .where(eq(postMedia.postId, orphan));

    const ids = await laneIds([]);
    expect(ids).toContain(orphan);
    // And it sorts BELOW the row that has its copy, which is the whole claim
    // about `nulls last` being the visible failure rather than the silent one.
    expect(ids.indexOf(orphan)).toBeGreaterThan(ids.indexOf(newer));
  });
});
