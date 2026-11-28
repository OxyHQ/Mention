/**
 * `backfillPostEngagementRanks` copies what predates the triggers without
 * overwriting what they wrote, and its `verify` mode finds and repairs every
 * kind of mismatch.
 *
 * On a database of its own (`isolatedDatabaseFiles.ts`): the script walks every
 * post, so another file's posts are in its ranges, and a repair would remove
 * the stale side rows `db/popularEngagementBands.test.ts` writes on purpose.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostVisibility } from '@mention/shared-types';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { engagementRankSql, postEngagementRanks, posts } from '../../db/schema/posts';
import { backfillPostEngagementRanks } from '../../scripts/backfillPostEngagementRanks';
import { fixedPauseThrottle } from '../../scripts/lib/backfillThrottle';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';

const scope = postScope('backfill-post-engagement-ranks');
const mine: string[] = [];

beforeAll(async () => {
  await connectPostgres();
});

/** Rows this file wrote around the fixtures (a direct insert, a moved id) and its side rows. */
async function cleanUp(): Promise<void> {
  await clearPostScope(scope);
  if (mine.length > 0) {
    await getDb().delete(posts).where(inArray(posts.id, mine));
    await getDb().delete(postEngagementRanks).where(inArray(postEngagementRanks.postId, mine));
  }
  mine.length = 0;
}

beforeEach(cleanUp);

afterAll(async () => {
  await cleanUp();
  await closePostgres();
});

async function seed(overrides: Parameters<typeof seedPost>[1] = {}): Promise<string> {
  const record = await seedPost(scope, overrides);
  mine.push(record.id);
  return record.id;
}

type Row = typeof postEngagementRanks.$inferSelect;

async function rowOf(id: string): Promise<Row | undefined> {
  const [row] = await getDb()
    .select()
    .from(postEngagementRanks)
    .where(eq(postEngagementRanks.postId, id));
  return row;
}

/**
 * The table's definition, evaluated from `posts` for this file's posts: what
 * the rows SHOULD be. Compared with what they are by {@link expectInStep}.
 */
async function expectInStep(): Promise<void> {
  const expected = await getDb()
    .select({
      postId: posts.id,
      engagementRank: engagementRankSql(posts),
      createdAt: posts.createdAt,
      isReply: posts.isReply,
      languages: sql<
        string[]
      >`coalesce(${posts.classificationLanguages}, '{}') || coalesce(${posts.translatedLanguages}, '{}')`,
    })
    .from(posts)
    .where(
      and(
        inArray(posts.id, mine),
        eq(posts.visibility, 'public'),
        eq(posts.status, 'published'),
        sql`${engagementRankSql(posts)} <> 0`,
      ),
    )
    .orderBy(posts.id);
  const actual = await getDb()
    .select()
    .from(postEngagementRanks)
    .where(inArray(postEngagementRanks.postId, mine))
    .orderBy(postEngagementRanks.postId);
  expect(actual).toEqual(expected);
}

describe('backfillPostEngagementRanks', () => {
  async function seedListed(likes: number): Promise<string> {
    const id = await seed();
    await getDb().update(posts).set({ statsLikesCount: likes }).where(eq(posts.id, id));
    return id;
  }

  it('copies what predates the triggers, verifies, and repairs every mismatch', async () => {
    const predates = await seedListed(3);
    const kept = await seedListed(4);
    const leftTheSet = await seedListed(5);
    const wrongRank = await seedListed(6);

    // As if `predates` existed before migration 0142: no row. A row the trigger
    // wrote is not overwritten by the copy, even when it disagrees (the trigger
    // is the newer write), which `kept` stands for.
    await getDb().delete(postEngagementRanks).where(eq(postEngagementRanks.postId, predates));
    await getDb()
      .update(postEngagementRanks)
      .set({ engagementRank: 40 })
      .where(eq(postEngagementRanks.postId, kept));

    const copy = await backfillPostEngagementRanks({
      mode: 'copy',
      dryRun: false,
      throttle: fixedPauseThrottle(0),
      batchSize: 7,
    });
    expect(copy.rowsWritten).toBeGreaterThanOrEqual(1);
    expect((await rowOf(predates))?.engagementRank).toBe(3);
    expect((await rowOf(kept))?.engagementRank).toBe(40);

    // The unlocked copy's one race: a post leaves the set after its range was
    // read. And a row that disagrees with its post.
    await getDb()
      .update(posts)
      .set({ visibility: PostVisibility.FOLLOWERS_ONLY })
      .where(eq(posts.id, leftTheSet));
    await getDb().insert(postEngagementRanks).values({
      postId: leftTheSet,
      engagementRank: 5,
      createdAt: new Date(),
      isReply: false,
      languages: [],
    });
    await getDb()
      .update(postEngagementRanks)
      .set({ languages: ['xx'] })
      .where(eq(postEngagementRanks.postId, wrongRank));

    const check = await backfillPostEngagementRanks({
      mode: 'verify',
      dryRun: true,
      throttle: fixedPauseThrottle(0),
      batchSize: 7,
    });
    expect(check.extra).toBeGreaterThanOrEqual(1);
    expect(check.mismatched).toBeGreaterThanOrEqual(2);
    expect(check.repaired).toBe(0);

    const repair = await backfillPostEngagementRanks({
      mode: 'verify',
      dryRun: false,
      throttle: fixedPauseThrottle(0),
      batchSize: 7,
    });
    expect(repair.repaired).toBeGreaterThanOrEqual(3);
    await expectInStep();

    // A missing row is found and repaired too.
    await getDb().delete(postEngagementRanks).where(eq(postEngagementRanks.postId, wrongRank));
    const again = await backfillPostEngagementRanks({
      mode: 'verify',
      dryRun: false,
      throttle: fixedPauseThrottle(0),
    });
    expect(again.missing).toBeGreaterThanOrEqual(1);
    await expectInStep();
  });

  it('counts without writing on a dry run', async () => {
    const id = await seedListed(2);
    await getDb().delete(postEngagementRanks).where(eq(postEngagementRanks.postId, id));
    const dry = await backfillPostEngagementRanks({
      dryRun: true,
      throttle: fixedPauseThrottle(0),
    });
    expect(dry.postsListed).toBeGreaterThanOrEqual(1);
    expect(dry.rowsWritten).toBe(0);
    expect(await rowOf(id)).toBeUndefined();
  });
});
