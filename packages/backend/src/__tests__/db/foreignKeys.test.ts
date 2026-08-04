/**
 * The foreign-key gate.
 *
 * `DEFERRED_FOREIGN_KEYS` is a promise written as data; this turns it into a
 * check that goes red the moment the promise comes due. `ID_COLUMNS_WITHOUT_
 * FOREIGN_KEY` plus `isOxyAccountColumn` are its permanent counterpart, and
 * together with the real constraints they mean EVERY id-shaped column in the
 * schema is classified — which is what lets a NEW one, that nobody decided
 * about, fail here instead of shipping unconstrained.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTableName, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import {
  DEFERRED_FOREIGN_KEYS,
  ID_COLUMNS_WITHOUT_FOREIGN_KEY,
  columnLabel,
  idShapedColumns,
  isOxyAccountColumn,
} from '../../db/schema/deferredForeignKeys';
import * as schema from '../../db/schema';

let db: Database;

/** Every table the barrel exports. */
function declaredTables(): PgTable[] {
  return Object.values(schema).filter(
    (value): value is PgTable =>
      typeof value === 'object' && value !== null && Symbol.for('drizzle:Name') in value
  );
}

/** `table.column` for every column that carries a real FK in the migrated database. */
async function constrainedColumns(): Promise<Set<string>> {
  const rows = await db.execute<{ table_name: string; column_name: string }>(sql`
    select cl.relname as table_name, a.attname as column_name
    from pg_constraint c
    join pg_class cl on cl.oid = c.conrelid
    join pg_namespace n on n.oid = cl.relnamespace
    join unnest(c.conkey) as k(attnum) on true
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    where c.contype = 'f' and n.nspname = 'public'
  `);
  return new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('deferred foreign keys', () => {
  it('has an empty ledger — the finish line', () => {
    // A non-empty ledger is legitimate WHILE a table is landing ahead of its
    // parent. What must never happen is an entry whose parent has since landed.
    expect(DEFERRED_FOREIGN_KEYS).toEqual([]);
  });

  it('names a parent table that does not yet exist, for every entry', () => {
    const existing = new Set(declaredTables().map(getTableName));
    const overdue = DEFERRED_FOREIGN_KEYS.filter((entry) => existing.has(entry.parentTable)).map(
      (entry) => `${columnLabel(entry.column)} -> ${entry.parentTable}.${entry.parentColumn}`
    );
    expect(overdue).toEqual([]);
  });
});

describe('id-shaped column classification', () => {
  it('finds id-shaped columns to classify', async () => {
    // Vacuity floor. `idShapedColumns` matches on the SQL name via
    // `sqlColumnName`; if it were matching the TypeScript property name instead
    // it would find NOTHING and every assertion below would pass trivially.
    const total = declaredTables().reduce(
      (count, table) => count + idShapedColumns(table).length,
      0
    );
    expect(total).toBeGreaterThan(40);
  });

  it('classifies every id-shaped column', async () => {
    const constrained = await constrainedColumns();
    const declaredExceptions = new Set(
      ID_COLUMNS_WITHOUT_FOREIGN_KEY.map((entry) => columnLabel(entry.column))
    );
    const deferred = new Set(DEFERRED_FOREIGN_KEYS.map((entry) => columnLabel(entry.column)));

    const unclassified: string[] = [];
    for (const table of declaredTables()) {
      for (const column of idShapedColumns(table)) {
        const label = columnLabel(column);
        if (constrained.has(label)) continue;
        if (isOxyAccountColumn(column)) continue;
        if (declaredExceptions.has(label)) continue;
        if (deferred.has(label)) continue;
        unclassified.push(label);
      }
    }

    // Every entry here is an id-shaped column with no foreign key that nobody
    // has decided about. Add a real `.references(...)`, or an entry in
    // `ID_COLUMNS_WITHOUT_FOREIGN_KEY` with the reason.
    expect(unclassified).toEqual([]);
  });

  it('holds no stale exception for a column that now carries a constraint', async () => {
    const constrained = await constrainedColumns();
    const stale = ID_COLUMNS_WITHOUT_FOREIGN_KEY.map((entry) => columnLabel(entry.column)).filter(
      (label) => constrained.has(label)
    );
    expect(stale).toEqual([]);
  });

  it('gives every exception a reason', () => {
    const missing = ID_COLUMNS_WITHOUT_FOREIGN_KEY.filter(
      (entry) => entry.reason.trim().length < 20
    ).map((entry) => columnLabel(entry.column));
    expect(missing).toEqual([]);
  });
});

describe('ON DELETE is decided per relation', () => {
  it('declares an explicit action on every foreign key', async () => {
    // Postgres's default is NO ACTION, which drizzle emits when `onDelete` is
    // omitted. Every relation in this schema states its choice, so a constraint
    // reporting the default is one nobody decided about.
    const rows = await db.execute<{
      constraint_name: string;
      table_name: string;
      confdeltype: string;
    }>(sql`
      select c.conname as constraint_name, cl.relname as table_name, c.confdeltype
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid
      join pg_namespace n on n.oid = cl.relnamespace
      where c.contype = 'f' and n.nspname = 'public'
      order by 1
    `);

    expect(rows.length).toBeGreaterThan(20);
    // `a` = NO ACTION (the default nobody chose). `c` = CASCADE, `n` = SET NULL,
    // `r` = RESTRICT, `d` = SET DEFAULT.
    const undecided = rows.filter((row) => row.confdeltype === 'a').map((row) => row.constraint_name);
    expect(undecided).toEqual([]);
  });
});
