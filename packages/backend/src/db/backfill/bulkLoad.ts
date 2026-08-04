/**
 * `COPY FROM STDIN` bulk loading, with `ON CONFLICT DO NOTHING` preserved.
 *
 * ## Why COPY, and why it cannot be COPY alone
 *
 * A multi-row `INSERT` still parses and plans one statement per batch and binds
 * every value as a parameter; `COPY` streams a tab-separated payload the server
 * reads without planning anything. On a `posts` collection of this size that is
 * the difference between minutes and a long evening.
 *
 * But `COPY` has no `ON CONFLICT`, and idempotence — "safe to re-run" — is a
 * hard requirement, not a nicety: a one-shot Fargate task can die halfway and
 * the operator's only recovery must be to run it again. So the load is two
 * steps:
 *
 * 1. `COPY` into an UNLOGGED per-batch staging table shaped like the target's
 *    loaded columns. Unlogged means no WAL for the staging copy, which is the
 *    whole point of a table that is dropped seconds later.
 * 2. `INSERT INTO target (…) SELECT … FROM staging ON CONFLICT DO NOTHING`.
 *    One set-based statement; indexes and foreign keys are checked once per
 *    batch as a set rather than per row.
 *
 * Step 2 is where the constraint work happens, and it is NOT skipped — the
 * distinction the whole design rests on. Deferring validation is only sound if
 * the validation still runs.
 *
 * ## Rows are grouped by their COLUMN SET first
 *
 * `buildRow` lets a transform OMIT a key to mean "let the column default
 * apply", which is a different answer from `null`. A `COPY` statement has one
 * fixed column list, so rows are grouped by which columns they supply and each
 * group is copied separately. In practice a collection produces one or two
 * groups; the grouping is what keeps "omitted" from silently becoming NULL.
 *
 * ## The encoder is differential-tested, not trusted
 *
 * Hand-rolling Postgres' text format is the one genuinely dangerous part of
 * using COPY: a wrong escape corrupts data silently, which is the failure this
 * migration exists to avoid. `__tests__/bulkLoad.test.ts` therefore loads the
 * same rows twice — once through this encoder and once through drizzle's
 * parameter binding, which is correct by construction — and asserts the stored
 * values are identical. A divergence fails the build naming the column.
 */

import { getTableColumns } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import type { Sql } from 'postgres';
import { sqlColumnName } from '../casing';

/** A row as a transform produced it: column PROPERTY name → value. */
export type BuiltRow = Record<string, unknown>;

/** Rows sharing one column set, ready for a single `COPY`. */
interface ColumnGroup {
  /** Column PROPERTY names, sorted so the signature is stable. */
  readonly properties: string[];
  readonly rows: BuiltRow[];
}

/**
 * Group rows by which columns they supply.
 *
 * Sorting the property names makes the signature order-independent, so two rows
 * that supply the same columns in a different key order land in one group
 * rather than two.
 */
export function groupByColumnSet(rows: readonly BuiltRow[]): ColumnGroup[] {
  const groups = new Map<string, ColumnGroup>();
  for (const row of rows) {
    const properties = Object.keys(row).sort();
    const signature = properties.join('\u0000');
    const existing = groups.get(signature);
    if (existing) {
      existing.rows.push(row);
      continue;
    }
    groups.set(signature, { properties, rows: [row] });
  }
  return [...groups.values()];
}

/**
 * Postgres `COPY` text format for one value.
 *
 * The format is documented under `COPY`: fields are tab-separated, rows
 * newline-terminated, `\N` is NULL, and backslash, tab, newline and carriage
 * return must be escaped. Everything else is literal.
 *
 * `sqlType` decides the AMBIGUOUS cases, and there are two that matter. A
 * JavaScript array is either a Postgres array literal (`text[]`, `integer[]`)
 * or a JSON array (`jsonb`), and a plain object is either `jsonb` or nothing
 * valid at all — the JS value cannot tell them apart, so the column's declared
 * type is the authority.
 */
export function encodeCopyValue(value: unknown, sqlType: string): string {
  if (value === null || value === undefined) return '\\N';

  const isJsonColumn = sqlType === 'jsonb' || sqlType === 'json';

  if (value instanceof Date) return escapeCopyText(value.toISOString());
  if (typeof value === 'boolean') return value ? 't' : 'f';
  if (typeof value === 'number') return escapeCopyText(String(value));
  if (Array.isArray(value)) {
    return escapeCopyText(isJsonColumn ? JSON.stringify(value) : encodeArrayLiteral(value));
  }
  if (typeof value === 'object') return escapeCopyText(JSON.stringify(value));
  if (typeof value === 'string') return escapeCopyText(value);

  throw new Error(
    `Cannot encode ${typeof value} for a COPY into a ${sqlType} column; the ` +
      'backfill only produces null, boolean, number, string, Date, array and ' +
      'plain-object values'
  );
}

/**
 * A Postgres array literal: `{"a","b"}`.
 *
 * Every element is quoted, so an element containing a comma, a brace, a quote
 * or the literal text `NULL` cannot change the parse. `null` elements are the
 * unquoted keyword — quoting one would store the four-character string.
 */
function encodeArrayLiteral(values: readonly unknown[]): string {
  const parts = values.map((entry) => {
    if (entry === null || entry === undefined) return 'NULL';
    const text =
      entry instanceof Date
        ? entry.toISOString()
        : typeof entry === 'object'
          ? JSON.stringify(entry)
          : String(entry);
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });
  return `{${parts.join(',')}}`;
}

/** Escape the four characters `COPY`'s text format reserves. */
function escapeCopyText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Column PROPERTY name → its SQL type and SQL column name, for one table.
 *
 * Columns come from `getTableColumns` (package root) rather than
 * `getTableConfig(...).columns` (the `pg-core` subpath) because `sqlColumnName`
 * takes drizzle's root-resolved `Column`, and the two subpaths can declare
 * structurally incompatible versions of that type.
 */
function columnMeta(table: PgTable): Map<string, { sqlName: string; sqlType: string }> {
  const meta = new Map<string, { sqlName: string; sqlType: string }>();
  for (const [property, column] of Object.entries(getTableColumns(table))) {
    meta.set(property, { sqlName: sqlColumnName(column), sqlType: column.getSQLType() });
  }
  return meta;
}

/**
 * Fill in the columns drizzle would default in APPLICATION code, which `COPY`
 * knows nothing about.
 *
 * `generatedId()` (`schema/columns.ts`) is a `$defaultFn` calling `uuidv7()`,
 * not a database `DEFAULT` — deliberately, because Postgres 17 has no native
 * `uuidv7()`. So `db.insert(t).values({…})` gets an id and
 * `COPY t (…) FROM STDIN` does not: the column is simply absent from the copy
 * and the row fails `not-null`. Seventy columns in this schema carry a
 * `$defaultFn`, so this is not an edge case.
 *
 * Applying the same functions here makes the COPY path a faithful substitute
 * for drizzle's insert rather than a similar one, which is the property
 * `__tests__/bulkLoad.test.ts` asserts value by value.
 *
 * Idempotence survives because a table reaching this WITHOUT an explicit id is
 * a child table carrying a unique constraint over its natural key
 * (`(post_id, ord)`, `(threadgate_id, ord)`, `(preference_id, key)`, …), so a
 * re-run conflicts there instead of on the id. A child table with no such
 * constraint must supply a DERIVED id from its transform — that is what
 * `childRowId` in `values.ts` is for.
 */
export function applyDefaultFns(table: PgTable, rows: readonly BuiltRow[]): BuiltRow[] {
  const defaults: Array<[string, () => unknown]> = [];
  for (const [property, column] of Object.entries(getTableColumns(table))) {
    const { defaultFn } = column;
    if (typeof defaultFn === 'function') defaults.push([property, defaultFn]);
  }
  if (defaults.length === 0) return [...rows];

  return rows.map((row) => {
    let filled: BuiltRow | null = null;
    for (const [property, defaultFn] of defaults) {
      if (property in row) continue;
      filled ??= { ...row };
      filled[property] = defaultFn();
    }
    return filled ?? row;
  });
}

/**
 * The prefix every staging table's name starts with.
 *
 * Exported so anything that has to RECOGNISE one reads the same constant the
 * loader names it from. A staging table is transient, has no primary key, and
 * belongs to no migration, so a schema-wide invariant that walks `pg_class`
 * would otherwise trip over whichever ones happen to exist at that instant —
 * which it did, intermittently, against the shared test database.
 */
export const STAGING_TABLE_PREFIX = 'mention_backfill_stage_';

/** A staging table name unique to one load, safe to interpolate. */
let stagingCounter = 0;
function nextStagingName(): string {
  stagingCounter += 1;
  return stagingNameFor(stagingCounter);
}

function stagingNameFor(counter: number): string {
  return `${STAGING_TABLE_PREFIX}${process.pid}_${counter}`;
}

/**
 * The name the NEXT load will use, without consuming it.
 *
 * Exported for one test, and the test cannot be written without it: the
 * regression is that a table left behind by a crashed run blocks the next one,
 * so the case has to squat the exact name the loader is about to create. A
 * guessed name — a high counter the run will never reach — produces a test that
 * passes whether or not the fix is present, which is the failure it exists to
 * prevent.
 */
export function peekNextStagingName(): string {
  return stagingNameFor(stagingCounter + 1);
}

/**
 * Load rows into `table` through `COPY` + `INSERT … SELECT … ON CONFLICT DO NOTHING`.
 *
 * @param client The raw `postgres.js` handle. COPY is a protocol-level
 *   operation the ORM does not wrap, so this is one of the two places the
 *   backfill reaches past drizzle (the other is `ANALYZE`).
 * @param table The destination.
 * @param rows Rows as `buildRow` produced them.
 * @returns How many rows were streamed. NOT how many were inserted — with
 *   `ON CONFLICT DO NOTHING` those differ on a re-run, and the caller wants the
 *   count it can compare against the source.
 */
export async function copyRowsInto(
  client: Sql,
  table: PgTable,
  rows: readonly BuiltRow[]
): Promise<number> {
  if (rows.length === 0) return 0;
  const name = getTableConfig(table).name;
  const meta = columnMeta(table);

  for (const group of groupByColumnSet(applyDefaultFns(table, rows))) {
    const columns = group.properties.map((property) => {
      const info = meta.get(property);
      if (!info) {
        throw new Error(
          `${name} has no column with property name ${JSON.stringify(property)} — ` +
            'buildRow should have refused this row before it reached the loader'
        );
      }
      return { property, ...info };
    });

    const staging = nextStagingName();
    const columnList = columns.map((column) => `"${column.sqlName}"`).join(', ');

    // UNLOGGED: the staging table lives for one batch, so writing WAL for it is
    // pure cost. `on commit drop` is not used because the copy runs outside a
    // transaction block here; the explicit drop below is the pair.
    //
    // Dropped FIRST as well, and that is what makes the run genuinely
    // re-runnable rather than only claiming to be. The name is
    // `pid + counter`, and in a container the pid is 1 and the counter restarts
    // at 0 — so every run generates the SAME names. A run that dies hard skips
    // the drop below, and the next run then fails on
    // `relation "mention_backfill_stage_1_51" already exists` — nowhere near
    // the collection at fault, and with the previous failure's cause long since
    // scrolled away.
    //
    // TEMP would drop itself, and is wrong here: the COPY and the INSERT can
    // land on different pooled connections, and a temporary table is invisible
    // to any session but its own.
    await client.unsafe(`drop table if exists "${staging}"`);
    await client.unsafe(
      `create unlogged table "${staging}" as select ${columnList} from "${name}" with no data`
    );

    try {
      const writable = await client
        .unsafe(`copy "${staging}" (${columnList}) from stdin`)
        .writable();

      for (const row of group.rows) {
        const line = `${columns
          .map((column) => encodeCopyValue(row[column.property], column.sqlType))
          .join('\t')}\n`;
        if (!writable.write(line)) {
          await new Promise<void>((resolve) => writable.once('drain', () => resolve()));
        }
      }
      await new Promise<void>((resolve, reject) => {
        writable.once('error', reject);
        writable.end(() => resolve());
      });

      // The constraint work, done ONCE per batch as a set rather than per row —
      // and done, not skipped.
      await client.unsafe(
        `insert into "${name}" (${columnList}) ` +
          `select ${columnList} from "${staging}" on conflict do nothing`
      );
    } finally {
      await client.unsafe(`drop table if exists "${staging}"`);
    }
  }

  return rows.length;
}

/**
 * `ANALYZE` the tables a run touched.
 *
 * A bulk load leaves the planner's statistics describing an empty table, so the
 * first queries after a cutover plan against `n_distinct` values that are
 * simply wrong. This is cheap and there is no reason to make the first user
 * pay for it.
 */
export async function analyzeTables(client: Sql, tableNames: readonly string[]): Promise<void> {
  for (const name of tableNames) {
    await client.unsafe(`analyze "${name}"`);
  }
}
