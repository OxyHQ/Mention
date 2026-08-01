/**
 * Column-Naming Authority
 *
 * Schema modules declare columns in camelCase and let drizzle derive the
 * snake_case SQL name. That derivation happens in THREE places that must agree
 * or queries reference columns the migrations never created: `drizzle()` in
 * `config/postgres.ts` (what queries reference), `drizzle-kit` in
 * `drizzle.config.ts` (what the DDL creates), and any code that needs the SQL
 * name for a catalogue lookup. All three read `DATABASE_CASING` from here, so
 * there is one setting rather than three copies to keep in lockstep.
 *
 * The trap this exists to close: `column.name` on a drizzle column is the
 * TypeScript PROPERTY name (`expiresAt`), not the SQL name (`expires_at`) —
 * casing is applied when SQL is built, not when the column is declared. Using
 * `column.name` in hand-written SQL produces `column "expiresAt" does not
 * exist` at runtime, and in a catalogue query it silently matches nothing.
 */

import { getTableName, sql, type Column, type SQL } from 'drizzle-orm';
import { CasingCache } from 'drizzle-orm/casing';
import type { Casing } from 'drizzle-orm/utils';

/** The one naming convention, read by the runtime, the generator, and `sqlColumnName`. */
export const DATABASE_CASING: Casing = 'snake_case';

/** Drizzle's own converter, so this can never disagree with generated SQL. */
const casingCache = new CasingCache(DATABASE_CASING);

/**
 * The SQL name of a column — `expires_at` for a column declared as `expiresAt`.
 *
 * Honours an explicitly-named column (`text('legacy_name')`) exactly as drizzle
 * does, rather than re-deriving from the property name.
 */
export function sqlColumnName(column: Column): string {
  return casingCache.getColumnCasing(column);
}

/**
 * A FULLY QUALIFIED `"table"."column"` reference, for use inside hand-written
 * `sql` — the second guise of the trap above, and the one that costs DATA
 * rather than raising an error.
 *
 * Interpolating a drizzle column into `sql` renders it BARE (`"post_id"`) when
 * its table is not in that statement's `FROM`, which is exactly the case inside
 * a correlated subquery. `where ${likes.postId} = ${posts.id}` renders
 * `where "post_id" = "id"`: both names then resolve against the SUBQUERY's own
 * table, so the predicate compares two of ITS columns to each other, matches
 * nothing, and returns an empty array with **no error at all**. In the sibling
 * oxy-api port this shipped — follow counts read zero on every public profile
 * until an assertion on real rows caught it. Mention's social graph, engagement
 * counters and thread queries are full of the same shape.
 *
 * Qualify every correlated reference, and treat "a correlated subquery returned
 * nothing" as a bug in the SQL until proven otherwise.
 */
export function qualified(column: Column): SQL {
  return sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(sqlColumnName(column))}`;
}
