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
import { sqlColumnName } from '../../db/casing';
import { EXPIRY_SWEEP_TARGETS, sweepExpiredRows } from '../../db/expiry';
import { NOTIFICATION_RETENTION_SECONDS, notifications } from '../../db/schema/discovery';
import { NOTIFICATION_TTL_SECONDS } from '../../models/Notification';
import { TRENDING_TTL_SECONDS } from '../../models/Trending';
import { ENGAGEMENT_OUTBOX_RETENTION_SECONDS } from '../../models/EngagementOutbox';
import { MODERATION_EVENT_RETENTION_SECONDS } from '../../models/ModerationEvent';
import { MODERATION_OUTBOX_RETENTION_SECONDS } from '../../models/ModerationOutbox';
import { TRENDING_RETENTION_SECONDS } from '../../db/schema/discovery';
import {
  MODERATION_EVENT_RETENTION_SECONDS as PG_MODERATION_EVENT_RETENTION_SECONDS,
  MODERATION_OUTBOX_RETENTION_SECONDS as PG_MODERATION_OUTBOX_RETENTION_SECONDS,
} from '../../db/schema/moderation';
import { ENGAGEMENT_OUTBOX_RETENTION_SECONDS as PG_ENGAGEMENT_OUTBOX_RETENTION_SECONDS } from '../../db/schema/outbox';

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

describe('the retention constants still equal the Mongoose models\'', () => {
  // Both stores are live during the migration, so a retention window changed on
  // one side and not the other would silently give the two different lifetimes.
  it('notifications', () => {
    expect(NOTIFICATION_RETENTION_SECONDS).toBe(NOTIFICATION_TTL_SECONDS);
  });
  it('trending', () => {
    expect(TRENDING_RETENTION_SECONDS).toBe(TRENDING_TTL_SECONDS);
  });
  it('engagement outbox', () => {
    expect(PG_ENGAGEMENT_OUTBOX_RETENTION_SECONDS).toBe(ENGAGEMENT_OUTBOX_RETENTION_SECONDS);
  });
  it('moderation outbox', () => {
    expect(PG_MODERATION_OUTBOX_RETENTION_SECONDS).toBe(MODERATION_OUTBOX_RETENTION_SECONDS);
  });
  it('moderation events', () => {
    expect(PG_MODERATION_EVENT_RETENTION_SECONDS).toBe(MODERATION_EVENT_RETENTION_SECONDS);
  });
});

describe('the sweep registry', () => {
  it('covers every model that had a Mongo TTL index', () => {
    // Eight: the seven enumerated by reading every `expireAfterSeconds` in
    // `src/models/`, plus `trend_summaries`, which was born on Postgres and
    // therefore never had a Mongo TTL index to be found that way. A vacuity
    // floor as much as a count: a broken registry export would make every
    // assertion below iterate nothing.
    expect(EXPIRY_SWEEP_TARGETS).toHaveLength(8);
    expect(EXPIRY_SWEEP_TARGETS.map((target) => getTableName(target.table)).sort()).toEqual([
      'author_follower_snapshots',
      'engagement_outbox',
      'feed_interactions',
      'moderation_events',
      'moderation_outbox',
      'notifications',
      'trend_summaries',
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
