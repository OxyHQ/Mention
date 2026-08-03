/**
 * The parent rows a documented resolution decides against, read from POSTGRES.
 *
 * ## Why Postgres, and not the source
 *
 * A rule that removes a row because its parent "does not exist" is answering a
 * question about the database the FOREIGN KEY will check — so that is the
 * database to ask. Reading MongoDB once, before the copy, and holding the
 * answer for the whole run is the shape that fails: production Mongo takes
 * writes throughout the cutover, so the set moves under the run, and a row
 * created inside that window is indistinguishable from one whose parent was
 * deleted years ago.
 *
 * Reading Postgres at the moment the level is copied has none of that:
 *
 * - **It cannot go stale.** It is the same table, within the same transaction
 *   boundary, that the foreign key validates against microseconds later.
 * - **It is COMPLETE by then.** `planLevels` inserts in topological order, so
 *   every parent row this run will ever produce is committed before any level
 *   that references it starts — {@link assertParentsPrecedeChildren} checks
 *   that rather than trusting it.
 *
 * ## What it does NOT fix, and must not pretend to
 *
 * A row written to Mongo AFTER its own level was copied is still not in
 * Postgres, and a child of it copied later still dangles. That is a
 * cutover-design problem — a write freeze, or a delta pass — and nothing here
 * silently reconciles it. What this guarantees is narrower and is the part a
 * predicate CAN own: the rules never remove a row Postgres would have accepted.
 */

import { getTableColumns, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Database } from '../postgres';
import { sqlColumnName } from '../casing';
import { planLevels } from './order';
import { planTables, singlePrimaryKeyProperty, tableName, type CollectionPlan } from './plan';
import { ORPHAN_RESOLUTIONS, parentKeysFrom, type ParentKeys } from './resolutions';

/** Raised when a rule would decide against a parent table not yet copied. */
export class ParentLevelOrderError extends Error {
  constructor(rule: string, parent: string, child: string) {
    super(
      `\`${rule}\` decides against ${parent}, but ${child} is copied in the SAME ` +
        'level or earlier — so when its rows are built, that parent table is ' +
        'not yet complete in Postgres and the rule would read a partial set. ' +
        'The topological order is what makes reading Postgres exact; a rule ' +
        'that outruns it is answering from an incomplete answer.'
    );
    this.name = 'ParentLevelOrderError';
  }
}

/**
 * Check that every rule's parent table is fully copied before the rows that
 * decide against it are built.
 *
 * The whole reason reading Postgres is exact is the topological order — so it
 * is asserted rather than assumed, and asserted against the SAME `planLevels`
 * derivation the copy uses. Without this, a schema change that put a
 * referencing table in its parent's level would silently give the rules a
 * half-filled parent set, which is the stale-snapshot bug again in a new place.
 */
export function assertParentsPrecedeChildren(plans: readonly CollectionPlan[]): void {
  const levelOf = new Map<string, number>();
  for (const [index, level] of planLevels(plans).entries()) {
    for (const plan of level) {
      for (const table of planTables(plan)) levelOf.set(tableName(table), index);
    }
  }

  for (const relation of ORPHAN_RESOLUTIONS) {
    if (relation.trigger !== 'absent-parent') continue;
    const parent = levelOf.get(tableName(relation.targetTable));
    const child = levelOf.get(relation.tableName);
    // A table no plan in this run writes cannot be out of order with anything;
    // the rules stand down for an empty parent set instead.
    if (parent === undefined || child === undefined) continue;
    if (parent < child) continue;
    throw new ParentLevelOrderError(
      relation.rule.id,
      tableName(relation.targetTable),
      relation.tableName
    );
  }
}

/** Raised when a parent table cannot be read as a key set. */
export class UnreadableParentTableError extends Error {
  constructor(table: string, reason: string) {
    super(
      `Cannot read the parent key set of ${table}: ${reason}. A documented ` +
        'resolution decides whether to REMOVE rows by asking whether this ' +
        'table holds their parent, so an unreadable answer must stop the run ' +
        'rather than produce a different one.'
    );
    this.name = 'UnreadableParentTableError';
  }
}

/**
 * Load every primary key of the given tables, from Postgres.
 *
 * One statement per table, selecting one indexed column. Returns an empty
 * {@link ParentKeys} when no rule needs one, so a run with no declared
 * resolutions costs nothing rather than "one wasted `select id from posts`".
 *
 * That is no longer the current state: `ORPHAN_RESOLUTIONS` declares four
 * relations against `posts`, so `parentTablesForRules()` returns it and this
 * DOES read every post id. The sentence above described the empty-rules era and
 * is kept because the zero-cost property still holds for a table no rule names
 * — but do not read it as "this never loads anything".
 */
export async function loadParentKeys(
  db: Database,
  tables: readonly PgTable[]
): Promise<ParentKeys> {
  const loaded = new Map<string, ReadonlySet<string>>();

  for (const table of tables) {
    const name = tableName(table);
    const property = singlePrimaryKeyProperty(table);
    if (property === null) {
      throw new UnreadableParentTableError(name, 'it has no single-column primary key');
    }
    // Reached through `getTableColumns` from the package ROOT — the same module
    // `sqlColumnName` takes its `Column` from — because the `pg-core` subpath
    // can declare a structurally incompatible `PgColumn`.
    const column = getTableColumns(table)[property];
    if (column === undefined) {
      throw new UnreadableParentTableError(name, `its primary key ${property} is not a column`);
    }

    // Written as raw SQL over the table and column NAMES rather than through
    // the query builder, because this is generic over a `PgTable` the caller
    // chooses. `sqlColumnName` is what keeps it from asking for the TypeScript
    // property name — the trap `db/casing.ts` exists to close.
    const rows = await db.execute<{ key: string | null }>(
      sql`select ${sql.identifier(sqlColumnName(column))} as key from ${sql.identifier(name)}`
    );
    const keys = new Set<string>();
    for (const row of rows) if (typeof row.key === 'string') keys.add(row.key);
    loaded.set(name, keys);
  }

  return parentKeysFrom(loaded);
}
