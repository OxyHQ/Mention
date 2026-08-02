/**
 * The documented decisions — the THIRD way to clear a blocking audit finding.
 *
 * An audit refuses the copy when production holds rows the Postgres schema
 * would reject. There are exactly three ways forward, and all three are
 * decisions rather than switches:
 *
 * 1. **Fix the data** in MongoDB, before the run.
 * 2. **Widen the schema** so the rows are legal.
 * 3. **Write a rule here**, saying in prose what the migration should do and
 *    reporting every row it acts on BY ID.
 *
 * There is no fourth way, and in particular there is **no override flag**. A
 * flag would let an operator under time pressure convert "the schema would
 * reject 400 rows" into "the run finished", which is the failure mode this file
 * exists to make impossible. Taking option 3 does not silence anything either:
 * the finding is still computed, still counted, still printed — now carrying
 * the rule that answers it.
 *
 * ## There are currently NO declared rules, and that is correct
 *
 * {@link ORPHAN_RESOLUTIONS} and {@link RESOLUTION_RULES} are empty. A rule is a
 * decision about REAL data — which of two colliding rows survives, whether a
 * post naming a deleted parent is dropped or nulled — and no such data has been
 * inspected yet, because no audit has been run against `mention-production`.
 * Inventing a rule in advance would be guessing at a decision, and a rule that
 * fires on data nobody looked at is worse than no rule at all: it acts, and the
 * report says it acted, and nobody ever decided.
 *
 * So the engine is complete and inert. Every finding blocks
 * ({@link ResolutionContext.resolvesUniquenessGroup} answers `false` for every
 * rule), every transform runs unmodified, and the first real audit is what
 * produces the first rule. The shape below is what a rule slots into.
 *
 * ## Rules are narrow BY CONSTRUCTION
 *
 * Every guard in {@link resolveOrphanedReferences} exists because a widened
 * predicate DELETES PRODUCTION ROWS. Only a declared table, only its one
 * declared column, only a non-null string value, and only when that value is
 * absent from the parent set THIS PHASE supplied. An empty parent set stands
 * the rule down; an unloaded one refuses the run.
 */

import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '../casing';
import type { MongoSource } from './mongoSource';
import {
  singlePrimaryKeyProperty,
  tableName,
  type CollectionPlan,
} from './plan';
import { describeId, type MongoDocument } from './values';

// ---------------------------------------------------------------------------
// what a rule IS
// ---------------------------------------------------------------------------

/**
 * One documented decision.
 *
 * `finding` and `decision` are prose on purpose. The point of a rule is that a
 * human decided something and wrote down what and why; a rule whose reason is
 * "see the code" is a rule nobody can review.
 */
export interface ResolutionRule {
  /** Stable id, quoted in the report and in tests. */
  readonly id: string;
  /** The collection whose documents it acts on. */
  readonly collection: string;
  /** The audit finding this answers, in the words the audit would use. */
  readonly finding: string;
  /** What the migration does about it, and why that is the right answer. */
  readonly decision: string;
}

/** What a rule does to a row whose reference names no parent. */
export type OrphanAction =
  /** Drop the row entirely. The schema's own answer when the column is NOT NULL. */
  | 'drop-row'
  /** Write the column NULL and keep the row. Only ever for a NULLABLE column. */
  | 'null-column';

/** What makes a rule fire. */
export type OrphanTrigger =
  /** The value names no row in the parent table Postgres holds. */
  | 'absent-parent'
  /** A SIBLING row in the same document was dropped by another rule. */
  | 'parent-dropped';

/**
 * One relation a rule is declared over.
 *
 * Everything derivable is derived: `tableName`, `property` and `columnName`
 * come off the drizzle table and column rather than being restated, so a
 * renamed column cannot leave a rule pointing at a name that no longer exists.
 */
export interface OrphanRelation {
  readonly rule: ResolutionRule;
  readonly action: OrphanAction;
  readonly trigger: OrphanTrigger;
  /** For a `parent-dropped` cascade: the rule whose removal triggers it. */
  readonly cascadesFrom?: OrphanRelation;
  /**
   * Why `drop-row` rather than `null-column`, when the column is NULLABLE.
   *
   * Required in that case and only that case: dropping a row whose column could
   * legally have held NULL is discarding data the schema would have accepted,
   * so the reason has to be written down.
   */
  readonly whyNotNull?: string;
  /** Columns copied verbatim into the report, as the record's evidence. */
  readonly carry?: readonly PgColumn[];
  /** The collection whose documents produce the offending rows. */
  readonly collection: string;
  readonly table: PgTable;
  readonly tableName: string;
  readonly column: PgColumn;
  /** The column's TypeScript PROPERTY name — what an emitted row is keyed by. */
  readonly property: string;
  /** The column's SQL name — what the report prints. */
  readonly columnName: string;
  readonly targetTable: PgTable;
  /** The Mongo collection behind the parent table, for the report's prose. */
  readonly parentCollection: string;
}

/** The fields a caller supplies; the rest are derived. */
export interface OrphanResolutionInput {
  readonly rule: ResolutionRule;
  readonly action: OrphanAction;
  readonly collection: string;
  readonly table: PgTable;
  readonly column: PgColumn;
  readonly targetTable: PgTable;
  readonly parentCollection: string;
  readonly trigger?: OrphanTrigger;
  readonly cascadesFrom?: OrphanRelation;
  readonly whyNotNull?: string;
  readonly carry?: readonly PgColumn[];
}

/**
 * Declare an orphan resolution, deriving every name from the schema.
 *
 * @throws {Error} When `action` is `drop-row` on a NULLABLE column with no
 *   `whyNotNull`. Dropping a row the schema would have accepted with a NULL is
 *   a choice, and an undocumented choice is how data goes missing quietly.
 */
export function orphanResolution(input: OrphanResolutionInput): OrphanRelation {
  const nullable = !input.column.notNull;
  if (input.action === 'drop-row' && nullable && input.whyNotNull === undefined) {
    throw new Error(
      `${input.rule.id} drops rows on ${tableName(input.table)}.${sqlColumnName(input.column)}, ` +
        'but that column is NULLABLE — so writing NULL would have kept the row and ' +
        'satisfied the constraint. Declare `whyNotNull` with the reason the row ' +
        'goes instead, or use `null-column`.'
    );
  }
  return {
    rule: input.rule,
    action: input.action,
    trigger: input.trigger ?? 'absent-parent',
    ...(input.cascadesFrom === undefined ? {} : { cascadesFrom: input.cascadesFrom }),
    ...(input.whyNotNull === undefined ? {} : { whyNotNull: input.whyNotNull }),
    ...(input.carry === undefined ? {} : { carry: input.carry }),
    collection: input.collection,
    table: input.table,
    tableName: tableName(input.table),
    column: input.column,
    property: input.column.name,
    columnName: sqlColumnName(input.column),
    targetTable: input.targetTable,
    parentCollection: input.parentCollection,
  };
}

/**
 * Every declared orphan resolution.
 *
 * EMPTY, deliberately — see this file's header. The first entry belongs to
 * whoever runs the first `--audit-only` against production and DECIDES what to
 * do about what it reports.
 */
export const ORPHAN_RESOLUTIONS: readonly OrphanRelation[] = [];

/**
 * Every rule the report enumerates, including ones that did nothing.
 *
 * Derived from {@link ORPHAN_RESOLUTIONS} plus any standalone value rules, so a
 * declared rule cannot be missing from the report by omission.
 */
export const RESOLUTION_RULES: readonly ResolutionRule[] = dedupeRules(
  ORPHAN_RESOLUTIONS.map((relation) => relation.rule)
);

function dedupeRules(rules: readonly ResolutionRule[]): ResolutionRule[] {
  const seen = new Set<string>();
  const out: ResolutionRule[] = [];
  for (const rule of rules) {
    if (seen.has(rule.id)) continue;
    seen.add(rule.id);
    out.push(rule);
  }
  return out;
}

const ORPHAN_RESOLUTIONS_BY_TABLE = new Map<string, OrphanRelation[]>();
for (const relation of ORPHAN_RESOLUTIONS) {
  const existing = ORPHAN_RESOLUTIONS_BY_TABLE.get(relation.tableName);
  if (existing) existing.push(relation);
  else ORPHAN_RESOLUTIONS_BY_TABLE.set(relation.tableName, [relation]);
}

const CASCADE_RESOLUTIONS: readonly OrphanRelation[] = ORPHAN_RESOLUTIONS.filter(
  (relation) => relation.trigger === 'parent-dropped'
);

// ---------------------------------------------------------------------------
// the report
// ---------------------------------------------------------------------------

/** One document a rule acted on. */
export interface ResolutionRecord {
  readonly rule: ResolutionRule;
  /** The source `_id`, so the operator can look the row up in Mongo. */
  readonly documentId: string;
  /**
   * WHICH part of the document, when one document can be acted on more than
   * once by the same rule.
   *
   * One document routinely produces several rows — a `posts` document produces
   * a row per media item, per mention, per source — so two of them naming two
   * absent parents are two separate acts. Without this they would collapse into
   * one record and the report would name only one of them.
   */
  readonly within?: string;
  /** What changed about this document, specifically. */
  readonly detail: string;
  /**
   * Columns of the row, carried verbatim — {@link OrphanRelation.carry}.
   *
   * This is the report's payload rather than its prose: for a dropped row it is
   * whatever identifies the thing that outlives the row (a media file id, a
   * federation activity URI), and nothing else will know it afterwards.
   */
  readonly evidence?: Readonly<Record<string, string>>;
}

/** Per-rule roll-up for the run report. */
export interface ResolutionSummary {
  readonly rule: ResolutionRule;
  readonly documents: number;
  readonly documentIds: readonly string[];
  readonly records: readonly ResolutionRecord[];
}

/**
 * Collects what the rules actually did.
 *
 * Deduped on `(rule, document, within)`, because a transform is run more than
 * once against the same document BY DESIGN — the deferred-self-reference pass
 * re-streams the collection, the referential audit runs every transform, and
 * the verifier re-runs it to compute its expectation. Recording the same fact
 * four times would inflate a count the operator is meant to check against the
 * audit's.
 */
export class ResolutionLog {
  private readonly records = new Map<string, ResolutionRecord>();

  record(entry: ResolutionRecord): void {
    this.records.set(`${entry.rule.id} ${entry.documentId} ${entry.within ?? ''}`, entry);
  }

  /**
   * Every rule with what it did, INCLUDING the rules that did nothing.
   *
   * A rule reporting zero documents is information: it says the rule is still
   * declared and this data did not need it.
   */
  summary(): readonly ResolutionSummary[] {
    return RESOLUTION_RULES.map((rule) => {
      const records = [...this.records.values()]
        .filter((entry) => entry.rule.id === rule.id)
        .sort((a, b) => (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0));
      return {
        rule,
        documents: records.length,
        documentIds: records.map((entry) => entry.documentId),
        records,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// the pre-pass
// ---------------------------------------------------------------------------

/**
 * What the documented rules are GOING to do, decided once before the copy.
 *
 * A rule that needs to compare documents against each other — "of these three
 * colliding rows, which survives?" — cannot answer from inside a transform,
 * which sees one document at a time. The pre-pass computes those answers ONCE,
 * against the source, and every phase then reads the same decision.
 *
 * Currently empty because no rule needs one yet. The seam exists so the first
 * one does not have to invent it, and so `--audit-only` and the copy provably
 * share the same decisions rather than computing them separately.
 */
export interface ResolutionPlan {
  /**
   * Rows a rule has decided to act on, keyed by rule id.
   *
   * A rule reads its own entry; nothing reads another rule's. Empty until a
   * rule is declared.
   */
  readonly actedOn: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Run every rule's pre-pass against the source.
 *
 * Takes the source rather than reaching for one, so the audit phase and the
 * copy phase provably run it against the same database.
 */
export async function planResolutions(source: MongoSource): Promise<ResolutionPlan> {
  // No rule declares a pre-pass yet. The parameter is still required so adding
  // one is a change to this function's BODY rather than to its signature and
  // every call site.
  void source;
  return { actedOn: new Map() };
}

// ---------------------------------------------------------------------------
// the context a transform runs under
// ---------------------------------------------------------------------------

/** Everything a transform needs to apply the documented rules. */
export interface ResolutionContext {
  /** Rows a rule has decided to act on, by rule id. */
  readonly actedOn: ReadonlyMap<string, ReadonlySet<string>>;
  /** Record that a rule changed what a document becomes. */
  readonly record: (entry: ResolutionRecord) => void;
  /**
   * Does a rule already answer this uniqueness collision?
   *
   * Asked by `auditUniqueness`, so `audit.ts` needs no knowledge of any
   * particular rule. True only when the rule acts on all but ONE of the group's
   * rows — the survivor. A group it would empty entirely, or one it does not
   * touch, is NOT resolved and still blocks: FAIL-CLOSED, because only a human
   * can say whether a collision the rule was not written for matters.
   *
   * With no rules declared this answers `false` for everything, so every
   * collision blocks. That is the correct inert state, not a stub.
   */
  readonly resolvesUniquenessGroup: (rule: ResolutionRule, ids: readonly string[]) => boolean;
}

/** Bind a plan and a log into the context a transform is called with. */
export function createResolutionContext(
  plan: ResolutionPlan,
  log: ResolutionLog
): ResolutionContext {
  return {
    actedOn: plan.actedOn,
    record: (entry) => {
      log.record(entry);
    },
    resolvesUniquenessGroup: (rule, ids) => {
      const acted = plan.actedOn.get(rule.id);
      if (acted === undefined || ids.length < 2) return false;
      // All but ONE. A rule that would empty the group has not decided which row
      // survives, so it has not answered the finding.
      return ids.filter((id) => acted.has(id)).length === ids.length - 1;
    },
  };
}

// ---------------------------------------------------------------------------
// the parent set a rule decides against
// ---------------------------------------------------------------------------

/**
 * The parent rows a rule decides against — supplied per phase, never cached.
 *
 * ## Why this is a parameter and not a snapshot
 *
 * The rules answer one question: "will this reference name a row Postgres
 * holds?" The only correct set to ask that of is the one the FOREIGN KEY will
 * check against, and a set read from MongoDB minutes earlier is not it.
 * Production Mongo takes writes throughout the cutover, so such a set is stale
 * by construction, and a row created inside that window is indistinguishable
 * from a parent deleted years ago. This is not hypothetical: the sibling
 * migration measured its `users` count moving 60,673 → 60,843 → 60,847 across
 * one attempt's three passes, and its overreach guard caught a rule about to
 * remove 8 rows whose parents were alive.
 *
 * So there is no cached set. Each phase supplies the set it can PROVE:
 *
 * | phase | the set | why it is exact |
 * |---|---|---|
 * | copy | `select id from <parent>` at the start of the LEVEL | the FK checks that same table microseconds later, and levels are topological so every parent row is already committed |
 * | audit | the ids the traversal has emitted so far | nothing is written yet, and level order means the parents are complete before a child is inspected |
 * | verify | the same query as the copy | it is checking what the copy wrote |
 *
 * ## It REFUSES rather than degrades
 *
 * {@link keysFor} throws for a table nobody loaded. There is deliberately no
 * fallback: a rule that quietly answered from the wrong parent set is precisely
 * the bug this shape exists to prevent, and "the set was unavailable" must stop
 * the run rather than change the answer. An EMPTY set is a different thing and
 * is honoured — it means the parent table holds nothing, which makes the rules
 * inert and leaves the orphans blocking, which is the decision a human has to
 * make anyway.
 *
 * ## What this does NOT fix
 *
 * It does not make the copy a snapshot. A row written to Mongo after its level
 * is copied is not in Postgres, and a child of it copied later still dangles —
 * that is a cutover-design problem (a write freeze, or a delta pass), not one a
 * predicate can solve, and nothing here pretends otherwise.
 */
export interface ParentKeys {
  /**
   * Every primary key the parent table holds, for the phase asking.
   *
   * @throws {MissingParentKeysError} When that table was not loaded.
   */
  keysFor(table: PgTable): ReadonlySet<string>;
}

/** Raised when a rule needs a parent set nobody supplied. */
export class MissingParentKeysError extends Error {
  constructor(
    readonly table: string,
    readonly loaded: readonly string[]
  ) {
    super(
      `No parent keys were loaded for ${table}, so a documented resolution ` +
        'cannot decide whether a reference to it resolves. Loaded: ' +
        `${loaded.join(', ') || '(none)'}. The run is refused rather than ` +
        'answered from a different set — deciding against the wrong parents is ' +
        'exactly the failure this contract exists to prevent.'
    );
    this.name = 'MissingParentKeysError';
  }
}

/** Bind an already-loaded map of parent keys into a {@link ParentKeys}. */
export function parentKeysFrom(loaded: ReadonlyMap<string, ReadonlySet<string>>): ParentKeys {
  return {
    keysFor(table) {
      const keys = loaded.get(tableName(table));
      if (keys === undefined) {
        throw new MissingParentKeysError(tableName(table), [...loaded.keys()]);
      }
      return keys;
    },
  };
}

/** Every parent table an `absent-parent` rule decides against. */
export function parentTablesForRules(): PgTable[] {
  const seen = new Set<string>();
  const tables: PgTable[] = [];
  for (const relation of ORPHAN_RESOLUTIONS) {
    // A cascade reads no parent set: its trigger is a removal this run
    // performed, not a row's presence anywhere.
    if (relation.trigger !== 'absent-parent') continue;
    const name = tableName(relation.targetTable);
    if (seen.has(name)) continue;
    seen.add(name);
    tables.push(relation.targetTable);
  }
  return tables;
}

// ---------------------------------------------------------------------------
// running a transform under the rules
// ---------------------------------------------------------------------------

/** One documented rule that fired on one emitted row. */
export interface AppliedOrphanResolution {
  readonly relation: OrphanRelation;
  /** The value the row carried — absent from the parent set, which is why it fired. */
  readonly value: string;
}

/**
 * One row a document produced, with what the documented rules did to it.
 *
 * `source` and `written` are BOTH carried, and the split is the whole point:
 *
 * - The **audit** checks references on `source`, so every orphan is still
 *   found, counted and named even when a rule removes the row that carried it.
 *   A rule that made the finding disappear would be a silenced check, which
 *   this file exists not to be.
 * - Everything that WRITES uses `written`, and cannot write a dropped row by
 *   accident: `written` is `null` for one, so a consumer has to handle the null
 *   before it has a row at all.
 */
export interface ResolvedRow {
  readonly table: PgTable;
  /** The row the transform built. Never written; it is the report's evidence. */
  readonly source: Record<string, unknown>;
  /** The row to WRITE, or `null` when a rule drops it entirely. */
  readonly written: Record<string, unknown> | null;
  /** Every rule that acted on it. Empty for the overwhelming majority of rows. */
  readonly applied: readonly AppliedOrphanResolution[];
}

/** What a record names when the document carries no `_id` to name it by. */
const UNIDENTIFIED_DOCUMENT = '(document has no _id)';

/**
 * Run a plan's transform and apply the documented ROW-level resolutions to
 * everything it emits.
 *
 * EVERY caller of `plan.transform` goes through this — the copy, both of the
 * verifier's passes, and the referential audit — which is what makes the
 * decisions identical across them by construction rather than by four call
 * sites remembering. It is also why orphan rules are NOT written inside the
 * transforms: a transform describes the MAPPING, one document to its rows, and
 * a rule that erases a row is not part of that description.
 */
export function transformDocument(
  plan: CollectionPlan,
  doc: MongoDocument,
  resolutions: ResolutionContext,
  /**
   * The parent rows to decide against — {@link ParentKeys}.
   *
   * A required PARAMETER rather than something the context carries, so no
   * caller can run a transform without saying which set of parents it is
   * entitled to answer from. The type system is the enforcement: the phase that
   * knows is the phase that supplies.
   */
  parents: ParentKeys,
  emit: (row: ResolvedRow) => void
): void {
  const documentId = describeId(doc) ?? UNIDENTIFIED_DOCUMENT;

  // The document's rows are COLLECTED before any is emitted, because a cascade
  // is a question about a SIBLING row: "was the parent this row names removed?"
  // Resolving as rows arrive would answer it from whatever had been seen so
  // far, making the outcome depend on the order a transform happens to emit in.
  // Buffering is one document's worth of rows, which the transform has already
  // built anyway.
  const built: Array<{ table: PgTable; row: Record<string, unknown> }> = [];
  plan.transform(
    doc,
    (table, row) => {
      built.push({ table, row });
    },
    resolutions
  );

  // Pass 1 — the rules that read the SOURCE: a value naming a parent Postgres
  // does not hold.
  const resolved = built.map((entry) =>
    resolveOrphanedReferences(entry.table, entry.row, documentId, resolutions, parents)
  );

  // Pass 2 — the declared CONSEQUENCES of pass 1, and only within this document.
  for (const row of cascadeWithinDocument(resolved, documentId, resolutions)) emit(row);
}

/**
 * Apply the declared `parent-dropped` cascades to one document's rows.
 *
 * The narrowness is the whole design, so it is worth stating what this CANNOT
 * do. It cannot reach a row from another document. It cannot fire on a relation
 * nobody declared, even one pointing at the same table — an undeclared relation
 * still blocks. And it cannot chain: a row this removes is not itself a
 * trigger, because triggers are matched against the keys pass 1 removed, not
 * against everything gone by the end.
 */
function cascadeWithinDocument(
  rows: readonly ResolvedRow[],
  documentId: string,
  resolutions: ResolutionContext
): readonly ResolvedRow[] {
  if (CASCADE_RESOLUTIONS.length === 0) return rows;

  // What pass 1 removed, by table and primary key.
  const removed = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.written !== null || row.applied.length === 0) continue;
    const key = singlePrimaryKeyProperty(row.table);
    if (key === null) continue;
    const value = row.source[key];
    if (typeof value !== 'string' || value.length === 0) continue;
    const name = tableName(row.table);
    const keys = removed.get(name);
    if (keys) keys.add(value);
    else removed.set(name, new Set([value]));
  }
  if (removed.size === 0) return rows;

  return rows.map((row) => {
    if (row.written === null) return row;
    const name = tableName(row.table);
    for (const relation of CASCADE_RESOLUTIONS) {
      if (relation.tableName !== name) continue;
      const value = row.source[relation.property];
      if (typeof value !== 'string' || value.length === 0) continue;
      if (!(removed.get(tableName(relation.targetTable))?.has(value) ?? false)) continue;
      return cascadedRow(row, relation, value, documentId, resolutions);
    }
    return row;
  });
}

/** The row a cascade removes, recorded and returned unwritten. */
function cascadedRow(
  row: ResolvedRow,
  relation: OrphanRelation,
  value: string,
  documentId: string,
  resolutions: ResolutionContext
): ResolvedRow {
  const key = singlePrimaryKeyProperty(relation.table);
  const rowId = key === null ? null : row.source[key];
  const evidence = carriedColumns(relation, row.source);

  resolutions.record({
    rule: relation.rule,
    documentId,
    // The ROW's own key, not the offending value: one document produces many
    // children of one parent, so keying on the parent id would collapse them
    // into a single record and the report would name one of the rows it
    // stranded.
    within: typeof rowId === 'string' ? rowId : value,
    detail:
      `${relation.tableName}.${relation.columnName} is ${JSON.stringify(value)}, ` +
      `a \`${tableName(relation.targetTable)}\` row that ` +
      `\`${relation.cascadesFrom?.rule.id ?? '(unknown rule)'}\` removes. The ROW ` +
      'is dropped with it: ON DELETE CASCADE is what the schema declares for ' +
      'this relation, and the removal it names has already happened.',
    ...(evidence === null ? {} : { evidence }),
  });

  return {
    table: row.table,
    source: row.source,
    written: null,
    applied: [...row.applied, { relation, value }],
  };
}

/**
 * Apply every declared orphan resolution to one emitted row.
 *
 * NARROW BY CONSTRUCTION, and the narrowness is worth spelling out because a
 * widened predicate here DELETES PRODUCTION ROWS:
 *
 * - Only a table named in {@link ORPHAN_RESOLUTIONS} is considered at all;
 *   every other row returns with `written === source` and nothing recorded.
 * - Only the ONE declared column of each entry is read.
 * - A NULL, absent or non-string value is left alone — a NULL component
 *   satisfies the constraint unconditionally, so there is no orphan to answer.
 * - The value must be ABSENT from the parent set THIS PHASE supplied — the rows
 *   Postgres holds when the level is copied, never a snapshot of Mongo taken
 *   earlier.
 * - An EMPTY parent set stands the rule down entirely; an UNLOADED one refuses
 *   the run ({@link MissingParentKeysError}).
 */
function resolveOrphanedReferences(
  table: PgTable,
  row: Record<string, unknown>,
  documentId: string,
  resolutions: ResolutionContext,
  parents: ParentKeys
): ResolvedRow {
  const declared = ORPHAN_RESOLUTIONS_BY_TABLE.get(tableName(table));
  if (declared === undefined) return { table, source: row, written: row, applied: [] };

  const applied: AppliedOrphanResolution[] = [];
  let dropped = false;
  let written = row;

  for (const relation of declared) {
    // THROWS for a table nobody loaded — never a fallback. An EMPTY set is a
    // different answer and is honoured.
    const known = parents.keysFor(relation.targetTable);
    if (known.size === 0) continue;
    const value = row[relation.property];
    if (typeof value !== 'string' || value.length === 0) continue;
    if (known.has(value)) continue;

    applied.push({ relation, value });
    if (relation.action === 'drop-row') dropped = true;
    else written = { ...written, [relation.property]: null };

    // Read off the SOURCE row: the columns a rule carries describe what the row
    // pointed at, and for a dropped row there will be nothing else left to read
    // them from.
    const evidence = carriedColumns(relation, row);

    resolutions.record({
      rule: relation.rule,
      documentId,
      // One document can produce several rows for the same relation, so the
      // record is keyed by the offending value too rather than collapsing them.
      within: value,
      detail:
        `${relation.tableName}.${relation.columnName} is ${JSON.stringify(value)}, ` +
        `which no \`${relation.parentCollection}\` document holds. ` +
        (relation.action === 'drop-row'
          ? 'The ROW is dropped and nothing else about it is written; ON DELETE ' +
            "CASCADE is the schema's own answer to a missing parent. " +
            (relation.whyNotNull === undefined
              ? 'The column is NOT NULL, so no value satisfies the constraint.'
              : 'The column is NULLABLE and NULL was deliberately not written — ' +
                'see the rule.')
          : 'The COLUMN is written NULL and the row is KEPT; the column is ' +
            'nullable with ON DELETE SET NULL, which is exactly where that ' +
            'policy puts a row whose parent is gone. Every other column is ' +
            'written verbatim.'),
      ...(evidence === null ? {} : { evidence }),
    });
  }

  return { table, source: row, written: dropped ? null : written, applied };
}

/**
 * The columns a rule carries, read off the row it is acting on.
 *
 * `null` when the rule carries none. A declared column the row does not hold is
 * REPORTED as `(absent)` rather than omitted: a worklist entry silently missing
 * its key would be worse than one that says the key was not there.
 */
function carriedColumns(
  relation: OrphanRelation,
  row: Record<string, unknown>
): Record<string, string> | null {
  if (relation.carry === undefined || relation.carry.length === 0) return null;
  const carried: Record<string, string> = {};
  for (const column of relation.carry) {
    const value = row[column.name];
    carried[sqlColumnName(column)] =
      value === null || value === undefined ? '(absent)' : String(value);
  }
  return carried;
}
