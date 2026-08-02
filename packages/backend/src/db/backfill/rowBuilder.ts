/**
 * The one place a backfill row is constructed — and the only defence against
 * drizzle's most dangerous behaviour for a migration.
 *
 * ## The trap
 *
 * `db.insert(t).values({ ... })` keys its object by the column's TypeScript
 * PROPERTY name and **silently ignores any key that is not one**. A typo
 * (`oxyUserID`), a dot path copied from Mongo (`'content.text'`), or a column
 * that was renamed on the Postgres side produces a row that is missing that
 * value, with no error, no warning and no type failure when the values object
 * is assembled dynamically. For a one-shot backfill that is the worst possible
 * failure mode: the run reports success and the data is quietly incomplete.
 *
 * `buildRow` turns each of those into a throw that NAMES the table and the key.
 *
 * ## Four distinct checks, because they catch four distinct mistakes
 *
 * 1. **Unknown key** — the trap above. A key that is not a column property.
 * 2. **Generated column** — this schema has four (`posts.search_vector`,
 *    `gifs.search_vector`, `posts.geo`, `posts.content_geo`), all
 *    `GENERATED ALWAYS ... STORED`. Postgres rejects a write with SQLSTATE
 *    `428C9`, but only once the statement reaches the server, i.e. after the
 *    batch is assembled and against a real database. Rejecting here means a
 *    transform that tries to carry the Mongo value across fails in a unit test
 *    instead of at hour three of a production run.
 * 3. **An `undefined` value for any key.** A transform has exactly two ways to
 *    say "no value": supply `null` (write SQL NULL) or OMIT the key (let the
 *    column default apply). `undefined` means neither of those reliably — for a
 *    `NOT NULL DEFAULT` column the two answers differ, and picking the wrong
 *    one is either a `23502` at hour three or a column silently overwritten
 *    with NULL. Forcing the choice at the transform is the only way it stays
 *    reviewable.
 * 4. **Missing required value** — a column that is `NOT NULL` with no default
 *    and no supplied value (217 of this schema's 806 columns are in that
 *    class). Postgres would raise `23502`, naming the column but not the source
 *    document; this names both while the document is in hand.
 *
 * A `null` supplied for a `NOT NULL` column is a MISSING value, not a present
 * one: that distinction is the whole point of check 4, since Mongo's "field
 * absent" and Mongoose's "field null" both arrive here as `null`/`undefined`.
 *
 * ## Why not just rely on the types
 *
 * A hand-written `values({...})` literal IS type-checked, and a transform is
 * written that way wherever the shape is static. But a backfill also builds
 * rows from Mongo documents whose shape TypeScript cannot know, and
 * `Record<string, unknown>` erases exactly the guarantee that matters.
 * `buildRow` restores it at runtime, so both shapes are covered.
 */

import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';

/** Raised when a row cannot be built. Always names the table and the column. */
export class BackfillRowError extends Error {
  constructor(
    readonly table: string,
    readonly column: string,
    message: string,
    readonly documentId?: string
  ) {
    super(
      `${table}.${column}: ${message}` +
        (documentId === undefined ? '' : ` (source _id ${documentId})`)
    );
    this.name = 'BackfillRowError';
  }
}

interface TableShape {
  /** Column PROPERTY names — what `values()` is keyed by. */
  readonly properties: ReadonlySet<string>;
  /** Property names of `GENERATED ALWAYS ... STORED` columns. */
  readonly generated: ReadonlySet<string>;
  /** Property names that are `NOT NULL` with no default and not generated. */
  readonly required: ReadonlySet<string>;
}

const shapeCache = new WeakMap<PgTable, TableShape>();

/**
 * Column property names, generated columns and required columns for a table.
 *
 * Read from the live drizzle metadata rather than a hand-maintained list, so a
 * schema change cannot leave this behind. Cached per table because
 * `getTableConfig` walks every column and the backfill calls this per ROW.
 */
export function tableShape(table: PgTable): TableShape {
  const cached = shapeCache.get(table);
  if (cached) return cached;

  const config = getTableConfig(table);
  const properties = new Set<string>();
  const generated = new Set<string>();
  const required = new Set<string>();

  for (const column of config.columns) {
    // `column.name` on a drizzle column is the TypeScript PROPERTY name, which
    // is exactly what `values()` is keyed by. It is NOT the SQL name — that is
    // `sqlColumnName(column)` from `db/casing.ts`, and conflating the two is
    // the trap that file exists to close.
    const property = column.name;
    properties.add(property);
    if (column.generated) {
      generated.add(property);
      continue;
    }
    if (column.notNull && !column.hasDefault) required.add(property);
  }

  const shape: TableShape = { properties, generated, required };
  shapeCache.set(table, shape);
  return shape;
}

/**
 * Validate a values object against a table and return it unchanged.
 *
 * @param table The drizzle table the row will be inserted into.
 * @param values Column PROPERTY name → value.
 * @param documentId The source Mongo `_id`, quoted in any error.
 * @throws {BackfillRowError} On an unknown key, a generated column, an
 *   `undefined` value, or a missing required value.
 */
export function buildRow(
  table: PgTable,
  values: Record<string, unknown>,
  documentId?: string
): Record<string, unknown> {
  const { properties, generated, required } = tableShape(table);
  const name = getTableConfig(table).name;

  for (const key of Object.keys(values)) {
    if (!properties.has(key)) {
      throw new BackfillRowError(
        name,
        key,
        'is not a column of this table — drizzle would have DROPPED it silently. ' +
          `Known columns: ${[...properties].sort().join(', ')}`,
        documentId
      );
    }
    if (generated.has(key)) {
      throw new BackfillRowError(
        name,
        key,
        'is a GENERATED ALWAYS column and must never be written; ' +
          'Postgres derives it from its source columns',
        documentId
      );
    }
    if (values[key] === undefined) {
      throw new BackfillRowError(
        name,
        key,
        'was given `undefined`. Supply `null` to write SQL NULL, or OMIT the ' +
          'key to let the column default apply — the two differ and the ' +
          'transform has to choose',
        documentId
      );
    }
  }

  for (const property of required) {
    const value = values[property];
    if (value === undefined || value === null) {
      throw new BackfillRowError(
        name,
        property,
        `is NOT NULL with no default but the source document supplied ${
          property in values ? 'null' : 'nothing'
        }`,
        documentId
      );
    }
  }

  return values;
}
