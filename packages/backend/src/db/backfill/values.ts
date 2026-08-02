/**
 * BSON → Postgres value coercion for the backfill.
 *
 * Every transform reads its source document through these, never directly, for
 * one reason: a raw Mongo document is `unknown` at every leaf, and the
 * alternative to a coercion helper is a cast. `as string` on a field that is
 * actually an `ObjectId` compiles, inserts `[object Object]`, and is discovered
 * by nobody.
 *
 * ## The two shapes each helper comes in
 *
 * - `str(doc, 'path')` — optional. Returns the value or `null`.
 * - `reqStr(doc, 'path')` — required. THROWS naming the path and the `_id`.
 *
 * The required form exists because "this column is `NOT NULL` in Postgres" and
 * "this field is `required` in Mongoose" are different claims, and Mongoose
 * never enforced its own — `runValidators` is set nowhere in this package, so
 * every `required:` and every `enum:` in `src/models/` is documentation rather
 * than a constraint. A document that predates a `required:` being added is
 * exactly the row that makes an `INSERT` fail at hour three, so the throw
 * carries the `_id`.
 *
 * ## What is deliberately NOT lenient
 *
 * A wrong TYPE is never coerced silently. `int()` on the string `'3'` throws
 * rather than returning `3`: if a numeric column holds strings in production
 * that is a data fact the migration must surface, not paper over. The one
 * sanctioned conversion is `ObjectId → string`, which is the entire id
 * strategy, plus `Date`-shaped values, where Mongo genuinely stores three
 * representations of the same instant.
 *
 * ## Scope is measured, not copied
 *
 * The helpers here cover exactly the column types this schema declares (806
 * columns: `text`, `timestamptz`, `integer`, `boolean`, `double precision`,
 * `text[]`, `integer[]`, `jsonb`, `bigint`, plus two generated `tsvector` and
 * two generated `geography`). There is deliberately no `decimal()` and no
 * `bytes()` — Mention has no `numeric` or `bytea` column, and a helper with no
 * caller is a helper nobody tests.
 */

import { createHash } from 'node:crypto';

/**
 * Is this value a BSON `ObjectId`?
 *
 * Duck-typed on `_bsontype` rather than `instanceof Types.ObjectId`, and that
 * is deliberate rather than lazy. `instanceof` is only correct while exactly
 * ONE copy of `bson` is loaded, which is a property of today's dependency tree
 * and not of the code — this repo pins `linker = "hoisted"` for Metro's sake,
 * but the Docker image and any future linker change are free to nest a second
 * copy. A second copy makes `instanceof` return false for a real ObjectId, and
 * every id in the migration would then be reported as a bad type.
 *
 * `_bsontype` is bson's own public discriminator and is stable across copies
 * and versions.
 */
export function isObjectId(value: unknown): value is { toHexString(): string } {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { _bsontype?: unknown; toHexString?: unknown };
  return candidate._bsontype === 'ObjectId' && typeof candidate.toHexString === 'function';
}

/** Raised when a source field cannot be coerced. Names the path and the `_id`. */
export class BackfillValueError extends Error {
  constructor(
    readonly path: string,
    message: string,
    readonly documentId?: string
  ) {
    super(`${path}: ${message}` + (documentId === undefined ? '' : ` (source _id ${documentId})`));
    this.name = 'BackfillValueError';
  }
}

/** A raw Mongo document as returned by the driver — every leaf is `unknown`. */
export type MongoDocument = Record<string, unknown>;

/**
 * Read a dotted path out of a document.
 *
 * Mongo nests (`content.text`, `federation.activityId`, `stats.likesCount`);
 * Postgres flattens (`content_text`, `federation_activity_id`, `likes_count`).
 * The path is the honest description of where the value lives, and resolving it
 * here keeps every transform free of `?.` chains that would each need their own
 * null handling.
 */
export function at(doc: MongoDocument, path: string): unknown {
  if (!path.includes('.')) return doc[path];
  let current: unknown = doc;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** The source `_id` as a string, for error messages. Never throws. */
export function describeId(doc: MongoDocument): string | undefined {
  const id = doc._id;
  if (id === null || id === undefined) return undefined;
  return String(id);
}

function absent(value: unknown): boolean {
  return value === null || value === undefined;
}

function fail(doc: MongoDocument, path: string, message: string): never {
  throw new BackfillValueError(path, message, describeId(doc));
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'Date';
  if (isObjectId(value)) return 'ObjectId';
  return typeof value;
}

// ---------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------

/**
 * An ObjectId (or an id-shaped string) as the verbatim `text` a Postgres id
 * column holds. This IS the id strategy — see `db/MIGRATION-CONTRACT.md`.
 *
 * An empty string is treated as absent: it is not a real id, and letting one
 * through would produce a foreign key that references nothing and a `23503`
 * whose message names only the constraint.
 */
export function id(doc: MongoDocument, path: string): string | null {
  const value = at(doc, path);
  if (absent(value)) return null;
  if (isObjectId(value)) return value.toHexString();
  if (typeof value === 'string') return value.length === 0 ? null : value;
  return fail(doc, path, `expected an ObjectId or string id, got ${typeName(value)}`);
}

/** {@link id}, required. */
export function reqId(doc: MongoDocument, path: string): string {
  const value = id(doc, path);
  if (value === null) fail(doc, path, 'is required but absent or empty');
  return value;
}

/** The document's own `_id`, verbatim. Every row's primary key. */
export function ownId(doc: MongoDocument): string {
  return reqId(doc, '_id');
}

/**
 * The primary key for a row built from one element of a subdocument ARRAY.
 *
 * Two shapes exist in the source and both must work:
 *
 * - The subschema keeps `_id` (Mongoose adds one to every element unless the
 *   subschema opts out). That id is copied VERBATIM, like every other id.
 * - The subschema declared `_id: false`, or the array was written by a path
 *   that bypassed schema casting. There is no id to preserve, so one is DERIVED
 *   from the parent id, the array path and the ordinal.
 *
 * ## Why derived and not generated
 *
 * A freshly generated uuid would be different on every run, so a re-run would
 * insert a SECOND row rather than conflicting with the first. Most child tables
 * survive that on some other unique constraint — `(post_id, ord)`,
 * `(threadgate_id, ord)`, `(preference_id, key)` — but relying on "some other
 * constraint exists" is exactly the assumption that fails silently the first
 * time a child table is added without one.
 *
 * Deriving from `(parentId, path, ordinal)` makes the id a pure function of the
 * source, so `ON CONFLICT DO NOTHING` on the primary key does the same work for
 * these rows that a verbatim `_id` does for every other row.
 *
 * The output is UUID-shaped with the version and variant bits set, so it reads
 * as an ordinary id rather than a special case — and `text` primary keys
 * accommodate the mixed format by design (`schema/CONVENTIONS.md`).
 */
export function childRowId(
  entry: MongoDocument,
  parentId: string,
  path: string,
  ordinal: number
): string {
  const preserved = id(entry, '_id');
  if (preserved !== null) return preserved;

  const digest = createHash('sha256').update(`${parentId}\u0000${path}\u0000${ordinal}`).digest();
  // RFC 4122 layout: version 5 (name-based — SHA-1 by spec, SHA-256 truncated
  // here, which is strictly stronger and still deterministic) and the RFC 4122
  // variant.
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// scalars
// ---------------------------------------------------------------------------

/** A string field, or `null` when absent. */
export function str(doc: MongoDocument, path: string): string | null {
  const value = at(doc, path);
  if (absent(value)) return null;
  if (typeof value === 'string') return value;
  return fail(doc, path, `expected a string, got ${typeName(value)}`);
}

/** {@link str}, required. An empty string IS a value and is accepted. */
export function reqStr(doc: MongoDocument, path: string): string {
  const value = str(doc, path);
  if (value === null) fail(doc, path, 'is required but absent');
  return value;
}

/** A boolean field, or `null` when absent. */
export function bool(doc: MongoDocument, path: string): boolean | null {
  const value = at(doc, path);
  if (absent(value)) return null;
  if (typeof value === 'boolean') return value;
  return fail(doc, path, `expected a boolean, got ${typeName(value)}`);
}

/** A `double precision` field, or `null` when absent. */
export function num(doc: MongoDocument, path: string): number | null {
  const value = at(doc, path);
  if (absent(value)) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail(doc, path, `is ${String(value)}, which no Postgres numeric column accepts`);
    }
    return value;
  }
  return fail(doc, path, `expected a number, got ${typeName(value)}`);
}

/** {@link num}, required. */
export function reqNum(doc: MongoDocument, path: string): number {
  const value = num(doc, path);
  if (value === null) fail(doc, path, 'is required but absent');
  return value;
}

/**
 * An `integer`/`bigint` field, or `null` when absent.
 *
 * A non-integral number throws rather than rounding: `integer` in Postgres
 * rejects it too, and rounding here would hide a real type mismatch (a count
 * column holding an average, say) behind a plausible value.
 */
export function int(doc: MongoDocument, path: string): number | null {
  const value = num(doc, path);
  if (value === null) return null;
  if (!Number.isInteger(value)) {
    fail(doc, path, `expected an integer, got ${value}`);
  }
  return value;
}

/** {@link int}, required. */
export function reqInt(doc: MongoDocument, path: string): number {
  const value = int(doc, path);
  if (value === null) fail(doc, path, 'is required but absent');
  return value;
}

// ---------------------------------------------------------------------------
// dates
// ---------------------------------------------------------------------------

/**
 * A `timestamptz`, or `null` when absent.
 *
 * Accepts the three shapes Mongo genuinely produces for an instant: a BSON
 * `Date`, an ISO string (fields declared `String` that hold a timestamp — MTN
 * record `createdAt` is one), and epoch milliseconds. An unparseable string
 * throws rather than becoming `Invalid Date`, which Postgres would reject far
 * away from the document that caused it.
 *
 * This does NOT clamp a future date. `utils/ingestTimestamp.ts` exists because a
 * self-asserted `createdAt` can be dishonest, but clamping is an INGEST policy:
 * a backfill that silently re-dated a row would make the copy disagree with the
 * source it is supposed to reproduce, and the verifier — which re-runs this
 * transform — could never tell a clamp from a corruption.
 */
export function date(doc: MongoDocument, path: string): Date | null {
  const value = at(doc, path);
  if (absent(value)) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) fail(doc, path, 'is an Invalid Date');
    return value;
  }
  if (typeof value === 'number') {
    const fromEpoch = new Date(value);
    if (Number.isNaN(fromEpoch.getTime())) fail(doc, path, `is not a valid epoch: ${value}`);
    return fromEpoch;
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) fail(doc, path, `is not a parseable date: ${value}`);
    return parsed;
  }
  return fail(doc, path, `expected a date, got ${typeName(value)}`);
}

/** {@link date}, required. */
export function reqDate(doc: MongoDocument, path: string): Date {
  const value = date(doc, path);
  if (value === null) fail(doc, path, 'is required but absent');
  return value;
}

// ---------------------------------------------------------------------------
// arrays
// ---------------------------------------------------------------------------

/**
 * A native `text[]` column from a Mongo scalar array.
 *
 * `null` when absent, which is NOT the same as `{}`. A column declared
 * `NOT NULL DEFAULT '{}'` takes `strArray(...) ?? []` at the call site, where
 * the choice is visible rather than buried in this helper.
 */
export function strArray(doc: MongoDocument, path: string): string[] | null {
  const value = at(doc, path);
  if (absent(value)) return null;
  if (!Array.isArray(value)) {
    return fail(doc, path, `expected an array, got ${typeName(value)}`);
  }
  return value.map((entry, index) => {
    if (typeof entry === 'string') return entry;
    if (isObjectId(entry)) return entry.toHexString();
    return fail(doc, `${path}[${index}]`, `expected a string, got ${typeName(entry)}`);
  });
}

/** An `integer[]` / `double precision[]` column from a Mongo numeric array. */
export function numArray(doc: MongoDocument, path: string): number[] | null {
  const value = at(doc, path);
  if (absent(value)) return null;
  if (!Array.isArray(value)) {
    return fail(doc, path, `expected an array, got ${typeName(value)}`);
  }
  return value.map((entry, index) => {
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
    return fail(doc, `${path}[${index}]`, `expected a finite number, got ${typeName(entry)}`);
  });
}

/**
 * The elements of a subdocument array, as documents, with their ordinal.
 *
 * Returns `[]` when the field is absent so a child-table transform can iterate
 * unconditionally: "no children" and "an empty children array" produce the same
 * zero rows, and there is no third answer to represent.
 */
export function subdocuments(doc: MongoDocument, path: string): Array<[MongoDocument, number]> {
  const value = at(doc, path);
  if (absent(value)) return [];
  if (!Array.isArray(value)) {
    return fail(doc, path, `expected an array of subdocuments, got ${typeName(value)}`);
  }
  return value.map((entry, index) => {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      return [entry as MongoDocument, index] as [MongoDocument, number];
    }
    return fail(doc, `${path}[${index}]`, `expected a subdocument, got ${typeName(entry)}`);
  });
}

// ---------------------------------------------------------------------------
// objects
// ---------------------------------------------------------------------------

/**
 * A `jsonb` column from a Mongo `Mixed`, `Map` or nested object.
 *
 * A Mongoose `Map` arrives from the raw driver as a plain object already, but a
 * document read through a model does not — so a real `Map` is converted rather
 * than serialized as `{}`, which is what `JSON.stringify(new Map())` produces
 * and what a naive port would store.
 *
 * `null` when absent. One hazard, and it is the correct failure mode: a NUL
 * byte in any string fails the INSERT loudly rather than being stripped.
 */
export function jsonObject(doc: MongoDocument, path: string): Record<string, unknown> | null {
  const value = at(doc, path);
  if (absent(value)) return null;
  if (value instanceof Map) return Object.fromEntries(value) as Record<string, unknown>;
  if (typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
    return value as Record<string, unknown>;
  }
  return fail(doc, path, `expected an object, got ${typeName(value)}`);
}

/** {@link jsonObject}, required — for a `jsonb NOT NULL` with no default. */
export function reqJsonObject(doc: MongoDocument, path: string): Record<string, unknown> {
  const value = jsonObject(doc, path);
  if (value === null) fail(doc, path, 'is required but absent');
  return value;
}

/**
 * A `jsonb` column holding ANY JSON value — object, array or scalar.
 *
 * The one case where narrowing to {@link jsonObject} would be WRONG rather than
 * merely stricter. `moderation_events.payload` and
 * `moderation_outbox.payload_decision` are declared loose ON PURPOSE (§10.11
 * makes a published decision document extensible, and the schema says so), so
 * they hold whatever a newer CrowdSource sent. `jsonb` accepts an array or a
 * scalar just as readily as an object, and a transform that refused one would
 * abort a whole run over a document the target column can store perfectly well
 * — the migration deciding a shape question the schema deliberately left open.
 *
 * A `Map` is still converted rather than serialized as `{}` — same hazard as
 * {@link jsonObject}, for the same reason.
 */
export function jsonValue(doc: MongoDocument, path: string): unknown {
  const value = at(doc, path);
  if (absent(value)) return null;
  if (value instanceof Map) return Object.fromEntries(value) as Record<string, unknown>;
  return value;
}

/** A `jsonb` column holding an ARRAY. */
export function jsonArray(doc: MongoDocument, path: string): unknown[] | null {
  const value = at(doc, path);
  if (absent(value)) return null;
  if (Array.isArray(value)) return value;
  return fail(doc, path, `expected an array, got ${typeName(value)}`);
}
