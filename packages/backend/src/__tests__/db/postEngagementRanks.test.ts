/**
 * `post_engagement_ranks` is `posts`' popular order, kept in step by triggers.
 *
 * Four claims, each of which the banded popular read
 * (`db/posts/engagementRankScan.ts`) depends on and none of which a feed test
 * would notice going false until a ranking drifted:
 *
 *  1. `post_engagement_rank()` (SQL, migration 0141) computes EXACTLY
 *     `engagementRankSql` (TypeScript, the weights in `MtnConfig`): the same
 *     float8 for every counter combination, so a retuned weight that is not
 *     carried into a migration fails here instead of silently reordering the
 *     popular feeds by stale weights.
 *  2. The triggers (0142) keep the table equal to its definition through every
 *     write that changes membership or a stored column: insert, counter bumps,
 *     the rank returning to 0, visibility and status, `created_at`, `is_reply`,
 *     languages, id, delete.
 *  3. `backfillPostEngagementRanks` copies what predates the triggers without
 *     overwriting what they wrote, and its `verify` mode finds and repairs every
 *     kind of mismatch.
 *  4. The positive run is an ordered index scan that stops at the page, and the
 *     schema around it is in place (`fillfactor`, the expression statistics).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { MtnConfig, PostVisibility } from '@mention/shared-types';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { engagementRankSql, postEngagementRanks, posts } from '../../db/schema/posts';
import { backfillPostEngagementRanks } from '../../scripts/backfillPostEngagementRanks';
import { fixedPauseThrottle } from '../../scripts/lib/backfillThrottle';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';

const scope = postScope('post-engagement-ranks');
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

describe('post_engagement_rank() is engagementRankSql', () => {
  it('returns the same float8 for every counter combination', async () => {
    // Every term alone, every pair, the floored native-repost term on both sides
    // of 0, negative counters, and magnitudes where float8 rounding would show a
    // different order of operations.
    const values = [0, 1, 2, 3, 7, 1000, 123_456, -1, -5];
    const tuples: [number, number, number, number][] = [];
    for (const likes of values)
      for (const reposts of [0, 1, 4, 9])
        for (const federated of [0, 1, 3, 9])
          for (const comments of [0, 1, 5, -2]) tuples.push([likes, reposts, federated, comments]);

    const [{ mismatches, checked }] = await getDb().execute<{
      mismatches: number;
      checked: number;
    }>(sql`
      with t(likes, reposts, federated, comments) as (
        select * from unnest(
          ${sql.param(tuples.map((t) => t[0]))}::int[], ${sql.param(tuples.map((t) => t[1]))}::int[],
          ${sql.param(tuples.map((t) => t[2]))}::int[], ${sql.param(tuples.map((t) => t[3]))}::int[])
      )
      select count(*) filter (where
        float8send(post_engagement_rank(likes, reposts, federated, comments))
        <> float8send(${engagementRankSql({
          statsLikesCount: sql`t.likes`,
          statsRepostsCount: sql`t.reposts`,
          statsFederatedRepostsCount: sql`t.federated`,
          statsCommentsCount: sql`t.comments`,
        })}))::int as mismatches,
        count(*)::int as checked
      from t
    `);
    expect(checked).toBe(tuples.length);
    expect(mismatches).toBe(0);
  });

  it('carries the weights MtnConfig ranks by, in order', async () => {
    const [{ def }] = await getDb().execute<{ def: string }>(
      sql`select pg_get_functiondef('post_engagement_rank(integer,integer,integer,integer)'::regprocedure) as def`,
    );
    const weights = [
      ...def.matchAll(/\(([\d.]+)\)::double precision|([\d.]+)::double precision/g),
    ].map((match) => Number(match[1] ?? match[2]));
    const cfg = MtnConfig.ranking.engagement;
    expect(weights).toEqual([
      cfg.likeWeight,
      cfg.boostWeight,
      cfg.federatedBoostWeight,
      cfg.commentWeight,
    ]);
  });
});

describe('the triggers keep the table in step with posts', () => {
  it('through the life of a post', async () => {
    const id = await seed();
    expect(await rowOf(id)).toBeUndefined(); // rank 0: not stored
    await expectInStep();

    const bump = (set: Partial<typeof posts.$inferInsert>) =>
      getDb().update(posts).set(set).where(eq(posts.id, id));

    await bump({ statsLikesCount: 1 });
    expect((await rowOf(id))?.engagementRank).toBe(1);
    await bump({ statsRepostsCount: 2, statsFederatedRepostsCount: 1 });
    expect((await rowOf(id))?.engagementRank).toBe(1 + 2.5 + 0.5);
    await bump({ statsCommentsCount: 3 });
    await expectInStep();

    // Membership: private, back to public, unpublished, back again.
    await bump({ visibility: PostVisibility.FOLLOWERS_ONLY });
    expect(await rowOf(id)).toBeUndefined();
    await bump({ visibility: PostVisibility.PUBLIC });
    await expectInStep();
    await bump({ status: 'draft' });
    expect(await rowOf(id)).toBeUndefined();
    await bump({ status: 'published' });
    await expectInStep();

    // The stored columns.
    await bump({ createdAt: new Date(Date.now() - 3_600_000) });
    await bump({ classificationLanguages: ['es'], translatedLanguages: ['fr'] });
    await bump({ translatedLanguages: null });
    await expectInStep();
    expect((await rowOf(id))?.languages).toEqual(['es']);

    // A whole-row write that repeats unchanged values changes nothing.
    const before = await rowOf(id);
    await bump({ statsCommentsCount: 3, visibility: PostVisibility.PUBLIC });
    expect(await rowOf(id)).toEqual(before);

    // Back to rank 0, then gone.
    await bump({
      statsLikesCount: 0,
      statsRepostsCount: 0,
      statsFederatedRepostsCount: 0,
      statsCommentsCount: 0,
    });
    expect(await rowOf(id)).toBeUndefined();
    await bump({ statsLikesCount: 4 });
    await expectInStep();
    await getDb().delete(posts).where(eq(posts.id, id));
    expect(await rowOf(id)).toBeUndefined();
  });

  it('for replies, a listed insert, a negative rank and a new id', async () => {
    const parent = await seed();
    const reply = await seed({ parentPostId: parent });
    await getDb().update(posts).set({ statsLikesCount: 2 }).where(eq(posts.id, reply));
    expect((await rowOf(reply))?.isReply).toBe(true);

    // Counters are floored on write, but nothing else floors them. (The reply
    // counted itself on the parent, so that counter is reset too.)
    await getDb()
      .update(posts)
      .set({ statsLikesCount: -3, statsCommentsCount: 0 })
      .where(eq(posts.id, parent));
    expect((await rowOf(parent))?.engagementRank).toBe(-3);

    // The INSERT trigger: a post that arrives with engagement (an import).
    const [imported] = await getDb()
      .insert(posts)
      .values({
        oxyUserId: scope.user('author'),
        type: 'text',
        visibility: 'public',
        status: 'published',
        statsLikesCount: 5,
      })
      .returning({ id: posts.id });
    mine.push(imported.id);
    expect((await rowOf(imported.id))?.engagementRank).toBe(5);

    // An id change moves the row.
    const moved = `${imported.id.slice(0, -4)}beef`;
    await getDb().update(posts).set({ id: moved }).where(eq(posts.id, imported.id));
    mine.push(moved);
    expect(await rowOf(imported.id)).toBeUndefined();
    expect((await rowOf(moved))?.engagementRank).toBe(5);
    await expectInStep();
  });
});

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

describe('the schema around it', () => {
  it('serves the positive run from its index, in order, without a sort', async () => {
    await seed();
    const plan = await getDb().transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      await tx.execute(sql`set local enable_sort = off`);
      const rows = await tx.execute<Record<string, string>>(sql`
        explain select r.post_id from post_engagement_ranks r
        join posts p on p.id = r.post_id
        where r.engagement_rank > 0 and r.is_reply = false and r.languages && array['es']
          and r.created_at >= now() - interval '7 days' and p.visibility = 'public'
        order by r.engagement_rank desc nulls last, r.created_at desc nulls last, r.post_id desc nulls last
        limit 31
      `);
      return rows.map((row) => Object.values(row)[0]).join('\n');
    });
    expect(plan).toMatch(/Index Only Scan using post_engagement_ranks_rank_idx/);
    expect(plan).not.toMatch(/\bSort\b/);
  });

  it('declares the index, the fillfactor and the expression statistics', async () => {
    const [{ def }] = await getDb().execute<{ def: string }>(
      sql`select pg_get_indexdef('post_engagement_ranks_rank_idx'::regclass) as def`,
    );
    expect(def).toBe(
      'CREATE INDEX post_engagement_ranks_rank_idx ON public.post_engagement_ranks USING btree ' +
        '(engagement_rank DESC NULLS LAST, created_at DESC NULLS LAST, post_id DESC NULLS LAST, is_reply, languages)',
    );
    const [{ options }] = await getDb().execute<{ options: string[] | null }>(
      sql`select reloptions as options from pg_class where oid = 'posts'::regclass`,
    );
    expect(options).toContain('fillfactor=90');
    const [{ stats }] = await getDb().execute<{ stats: number }>(
      sql`select count(*)::int as stats from pg_statistic_ext where stxname = 'posts_engagement_rank_stats'`,
    );
    expect(stats).toBe(1);
  });
});
