/**
 * The expiry sweep — the TTL replacement.
 *
 * Three things are checked, and the third is the one a convention could not give
 * you: that every swept column has the btree its predicate needs. A sweep whose
 * `column <= now() - N` cannot use an index is a full table scan on a schedule,
 * which is exactly the obligation Mongo's TTL index carried implicitly.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getTableName, inArray, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { sqlColumnName } from '@oxyhq/db';
import { sweepExpiredRows } from '@oxyhq/db/expiry';
import { EXPIRY_SWEEP_TARGETS } from '../../db/expiry';
import { NOTIFICATION_RETENTION_SECONDS, notifications } from '../../db/schema/discovery';

let db: Database;
const createdNotificationIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  if (createdNotificationIds.length > 0) {
    // `inArray`, never `= any(${jsArray})` in raw `sql`: a JS array interpolated
    // into a tagged template binds as a ROW CONSTRUCTOR, and Postgres answers
    // `op ANY/ALL (array) requires array on right side`.
    await db.delete(notifications).where(inArray(notifications.id, createdNotificationIds));
    createdNotificationIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

/**
 * The retention constants no longer have a second side to be compared against.
 *
 * Three cases lived here — notifications, trending, engagement outbox — each
 * asserting a Postgres constant still equalled its Mongoose model's
 * `expireAfterSeconds`, because both stores were live and a window changed on
 * one side only would have given the two different lifetimes. Mongo is gone, so
 * every one of those numbers is now declared exactly once, beside the table it
 * bounds, and there is nothing left that could disagree with it. The same
 * reasoning retired the `moderation_outbox` and `moderation_events` cases
 * earlier, when their models went.
 *
 * A walk over `src/models/` for `expireAfterSeconds` stood here too, deriving
 * the registry's size rather than restating it, so a model that gained a TTL
 * index in a directory nobody thought of could not silently go unswept. It
 * cannot be ported: there are no models, and no Mongoose to declare a TTL with.
 * What it protected passes to the exact list below, which is exact in BOTH
 * directions and is now the only thing standing between every table here and
 * unbounded growth.
 */
describe('the sweep registry', () => {
  it('covers every table that has no other bound on its growth', () => {
    // The list is EXACT rather than a floor, and exact in BOTH directions: a
    // table that lost its sweep grows forever with nothing to notice, and one
    // that was never given a sweep is the same failure a merge later. Two of
    // these arrived exactly that way — `mcp_auth_codes` and `trend_graphs`, on
    // separate merges, each a TTL'd collection ported without a registry entry
    // until this file said so.
    //
    // Every entry is one Mongo used to reap for free, and each is named with
    // what makes it unbounded now, because the obvious repair when a table's
    // last writer is deleted — dropping its entry too — is exactly the failure
    // this file exists to prevent. The sweep is about the TABLE, never about
    // any code that happened to write it.
    expect(EXPIRY_SWEEP_TARGETS.map((target) => getTableName(target.table)).sort()).toEqual([
      // One follower-count sample per author per run, so it only grows.
      'author_follower_snapshots',
      // A hard ceiling so a stalled dispatcher cannot make it unbounded.
      'engagement_outbox',
      // One row per impression.
      'feed_interactions',
      // The MCP OAuth surface; Mongo reaped these for free, nothing else does.
      'mcp_auth_codes',
      // Every row is a webhook dedupe claim, written once per delivery and never
      // revisited after its handler runs; the id IS the primary key.
      'moderation_events',
      // A `dead_letter` row is deliberately kept for a human to read and is
      // never claimed again, so nothing else will ever remove one.
      'moderation_outbox',
      'notifications',
      // The largest rows in the schema — a whole batch of nodes and edges in two
      // jsonb columns.
      'trend_graphs',
      'trend_summaries',
      // Append-only: a full batch every 30 minutes.
      'trending',
    ]);
  });

  it('gives every entry a reason', () => {
    const missing = EXPIRY_SWEEP_TARGETS.filter((target) => target.reason.trim().length < 40).map(
      (target) => getTableName(target.table)
    );
    expect(missing).toEqual([]);
  });

  it('backs every swept column with a btree index', async () => {
    const rows = await db.execute<{ table_name: string; column_name: string }>(sql`
      select t.relname as table_name, a.attname as column_name
      from pg_index x
      join pg_class i on i.oid = x.indexrelid
      join pg_class t on t.oid = x.indrelid
      join pg_am am on am.oid = i.relam
      join pg_attribute a on a.attrelid = t.oid and a.attnum = x.indkey[0]
      where am.amname = 'btree'
    `);
    const indexed = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));

    const unindexed = EXPIRY_SWEEP_TARGETS.map(
      (target) => `${getTableName(target.table)}.${sqlColumnName(target.column)}`
    ).filter((label) => !indexed.has(label));

    // Without a LEADING btree on the swept column the delete predicate is a
    // sequential scan, which is the obligation Mongo's TTL index carried too.
    expect(unindexed).toEqual([]);
  });
});

describe('sweepExpiredRows', () => {
  /**
   * Inserted through `db.insert(...)`, deliberately NOT through
   * `db.execute(sql\`...\`)`.
   *
   * `db.execute` bypasses drizzle's column mappers, so a `Date` reaches
   * postgres.js unconverted and the driver throws `ERR_INVALID_ARG_TYPE`
   * mid-test. That is the friendly half of the same trap: on the READ side the
   * bypass is SILENT — a `timestamptz` comes back as a raw string and
   * `res.json` ships it as happily as a Date, changing the wire format with
   * nothing to notice.
   */
  async function insertNotification(createdAt: Date): Promise<string> {
    const id = `sweep-${createdAt.getTime()}-${Math.random().toString(16).slice(2)}`;
    await db.insert(notifications).values({
      id,
      recipientId: `r-${id}`,
      actorId: `a-${id}`,
      type: 'like',
      entityId: `e-${id}`,
      entityType: 'post',
      createdAt,
      updatedAt: createdAt,
    });
    createdNotificationIds.push(id);
    return id;
  }

  it('deletes rows past the retention window and keeps the rest', async () => {
    const target = EXPIRY_SWEEP_TARGETS.find(
      (entry) => getTableName(entry.table) === 'notifications'
    );
    if (!target) throw new Error('notifications is not a sweep target');

    const past = new Date(Date.now() - (NOTIFICATION_RETENTION_SECONDS + 3600) * 1000);
    const recent = new Date();
    const expiredId = await insertNotification(past);
    const liveId = await insertNotification(recent);

    const result = await sweepExpiredRows(db, target);
    expect(result.table).toBe('notifications');
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    const remaining = await db.execute<{ id: string }>(
      sql`select id from notifications where id in (${expiredId}, ${liveId})`
    );
    expect(remaining.map((row) => row.id)).toEqual([liveId]);
  });

  it('reports `truncated` when the batch ceiling is reached', async () => {
    const target = EXPIRY_SWEEP_TARGETS.find(
      (entry) => getTableName(entry.table) === 'notifications'
    );
    if (!target) throw new Error('notifications is not a sweep target');

    const past = new Date(Date.now() - (NOTIFICATION_RETENTION_SECONDS + 3600) * 1000);
    await insertNotification(past);
    await insertNotification(past);
    await insertNotification(past);

    // Batching exists so a backlog cannot hold one long transaction open; the
    // remainder has to be visible to the caller rather than silently left.
    const result = await sweepExpiredRows(db, target, { batchSize: 1, maxBatches: 2 });
    expect(result.deleted).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('deletes nothing when no row is past its deadline', async () => {
    const target = EXPIRY_SWEEP_TARGETS.find(
      (entry) => getTableName(entry.table) === 'notifications'
    );
    if (!target) throw new Error('notifications is not a sweep target');

    await insertNotification(new Date());
    const result = await sweepExpiredRows(db, target);
    expect(result.deleted).toBe(0);
    expect(result.truncated).toBe(false);

    const rows = await db.select({ id: notifications.id }).from(notifications);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
