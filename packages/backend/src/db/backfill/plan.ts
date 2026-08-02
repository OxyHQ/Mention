/**
 * What a single Mongo collection becomes in Postgres.
 *
 * `schema/CONVENTIONS.md` names this file's obligation: table names are
 * explicit snake_case and plural (`push_tokens`, not Mongoose's derived
 * `pushtokens`), so neither side of the collection → table map can be computed
 * from the other. A plan is one entry of that map, plus everything the copy
 * needs that a bare name→name pair cannot express.
 *
 * ## Why a plan is more than `{ collection, table }`
 *
 * - **Child tables.** Mention's schema turns many Mongo subdocument arrays into
 *   real tables — `posts` alone feeds ten. One document therefore produces rows
 *   in several tables, and the count check for a child table is a count of
 *   ARRAY ELEMENTS, not of documents. A plan declares which tables it fills so
 *   the verifier can tell "this table is empty because nothing fed it" from
 *   "this table is empty because the copy silently produced nothing".
 * - **Enum audits.** Mongoose never ran `runValidators` in this package, so a
 *   live document can hold a value its own schema forbids. A Postgres CHECK is
 *   enforced, so those rows are rejected. The audit runs `distinct()` per
 *   enum-backed column BEFORE any insert and reports every value the CHECK
 *   would refuse.
 * - **Uniqueness audits.** The Postgres schema adds unique indexes Mongo lacked
 *   — case-insensitive ones especially. Two values differing only by case
 *   collide, and a collision surfaces as a `23505` naming an index rather than
 *   the two rows. The audit finds and reports the pairs first.
 *
 * ## Insert order is derived, never declared
 *
 * A plan does NOT carry a position. The runner topologically sorts the tables
 * by their real foreign keys, read from the drizzle metadata, so the order
 * cannot drift from the schema it has to satisfy. Self-referencing columns
 * (`posts.parent_post_id` is the only one in this schema) are deferred to a
 * second UPDATE pass by the same derivation.
 */

import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { ResolutionContext, ResolutionRule } from './resolutions';
import type { MongoDocument } from './values';

/** Collect a row for a table. Called once per row a document produces. */
export type Emit = (table: PgTable, row: Record<string, unknown>) => void;

/**
 * A closed value set to check a Mongo field against before inserting.
 *
 * `column` is the drizzle column; its allowed values are read from the column's
 * own `enumValues`, so the audit cannot drift from the CHECK it predicts.
 */
export interface EnumAudit {
  /** Dotted path of the field in the Mongo document. */
  readonly path: string;
  /** The Postgres column the value lands in. */
  readonly column: PgColumn;
  /**
   * The value an ABSENT field maps to, when the transform supplies a default.
   *
   * Declaring it means the audit does not report `null` as an illegal value for
   * a field the backfill is going to fill in — which would be a false positive
   * on every document written before the field existed.
   */
  readonly absentAs?: string;
  /** A documented rule that already answers a finding on this audit. */
  readonly resolvedBy?: ResolutionRule;
}

/**
 * A numeric CHECK to check a Mongo field against before inserting.
 *
 * ## Why this exists as a separate kind from {@link EnumAudit}
 *
 * `EnumAudit` reads its accepted set from the drizzle column's `enumValues`,
 * which only a text column carries. This schema declares roughly forty numeric
 * CHECKs and none of them is expressible that way — so before this existed,
 * every one of them was unaudited and would have failed the copy with a `23514`
 * naming a constraint rather than a row, partway through a run.
 *
 * They are NOT a theoretical class. Most are `>= 0` on a DENORMALIZED COUNTER
 * copied straight out of Mongo (`trending.volume`, `topic_stats.postCount`,
 * `account_lists.subscriberCount`, `custom_feeds.ratingsCount`, every
 * `attempts` column), and a counter that went negative on a decrement race is
 * the single most ordinary way a Mongo integer ends up outside a range nobody
 * was enforcing. Mongoose's `min:` never ran — `runValidators` is set nowhere
 * in this package — so a negative count is legal there and rejected here.
 *
 * ## The accepted set is READ, never restated
 *
 * A closed set ({@link values}) must come from the SAME exported constant the
 * schema builds its CHECK from, for the reason `EnumAudit` reads `enumValues`:
 * an audit carrying its own copy of the accepted values predicts a constraint
 * that no longer exists the moment someone widens one side. `LIKE_VALUES` in
 * `schema/engagement.ts` is that constant for `likes.value`, and the CHECK now
 * renders from it.
 *
 * A bound ({@link min}/{@link max}) cannot be read from anywhere — `>= 0` is
 * written inline in the CHECK and drizzle exposes no structured form of it — so
 * it is declared here beside {@link constraint}, which names the constraint the
 * declaration is claiming to predict. That is weaker than the closed-set case
 * and is stated rather than hidden.
 */
export interface NumericAudit {
  /** Dotted path of the field in the Mongo document. */
  readonly path: string;
  /** The Postgres column the value lands in. */
  readonly column: PgColumn;
  /** The CHECK this predicts, named so a report is actionable without the code. */
  readonly constraint: string;
  /**
   * A closed set of accepted values — from the schema constant the CHECK uses.
   *
   * Mutually exclusive with {@link min}/{@link max}: a set IS the bound.
   */
  readonly values?: readonly number[];
  /** Inclusive lower bound. */
  readonly min?: number;
  /** Inclusive upper bound. */
  readonly max?: number;
  /**
   * The value an ABSENT field maps to, when the transform supplies a default.
   *
   * Same contract as {@link EnumAudit.absentAs}: declaring it means the audit
   * does not report a `NOT NULL` column's absent field as a violation the
   * transform is about to fill in anyway.
   */
  readonly absentAs?: number;
  /** A documented rule that already answers a finding on this audit. */
  readonly resolvedBy?: ResolutionRule;
}

/**
 * Does this value satisfy the audit's declared constraint?
 *
 * @throws {Error} When the audit declares NO constraint at all. An audit with
 *   neither a set nor a bound accepts everything and would report clean over
 *   any data whatsoever — the vacuous-check failure mode, which is worse than
 *   having no audit because it reads like coverage.
 */
export function numericIsAccepted(audit: NumericAudit, value: number): boolean {
  const hasSet = audit.values !== undefined;
  const hasBound = audit.min !== undefined || audit.max !== undefined;
  if (!hasSet && !hasBound) {
    throw new Error(
      `NumericAudit on ${audit.constraint} declares neither an accepted set nor ` +
        'a bound, so it would accept every value and pass vacuously'
    );
  }
  if (hasSet && hasBound) {
    throw new Error(
      `NumericAudit on ${audit.constraint} declares both an accepted set and a ` +
        'bound. A set IS the bound; declaring both means two answers to one ' +
        'question, and nothing says which the CHECK actually enforces'
    );
  }
  if (audit.values !== undefined) return audit.values.includes(value);
  if (audit.min !== undefined && value < audit.min) return false;
  if (audit.max !== undefined && value > audit.max) return false;
  return true;
}

/** The accepted range, in words, for a finding's message. */
export function describeNumericBound(audit: NumericAudit): string {
  if (audit.values !== undefined) return `one of ${audit.values.join(', ')}`;
  if (audit.min !== undefined && audit.max !== undefined) {
    return `between ${audit.min} and ${audit.max}`;
  }
  if (audit.min !== undefined) return `>= ${audit.min}`;
  if (audit.max !== undefined) return `<= ${audit.max}`;
  return '(nothing — this audit declares no constraint)';
}

/**
 * How one column of a unique index is normalized before comparison.
 *
 * Guessing in either direction is harmful and asymmetric. Normalizing MORE than
 * the index does invents collisions and blocks a run over data Postgres would
 * accept — a gate that cries wolf gets disabled by whoever hits it next.
 * Normalizing LESS misses a real collision, and the run then fails on a `23505`
 * partway through, which is the outcome the audit exists to prevent.
 */
export type UniquenessNormalization = 'exact' | 'lower' | 'lower-btrim';

/** One column of a unique index, and how the index normalizes it. */
export interface UniquenessKeyPart {
  /** Dotted path of the field in the Mongo document. */
  readonly path: string;
  /** The expression wrapped around it in the index. */
  readonly normalize: UniquenessNormalization;
}

/**
 * A uniqueness constraint Postgres now enforces that Mongo did not, checked
 * against the live data before the copy.
 *
 * ## Rows with a NULL in any key part are EXCLUDED
 *
 * Postgres unique indexes are `NULLS DISTINCT` by default, so a row with a NULL
 * in any indexed column never conflicts — no matter how many other rows share
 * that shape. An audit that coalesced absent values to `''` would report every
 * such row as colliding with every other, which is a false positive on
 * precisely the columns most likely to be sparse.
 *
 * ## A PARTIAL index changes the QUESTION, not just the answer
 *
 * An index declared `WHERE deleted_at IS NULL` constrains only the rows its
 * predicate selects. An audit that ignored the predicate would group rows the
 * index never constrains and report a collision Postgres would have accepted —
 * and worse, a resolution rule written for the real collision would then fail
 * to cover the inflated group, because a rule clears a group only by acting on
 * all but one of its rows. {@link where} is that predicate, expressed as the
 * Mongo filter the audit matches on. It MUST be derived from the same constant
 * the index is built from, never written out a second time.
 */
export interface UniquenessAudit {
  /** The index this predicts, for the report. */
  readonly index: string;
  /** The columns forming the key, each with its own normalization. */
  readonly key: readonly UniquenessKeyPart[];
  /**
   * The index's partial predicate, as a Mongo filter.
   *
   * Omitted for a total index. Present for a partial one, and then it is not
   * optional: see the class note above.
   */
  readonly where?: Record<string, unknown>;
  /** A documented rule that already answers a finding on this audit. */
  readonly resolvedBy?: ResolutionRule;
}

/**
 * A `NOT NULL DEFAULT` column the transform deliberately leaves to the database,
 * and the reason that is the right answer for it.
 *
 * ## The class this exists for
 *
 * A `NOT NULL` column with NO default fails loudly when the source field is
 * absent: `buildRow` names the table, the column and the document. A `NOT NULL`
 * column WITH a default fails silently — the row inserts, the database supplies
 * a value, and nobody decided anything. It is the one shape where an audit's
 * silence is not evidence, so `auditDefaultedColumns` counts every omission
 * instead of assuming.
 *
 * Measured rather than imagined: six posts of 577,526 in production have no
 * `createdAt` at all, and `posts.created_at` is exactly this shape. Left alone
 * they would take `now()` and sit at the top of every chronological feed on day
 * one. The fix there was to derive the value; the point of this type is that the
 * OTHER answer — "the default is genuinely correct here" — is equally legitimate
 * and has to be written down rather than reached by default.
 *
 * ## An acknowledgement is checked, not trusted
 *
 * Declaring one for a column the transform never actually omits is itself a
 * finding. A list of exemptions that nobody re-measures is how a gate rots into
 * a formality — the same reason the referential audit reconciles its derived
 * relations against `pg_constraint` rather than trusting the derivation.
 */
export interface DefaultedColumnAcknowledgement {
  /** The `NOT NULL DEFAULT` column the transform omits. */
  readonly column: PgColumn;
  /**
   * Why the database default is the RIGHT value for a document that lacks the
   * source field — not merely that it is acceptable.
   */
  readonly reason: string;
}

/** One Mongo collection and everything the backfill needs to move it. */
export interface CollectionPlan {
  /**
   * The LIVE collection name, as `db.listCollections()` reports it.
   *
   * Mongoose derived most of these by pluralising the model name rather than
   * declaring them, so these are the DERIVED names, read from the model
   * registry (`Model.collection.collectionName`) — never a guess from the table
   * name. Several models DO declare an explicit `collection:` option
   * (`engagement_outbox`, `moderation_events`, `post_recent_repliers`, …) and
   * those differ from the plural entirely.
   */
  readonly collection: string;
  /** The table this collection's documents become, one row per document. */
  readonly table: PgTable;
  /** Tables filled from this collection's subdocument arrays. */
  readonly childTables?: readonly PgTable[];
  /** Closed value sets to check before inserting. */
  readonly enumAudits?: readonly EnumAudit[];
  /** Numeric CHECKs to check before inserting — sets and bounds alike. */
  readonly numericAudits?: readonly NumericAudit[];
  /** Uniqueness Postgres now enforces and Mongo did not. */
  readonly uniquenessAudits?: readonly UniquenessAudit[];
  /**
   * `NOT NULL DEFAULT` columns this transform deliberately leaves to the
   * database — see {@link DefaultedColumnAcknowledgement}.
   *
   * Never a list of columns to skip: it is a list of DECISIONS, each of which
   * the audit re-measures. An entry for a column the transform always supplies
   * is reported, so the list cannot quietly outlive the behaviour it describes.
   */
  readonly defaultedColumns?: readonly DefaultedColumnAcknowledgement[];
  /**
   * Build every row one document produces.
   *
   * Throwing is the sanctioned way to refuse a document: the runner catches it,
   * names the collection and the `_id`, and aborts. There is deliberately no
   * "skip this document" return value — a silently dropped document is the
   * failure this whole migration exists to avoid.
   *
   * `resolutions` carries the documented decisions plus the channel a transform
   * REPORTS a degraded document through. It is declared on the type even though
   * most transforms ignore it, so every CALLER is forced to supply one: the
   * verifier computes its expectation by re-running this transform, and a
   * verifier running it with different resolutions than the copy did would
   * report every resolved row as a field-fidelity failure.
   */
  readonly transform: (doc: MongoDocument, emit: Emit, resolutions: ResolutionContext) => void;
}

/** A collection that is deliberately NOT migrated, and why. */
export interface ExcludedCollection {
  /** The live collection name. */
  readonly collection: string;
  /**
   * Why no data moves.
   *
   * An unexplained exclusion is indistinguishable from an oversight six months
   * later, so this is required and is printed in the run report next to the
   * document count the collection actually holds.
   */
  readonly reason: string;
}

/** Every table a plan writes to — its own plus its children. */
export function planTables(plan: CollectionPlan): PgTable[] {
  return [plan.table, ...(plan.childTables ?? [])];
}

/** A table's SQL name. */
export function tableName(table: PgTable): string {
  return getTableConfig(table).name;
}

/**
 * The property name of a table's SINGLE-column primary key, or `null`.
 *
 * `null` for a table keyed by a composite — which in this schema is the child
 * tables keyed by `(parent, ordinal)`, none of which any foreign key
 * references, so nothing needs to read them as a key set.
 */
export function singlePrimaryKeyProperty(table: PgTable): string | null {
  const config = getTableConfig(table);
  const inline = config.columns.filter((column) => column.primary);
  if (inline.length === 1) return inline[0]?.name ?? null;
  if (inline.length > 1) return null;
  const composite = config.primaryKeys.flatMap((key) => key.columns.map((column) => column.name));
  return composite.length === 1 ? (composite[0] ?? null) : null;
}

/**
 * The allowed values of an enum-backed column, from the column itself.
 *
 * An ARRAY column carries no `enumValues` of its own — drizzle puts them on the
 * element type, so `text({ enum: X }).array().enumValues` is `undefined` while
 * `.baseColumn.enumValues` is `X`. Reading through to the base column is what
 * lets `reports.categories` be audited at all: its CHECK constrains the
 * ELEMENTS (`categories <@ array[…]`), and Mongo's `distinct` on an array field
 * returns the elements too, so the two sides line up exactly. The set is still
 * READ rather than restated, which is the whole contract of this function.
 *
 * What this does NOT cover, and the caller must handle: an array CHECK often
 * also constrains LENGTH (`array_length(categories, 1) >= 1`). An empty array
 * contributes no elements to `distinct`, so no audit built on this can see one.
 */
export function allowedValues(column: PgColumn): readonly string[] {
  const self = (column as unknown as { enumValues?: readonly string[] }).enumValues;
  const base = (column as unknown as { baseColumn?: { enumValues?: readonly string[] } })
    .baseColumn?.enumValues;
  const values = self ?? base;
  if (!values || values.length === 0) {
    throw new Error(
      `Column ${column.name} has no enumValues — an EnumAudit on it would ` +
        'check nothing at all and pass vacuously'
    );
  }
  return values;
}
