/**
 * Columns That Must Not Reach a Client
 *
 * Mongoose has `select: false`; **Mention uses it nowhere**, on any model. That
 * is not a reason to skip this module — it is the reason to have it. A column
 * only stays out of a response because no DTO happens to include it, and
 * drizzle's `db.select().from(t)` returns EVERY column, so the first naive query
 * over a table holding a secret is the first time that secret can leave the
 * process.
 *
 * The registry is EMPTY today because Mention holds no secret at rest: the one
 * it had, `actor_key_pairs.private_key_pem`, was dropped by migration 0059 once
 * signing moved to oxy-api. The mechanism stays so the next secret column is
 * registered here rather than protected by convention. Its value is
 * `__tests__/db/protectedColumns.test.ts`, which scans `src/` for the two shapes
 * that return every column IMPLICITLY — a bare `select()` and the relational
 * `db.query.<table>` API — against any table named here, and fails with the
 * offending `file:line`.
 *
 * ## The mechanism
 *
 * 1. **The registry is data** (`PROTECTED_COLUMNS_BY_TABLE`), one entry per
 *    column with the reason — the same shape as `deferredForeignKeys.ts`, and
 *    for the same reason: a rule written only in a comment is a rule nothing
 *    checks.
 * 2. **`publicColumns(table)` is the sanctioned read.** It omits every
 *    protected column AT THE TYPE LEVEL once the table is added to
 *    {@link ProtectedPropertyOf}, so a serializer that tries to read one fails
 *    `tsc` rather than shipping it. That is the part a convention cannot give you.
 * 3. **Opting in is explicit and greppable.** A path that needs the secret names
 *    the column in its selection object. There is deliberately no helper for
 *    this — the whole point is that it reads differently from an ordinary select.
 */

import { getTableColumns, getTableName } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
/** One protected column, with the reason it is protected. */
export interface ProtectedColumn {
  readonly table: PgTable;
  /** The TypeScript property name on the table. */
  readonly property: string;
  readonly reason: string;
}

/**
 * The registry, with a reason per column. Empty: Mention holds no secret at rest
 * (see the module comment).
 */
export const PROTECTED_COLUMNS: readonly ProtectedColumn[] = [];

/**
 * The machine-readable form: table SQL name → protected property names.
 *
 * Derived from `PROTECTED_COLUMNS` rather than written twice, so the two cannot
 * disagree about what is protected.
 */
export const PROTECTED_COLUMNS_BY_TABLE: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const byTable = new Map<string, Set<string>>();
  for (const entry of PROTECTED_COLUMNS) {
    const name = getTableName(entry.table);
    const properties = byTable.get(name) ?? new Set<string>();
    properties.add(entry.property);
    byTable.set(name, properties);
  }
  return byTable;
})();

/**
 * The columns of `table` that are safe to hand to a client, as a drizzle
 * selection object.
 *
 * The return type is computed with `Omit`, so a protected column is absent from
 * the row type — reading a protected property is a compile error, not a
 * runtime leak.
 */
export function publicColumns<T extends PgTable>(
  table: T
): Omit<T['_']['columns'], ProtectedPropertyOf<T>> {
  const protectedProperties = PROTECTED_COLUMNS_BY_TABLE.get(getTableName(table));
  const columns = getTableColumns(table);
  if (!protectedProperties) {
    return columns as Omit<T['_']['columns'], ProtectedPropertyOf<T>>;
  }

  const selection: Record<string, PgColumn> = {};
  for (const [property, column] of Object.entries(columns)) {
    if (protectedProperties.has(property)) continue;
    selection[property] = column;
  }
  return selection as Omit<T['_']['columns'], ProtectedPropertyOf<T>>;
}

/**
 * The protected property names of one table, as a literal union.
 *
 * Written as a conditional over the table's TypeScript type rather than read
 * from the runtime map, because the map is `string`-keyed and would widen the
 * exclusion to `string` — which `Omit` treats as "remove nothing recognisable",
 * silently restoring the very property this module exists to hide. A table added
 * to {@link PROTECTED_COLUMNS} gets a branch here too:
 *
 *   T['_']['name'] extends 'some_table' ? 'secretColumn' : never
 */
type ProtectedPropertyOf<T extends PgTable> = T extends PgTable ? never : never;
