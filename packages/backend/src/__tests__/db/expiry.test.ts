/**
 * The expiry sweep — the TTL replacement.
 *
 * Three things are checked, and the third is the one a convention could not give
 * you: that every swept column has the btree its predicate needs. A sweep whose
 * `column <= now() - N` cannot use an index is a full table scan on a schedule,
 * which is exactly the obligation Mongo's TTL index carried implicitly.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getTableName, inArray, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { sqlColumnName } from '../../db/casing';
import { EXPIRY_SWEEP_TARGETS, sweepExpiredRows } from '../../db/expiry';
import { NOTIFICATION_RETENTION_SECONDS, notifications } from '../../db/schema/discovery';
import { NOTIFICATION_TTL_SECONDS } from '../../models/Notification';
import { TRENDING_TTL_SECONDS } from '../../models/Trending';
import { ENGAGEMENT_OUTBOX_RETENTION_SECONDS } from '../../models/EngagementOutbox';
import { TRENDING_RETENTION_SECONDS } from '../../db/schema/discovery';
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
  /**
   * `moderation_outbox` and `moderation_events` had a case each here and no
   * longer can: their Mongoose models are deleted, so there is no second number
   * left to disagree with. Both are named in `REGISTERED_WITHOUT_A_MODEL` below,
   * which is the half that must outlive the model — the sweep is now the only
   * thing bounding those two tables.
   */
});

/** Every `.ts` under `directory`, walked — never a directory someone named. */
function tsFilesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...tsFilesUnder(path));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}

describe('the sweep registry', () => {
  it('covers every model that had a Mongo TTL index', () => {
    // The list is EXACT rather than a floor, and exact in BOTH directions: a
    // table that lost its sweep grows forever with nothing to notice, and one
    // that was never given a sweep is the same failure a merge later. Two of
    // these arrived exactly that way — `mcp_auth_codes` and `trend_graphs`, on
    // separate merges, each a TTL'd collection ported without a registry entry
    // until this file said so.
    //
    // The COUNT is deliberately not restated here; the case below derives it by
    // walking the models, which is the assertion that cannot go stale.
    expect(EXPIRY_SWEEP_TARGETS.map((target) => getTableName(target.table)).sort()).toEqual([
      'author_follower_snapshots',
      'engagement_outbox',
      'feed_interactions',
      'mcp_auth_codes',
      'moderation_events',
      'moderation_outbox',
      'notifications',
      'trend_graphs',
      'trend_summaries',
      'trending',
    ]);
  });

  it('has one entry per model that declares a Mongo TTL index, found by WALKING', () => {
    // This case exists because the list above was wrong, and wrong in a way that
    // repeats. Its comment used to read "the seven enumerated by reading every
    // `expireAfterSeconds` in `src/models/`" — and `McpAuthCode` declared one in
    // `src/mcp/models/`, so the enumeration that produced "seven" could not see
    // it. That is the SAME directory blind spot that hid all three MCP
    // collections from the migration's own collection map, found twice in two
    // different tools.
    //
    // So the count is DERIVED by walking the tree rather than restated. A model
    // that gains a TTL index in a directory nobody thought of now fails here
    // instead of silently never being swept.
    const ttlModels = tsFilesUnder(join(__dirname, '..', '..'))
      .filter((file) => file.includes(`${sep}models${sep}`))
      // A TEST that mentions the option is not a model that declares one, and
      // one such file lives under a `models` directory.
      .filter((file) => !file.includes(`${sep}__tests__${sep}`))
      .filter((file) => readFileSync(file, 'utf8').includes('expireAfterSeconds'));

    expect(
      ttlModels.map((file) => file.slice(file.lastIndexOf(sep) + 1)).sort(),
      'Mongo models declaring a TTL index'
    ).toStrictEqual([
      // Shrinks as models are deleted, and the registry below does NOT — see the
      // note after this assertion. `AuthorFollowerSnapshot` and `FeedInteraction`
      // left this list when their Mongoose models were deleted as orphans; their
      // registry entries stay, because the sweep is about the COLLECTION.
      'EngagementOutbox.ts',
      'Notification.ts',
      'TrendSummary.ts',
      'Trending.ts',
    ]);

    // The two sides do NOT line up one-for-one, and the difference is the point:
    // a collection whose call sites are fully ported has its Mongoose model
    // DELETED, while its registry entry must stay forever — the sweep is the
    // only thing standing between the ported table and unbounded growth. So the
    // registry is the walk PLUS an explicit list of ported collections, each
    // named. An equality would have made finishing a port look like a
    // regression, and the obvious repair (deleting the entry with the model) is
    // precisely the failure this whole file exists to prevent.
    const REGISTERED_WITHOUT_A_MODEL = [
      // `models/AuthorFollowerSnapshot.ts`, deleted as an orphan after the
      // Postgres cutover — nothing imported it any more. Its rows are one
      // follower-count sample per author per run, so the table only grows and the
      // sweep is the only bound.
      'author_follower_snapshots',
      // `models/FeedInteraction.ts`, deleted with it. `FeedInteractionTracker`
      // already wrote `feed_interactions` in Postgres; the model was the last
      // thing referencing the Mongo collection. One row per impression, so
      // unbounded without the sweep.
      'feed_interactions',
      // `mcp/models/McpAuthCode.ts`, deleted when the MCP OAuth surface moved to
      // `mcp_auth_codes`. Mongo reaped these for free; nothing does now but the
      // registry entry.
      'mcp_auth_codes',
      // `models/TrendGraph.ts`, deleted when the trend graph moved to
      // `trend_graphs` — the model arrived from `main` mid-port and was ported and
      // deleted in one merge, so it never appeared in the walk above at all. Its
      // 7-day TTL was the only thing bounding the largest rows in the schema (a
      // whole batch of nodes and edges in two jsonb columns).
      'trend_graphs',
      // `models/ModerationOutbox.ts`, deleted when the CrowdSource delivery queue
      // moved to `moderation_outbox`. A `dead_letter` row is deliberately kept
      // for a human to read and is never claimed again, so nothing else in the
      // system will ever remove one — the 90-day sweep is the whole bound.
      'moderation_outbox',
      // `models/ModerationEvent.ts`, deleted with it. Every row here is a webhook
      // dedupe claim, written once per delivery and never revisited after its
      // handler runs; the id IS the primary key, so the table only grows.
      'moderation_events',
    ];
    expect(EXPIRY_SWEEP_TARGETS).toHaveLength(
      ttlModels.length + REGISTERED_WITHOUT_A_MODEL.length
    );
    const registered = new Set(
      EXPIRY_SWEEP_TARGETS.map((target) => getTableName(target.table))
    );
    for (const table of REGISTERED_WITHOUT_A_MODEL) {
      expect(registered, `${table} lost its sweep along with its Mongoose model`).toContain(table);
    }

    // Vacuity floor. It is anchored to the WALK's reach, not to how many models
    // declare a TTL — that count only falls as models are ported and deleted, so
    // a floor under it has to be lowered every time and stops asserting anything
    // the moment it is set to whatever the current number happens to be. What
    // must never happen is the traversal reaching nothing: a broken `tsFilesUnder`
    // satisfies the equality above between two empty lists, and every model would
    // silently stop being checked. The number of `.ts` files under the package is
    // in the hundreds and is not a function of this port.
    expect(tsFilesUnder(join(__dirname, '..', '..')).length).toBeGreaterThan(200);
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
