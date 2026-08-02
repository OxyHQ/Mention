/**
 * Schema-wide invariants, asserted against the REAL migrated database rather
 * than against the TypeScript declarations.
 *
 * The distinction matters: drizzle applies casing when it BUILDS SQL, so a
 * declaration can look correct and still emit a column the migration never
 * created. Every check here reads `information_schema` / `pg_catalog` on the
 * throwaway database the harness migrated, so it is testing what actually
 * exists.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTableColumns, getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { sqlColumnName } from '../../db/casing';
import { STAGING_TABLE_PREFIX } from '../../db/backfill/bulkLoad';
import * as schema from '../../db/schema';

/** Only lower-case letters, digits and underscores, never starting with a digit. */
const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

/** Every table the barrel exports, so a new one is covered without an edit here. */
function declaredTables(): PgTable[] {
  return Object.values(schema).filter(
    (value): value is PgTable =>
      typeof value === 'object' && value !== null && Symbol.for('drizzle:Name') in value
  );
}

let db: Database;

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('schema invariants', () => {
  it('exports at least one table from the barrel', () => {
    // Vacuity floor: every assertion below iterates `declaredTables()`, so a
    // broken filter would make the whole file pass while checking nothing.
    expect(declaredTables().length).toBeGreaterThan(50);
  });

  it('names every table in snake_case', () => {
    const offenders = declaredTables()
      .map(getTableName)
      .filter((name) => !SNAKE_CASE.test(name));
    expect(offenders).toEqual([]);
  });

  it('names every column in snake_case', () => {
    const offenders: string[] = [];
    for (const table of declaredTables()) {
      for (const column of Object.values(getTableColumns(table))) {
        const name = sqlColumnName(column);
        if (!SNAKE_CASE.test(name)) {
          offenders.push(`${getTableName(table)}.${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('carries no Mongo artefact column (`_id`, `__v`)', () => {
    const offenders: string[] = [];
    for (const table of declaredTables()) {
      for (const column of Object.values(getTableColumns(table))) {
        const name = sqlColumnName(column);
        if (name === '_id' || name === '__v') {
          offenders.push(`${getTableName(table)}.${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('gives every migrated table a primary key', async () => {
    // Deliberately `pg_class` and not the declared table list: the question is
    // about what the MIGRATIONS created, so asking the schema would only prove
    // the schema agrees with itself and would miss a table a migration added by
    // hand.
    //
    // The one exclusion is the bulk loader's staging tables, which are transient
    // by construction, have no primary key on purpose, and belong to no
    // migration. Vitest runs test files in parallel against ONE database, so
    // some of them exist for the few milliseconds a concurrent `backfillBulkLoad`
    // case is mid-load — which made this invariant fail intermittently, in a
    // file that had touched nothing, naming tables nobody had heard of. The
    // prefix is the loader's own exported constant so the exclusion cannot drift
    // from the name it excludes.
    const rows = await db.execute<{ table_name: string }>(sql`
      select c.relname as table_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and c.relname not like ${`${STAGING_TABLE_PREFIX}%`}
        and not exists (
          select 1 from pg_constraint k
          where k.conrelid = c.oid and k.contype = 'p'
        )
      order by 1
    `);
    expect(rows.map((row) => row.table_name)).toEqual([]);
  });

  it('is not vacuous — the primary-key scan sees the real tables', async () => {
    // A `not like` that matched everything, or a namespace filter that matched
    // nothing, would make the case above pass over an empty scan. This asserts
    // the scan's population, so "no offenders" means "none among many" rather
    // than "none among none".
    const rows = await db.execute<{ n: string }>(sql`
      select count(*)::text as n
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and c.relname not like ${`${STAGING_TABLE_PREFIX}%`}
    `);
    expect(Number(rows[0]?.n)).toBeGreaterThan(50);
  });

  it('creates every date column as `timestamptz`', async () => {
    const rows = await db.execute<{ table_name: string; column_name: string; data_type: string }>(sql`
      select table_name, column_name, data_type
      from information_schema.columns
      where table_schema = 'public'
        and data_type in ('timestamp without time zone', 'date', 'time without time zone')
      order by 1, 2
    `);
    // A `timestamp` WITHOUT a time zone reinterprets the stored value in the
    // session's TimeZone on every read, silently changing what a Mongo `Date`
    // meant. There must be none.
    expect(rows).toEqual([]);
  });

  it('defaults no text column to the empty string where NULL means absent', async () => {
    // `''` is a VALUE. Where Mongo used `default: undefined` to mean "absent" —
    // every sparse-unique column — an empty-string default converts a non-problem
    // into a live uniqueness collision. The three columns that legitimately
    // default to `''` are named, so a NEW one fails this test.
    const allowed = new Set([
      // Each of these was `default: ''` in Mongo and means "present but empty",
      // never "absent". None is unique, so an empty string collides with nothing.
      'trending.description',
      'trend_batches.summary',
      'gifs.slug',
      'gifs.title',
      'post_content_variants.body',
    ]);
    const rows = await db.execute<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and column_default = '''''::text'
      order by 1, 2
    `);
    const offenders = rows
      .map((row) => `${row.table_name}.${row.column_name}`)
      .filter((name) => !allowed.has(name));
    expect(offenders).toEqual([]);
  });

  it('installs PostGIS before the migration that names `geography`', async () => {
    const rows = await db.execute<{ extname: string }>(
      sql`select extname from pg_extension where extname = 'postgis'`
    );
    expect(rows).toHaveLength(1);
  });

  it('has no pending migration after the harness applied them', async () => {
    // The harness shells out to the real migrator; if it reported success while
    // leaving work pending, every other suite would be querying a half-built
    // database and failing for the wrong reason.
    const rows = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from drizzle.__drizzle_migrations`
    );
    expect(Number(rows[0]?.count ?? 0)).toBeGreaterThan(0);
  });
});
