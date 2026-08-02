/**
 * Shared Column Builders
 *
 * The handful of column shapes that repeat across every table. They exist so a
 * decision made once (ids are `text`, timestamps are `timestamptz`, `updated_at`
 * is maintained in the application) is expressed once and cannot drift table to
 * table — see `CONVENTIONS.md` for the reasoning behind each.
 *
 * Nothing here is a wrapper for its own sake: each is used by many tables, and
 * each encodes a rule that a hand-written column could silently get wrong.
 */

import { randomFillSync } from 'node:crypto';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { customType, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * The row type a named-column selection object produces.
 *
 * ```ts
 * const COLUMNS = { id: posts.id, language: posts.language } as const;
 * type Row = SelectedRow<typeof COLUMNS>;   // { id: string; language: string | null }
 * ```
 *
 * Exists because the obvious spelling is WRONG in the dangerous direction:
 * `column['_']['data']` is the non-null data type, so a hand-written
 * `{ [K in keyof T]: T[K]['_']['data'] }` silently declares every nullable
 * column non-nullable — a `null` then flows into code that was type-checked as
 * if it could not, and `tsc` never says a word. Nullability lives in the
 * separate `notNull` flag, which is what this reads.
 */
export type SelectedRow<T extends Record<string, PgColumn>> = {
  [K in keyof T]: T[K]['_']['notNull'] extends true
    ? T[K]['_']['data']
    : T[K]['_']['data'] | null;
};

/**
 * `timestamptz`, always, handed back to TypeScript as a `Date`.
 *
 * `timestamp` WITHOUT a time zone would reinterpret the stored value in the
 * session's `TimeZone` on every read; a Mongo `Date` is an absolute UTC instant,
 * so anything but `timestamptz` silently changes what the value means.
 */
export const timestamptz = () => timestamp({ withTimezone: true, mode: 'date' });

/**
 * `created_at` — set by the database on insert, never updated.
 *
 * Both Mongoose shapes (`timestamps: true` and a hand-declared
 * `createdAt: { type: Date, default: Date.now }`) map here: the distinction is a
 * Mongoose implementation detail with no Postgres counterpart.
 */
export const createdAt = () => timestamptz().notNull().defaultNow();

/**
 * `updated_at` — maintained by the APPLICATION on every `db.update()`, matching
 * what Mongoose did. Deliberately not a trigger: a trigger is invisible in this
 * schema, and it would also fire during backfill/maintenance writes and
 * overwrite the historical value the migration exists to preserve.
 */
export const updatedAt = () =>
  timestamptz()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** Bytes in a UUID. */
const UUID_BYTES = 16;
/** Milliseconds of the v7 timestamp occupy the leading 48 bits. */
const UUID_V7_TIMESTAMP_BYTES = 6;

/**
 * A RFC 9562 UUID version 7 — 48 bits of big-endian Unix milliseconds followed
 * by 74 bits of randomness, with the version and variant nibbles pinned.
 *
 * Written here rather than taken from the `uuid` package, and the reason is
 * measured rather than stylistic: `uuid@14` (current) declares
 * `"type": "module"` with a node condition pointing at an ESM-only build, and
 * this package emits and runs **CommonJS** (`tsconfig.json` `module: commonjs`,
 * `dist/**` executed by the ECS image), so `require('uuid')` cannot resolve it.
 * `uuid@11` does ship CJS, but the repo already hoists a transitive `uuid@3.4.0`
 * at the workspace root under `linker = "hoisted"`, so declaring a second major
 * would leave two copies in the tree — the exact stale-nested-copy shape
 * `~/Oxy/AGENTS.md` warns about. Twenty lines of spec is the cheaper of the two.
 *
 * The time component makes ids k-sortable, so a b-tree primary-key index stays
 * append-mostly instead of scattering inserts across the whole keyspace the way
 * a v4 does.
 */
export function uuidv7(): string {
  const bytes = new Uint8Array(UUID_BYTES);
  randomFillSync(bytes);

  // Big-endian 48-bit millisecond timestamp. `Number` is exact to 2^53, and a
  // 48-bit millisecond count runs to the year 10889, so no precision is lost.
  let milliseconds = Date.now();
  for (let index = UUID_V7_TIMESTAMP_BYTES - 1; index >= 0; index -= 1) {
    bytes[index] = milliseconds & 0xff;
    milliseconds = Math.floor(milliseconds / 256);
  }

  // Version 7 in the high nibble of octet 6; RFC 9562 variant `10` in the top
  // two bits of octet 8. Both overwrite random bits, which is why they are
  // applied after the fill rather than before.
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Primary key: `text` holding a 24-char ObjectId hex for every row that existed
 * before the cutover, and a uuid v7 for every row created after it.
 *
 * The id is generated HERE rather than by a database `DEFAULT` because Postgres
 * 17 has no native `uuidv7()` (it lands in 18); the alternatives are the
 * `pg_uuidv7` extension or a hand-maintained plpgsql function, both of which
 * would have to be installed identically in dev, CI and RDS before the first
 * migration could run. Generating in the application also means the id is known
 * before the insert round-trip, so a post and its media/variant/authorship rows
 * can be built in one batch.
 *
 * Rows inserted by raw SQL get no id — intended: the backfill supplies `_id`
 * verbatim, which is exactly how every existing foreign key survives, and how
 * every ActivityPub URI already published to remote instances keeps resolving.
 */
export const generatedId = () =>
  text()
    .primaryKey()
    .$defaultFn(() => uuidv7());

/**
 * `tsvector` — the replacement for a Mongo text index.
 *
 * Drizzle has no built-in for it. Every use is a GENERATED column plus a GIN
 * index, never a value the application writes, so the TypeScript type is the
 * `string` Postgres renders it as and there is no `toDriver` direction to get
 * wrong. Declared here because "Mongo text index becomes `tsvector` + GIN" is a
 * schema-wide rule, not one table's detail — a `LIKE '%…%'` scan is not the port
 * of a text index, it is a table scan wearing one's clothes.
 *
 * The generating expression MUST use the two-argument
 * `to_tsvector('<config>', …)` with a literal configuration: the one-argument
 * form reads `default_text_search_config` at runtime and is therefore STABLE,
 * which Postgres refuses in a generated column.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
});

/**
 * `geography` — a PostGIS point, always GENERATED from named `latitude` /
 * `longitude` columns and never written directly.
 *
 * drizzle-kit cannot emit the `(Point,4326)` typmod (its `parseType` quotes any
 * type name outside a hardcoded list, and `geography` is not on it as of
 * drizzle-kit 0.31.10), so the column is declared bare. The typmod would only
 * constrain WRITES, and a generated column has none; that the stored value
 * really is a Point at SRID 4326 is asserted against real rows in the schema
 * tests instead.
 */
export const geography = customType<{ data: string; driverData: string }>({
  dataType: () => 'geography',
});

/**
 * A `const` tuple rendered as the value list of a SQL `in (...)`.
 *
 * Every closed value set in this schema is `text` plus a CHECK derived from the
 * SAME tuple that types the column (`CONVENTIONS.md`, "Closed value sets"), so
 * the two cannot drift. The values must be SQL literals rather than bound
 * parameters — a CHECK constraint cannot carry a parameter — which is why they
 * go through `sql.raw`; the COLUMN is always interpolated as a drizzle Column so
 * its SQL name still comes from the casing setting rather than being spelled out
 * here.
 *
 * Safe only because every caller passes a locally-declared `as const` tuple of
 * identifier-shaped literals. It is not an escaping routine and must never be
 * handed a runtime value.
 */
export function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/**
 * {@link inList} for a closed set of NUMBERS — unquoted, so `in (1, -1)`.
 *
 * The same drift argument applies and is why this exists rather than the CHECK
 * spelling its values out: `likes.value` had a `LIKE_VALUES` tuple beside a
 * CHECK that restated `(1, -1)` independently, so the tuple was referenced by
 * nothing and neither side would have noticed the other changing. The backfill's
 * numeric audit now reads that tuple, which makes the drift a live hazard rather
 * than a latent one.
 *
 * Rendering is deliberately `join(', ')` so the emitted DDL is byte-identical to
 * what the applied migration already contains — a cosmetic difference here would
 * make drizzle-kit propose a constraint drop/recreate for no change at all.
 * `db/__tests__` asserts that rendering; do not "tidy" the separator.
 *
 * Non-finite values are refused rather than rendered: `Infinity` and `NaN`
 * stringify to identifiers Postgres parses as column references, so an
 * unguarded one becomes a syntactically valid CHECK against a column that does
 * not exist — a migration failure far from its cause.
 */
export function numericInList(values: readonly number[]): string {
  return values
    .map((value) => {
      if (!Number.isFinite(value)) {
        throw new Error(
          `numericInList received ${String(value)}, which is not a SQL numeric ` +
            'literal — Postgres would parse it as a column reference'
        );
      }
      return String(value);
    })
    .join(', ');
}
