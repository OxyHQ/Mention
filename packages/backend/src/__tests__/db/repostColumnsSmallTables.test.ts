/**
 * The smaller tables of the boost -> repost rename (migrations 0127, 0128): each has an
 * old and a new column kept equal by a trigger, whichever name a writer used.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { backfillAuthorPostCountsReposts } from '../../scripts/backfillRepostColumns';

let db: Database;
const ID = `repost-small-${process.pid}-${Date.now()}`;

beforeAll(async () => {
  db = await connectPostgres();
});
afterAll(async () => {
  await db.execute(sql`delete from author_post_counts where oxy_user_id = ${ID}`);
  await db.execute(sql`delete from user_settings where oxy_user_id = ${ID}`);
  await closePostgres();
});

const one = async <T>(query: ReturnType<typeof sql>) => (await db.execute<T>(query))[0];

describe('author_post_counts', () => {
  it('follows either name on insert and update, and the backfill levels a row the trigger never saw', async () => {
    await db.execute(
      sql`insert into author_post_counts (oxy_user_id, boosts_count) values (${ID}, 3)`,
    );
    expect(
      await one(sql`select reposts_count from author_post_counts where oxy_user_id = ${ID}`),
    ).toEqual({ reposts_count: 3 });

    await db.execute(
      sql`update author_post_counts set reposts_count = reposts_count + 2 where oxy_user_id = ${ID}`,
    );
    expect(
      await one(sql`select boosts_count from author_post_counts where oxy_user_id = ${ID}`),
    ).toEqual({ boosts_count: 5 });
    await db.execute(
      sql`update author_post_counts set boosts_count = boosts_count - 1 where oxy_user_id = ${ID}`,
    );
    expect(
      await one(sql`select reposts_count from author_post_counts where oxy_user_id = ${ID}`),
    ).toEqual({ reposts_count: 4 });

    await db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.execute(
        sql`update author_post_counts set boosts_count = 9 where oxy_user_id = ${ID}`,
      );
    });
    expect(
      await backfillAuthorPostCountsReposts({ authorIds: [ID], dryRun: true, pauseMs: 0 }),
    ).toBe(1);
    expect(
      await backfillAuthorPostCountsReposts({ authorIds: [ID], batchSize: 1, pauseMs: 0 }),
    ).toBe(1);
    expect(
      await one(sql`select reposts_count from author_post_counts where oxy_user_id = ${ID}`),
    ).toEqual({ reposts_count: 9 });
    expect(await backfillAuthorPostCountsReposts({ authorIds: [ID], pauseMs: 0 })).toBe(0);
  });
});

describe('a default-true flag (user_settings.notify_*)', () => {
  it('keeps a false written under either name, and follows an update of either', async () => {
    await db.execute(
      sql`insert into user_settings (id, oxy_user_id, notify_boosts) values (${ID}, ${ID}, false)`,
    );
    expect(
      await one(sql`select notify_reposts from user_settings where oxy_user_id = ${ID}`),
    ).toEqual({ notify_reposts: false });

    await db.execute(sql`update user_settings set notify_reposts = true where oxy_user_id = ${ID}`);
    expect(
      await one(sql`select notify_boosts from user_settings where oxy_user_id = ${ID}`),
    ).toEqual({ notify_boosts: true });
    await db.execute(sql`update user_settings set notify_boosts = false where oxy_user_id = ${ID}`);
    expect(
      await one(sql`select notify_reposts from user_settings where oxy_user_id = ${ID}`),
    ).toEqual({ notify_reposts: false });
  });
});
