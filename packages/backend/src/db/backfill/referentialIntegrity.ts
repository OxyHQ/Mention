/**
 * The audit that has to run the transforms — foreign keys, checked before the
 * copy.
 *
 * ## Why this exists, and why the other audits were not enough
 *
 * The enum and uniqueness audits are QUERIES: one `distinct`, one `$group`, per
 * collection, answerable without building a single row. A foreign key is not
 * like that. It is a relation between two collections, and which value lands in
 * which column is decided by a plan's TRANSFORM — a Mongo field named
 * `parentPostId` might become `parent_post_id`, might be dropped, might be
 * derived. Nothing short of running the transform knows.
 *
 * That distinction is not academic. The sibling migration shipped without this
 * pass, reported CLEAN from the query-based audits, and then died on a foreign
 * key in level 2 of 6 — because Mongo enforced no referential integrity, so a
 * document naming a deleted parent was perfectly legal there and is `23503`
 * here. This pass costs roughly the read half of a copy. That is the price of
 * knowing, and it is much cheaper than finding out three hours in.
 *
 * ## The relations are DERIVED, never listed
 *
 * `referentialRelations` reads `getTableConfig(table).foreignKeys`. A
 * hand-written list of "relations worth checking" is the same defect in a new
 * place: it would be right on the day it was written and silently incomplete
 * after the next schema change, and the constraint it forgot is exactly the one
 * that fails. Constraint NAMES are reconstructed the way the DDL builds them
 * (SQL column names, then Postgres's 63-character truncation) so the name this
 * report prints is the name the operator's `23503` will carry.
 *
 * ## Three finding classes, and two of them may never be resolved
 *
 * - `referential-integrity` — a reference naming no row the migration produces.
 *   A documented rule MAY answer this one.
 * - `dropped-document` — a transform emitted fewer rows than it read documents.
 *   That is data going missing, and it blocks even with no foreign key pointing
 *   at the lost rows. No rule may clear it: the bug is in the transform.
 * - `resolution-overreach` — a rule acted on a row whose parent EXISTS. It is
 *   deleting or altering live data. No rule may clear it either; the migration
 *   would be agreeing with itself.
 *
 * ## A vacuity floor, because a clean report is the dangerous answer
 *
 * "0 orphans" means something only next to the number of relations, documents
 * and references the pass actually looked at. A traversal that inspected
 * nothing reports exactly the same verdict as a healthy database, and a check
 * that cannot distinguish success from failure is worse than no check at all.
 * {@link assertNotVacuous} refuses that report rather than printing it.
 */

import { is, sql } from 'drizzle-orm';
import {
  getTableConfig,
  PgTable,
  type PgColumn,
  type UpdateDeleteAction,
} from 'drizzle-orm/pg-core';
import { sqlColumnName } from '../casing';
import type { Database } from '../postgres';
import type { AuditFinding } from './audit';
import { streamCollection, type MongoSource } from './mongoSource';
import { planTables, singlePrimaryKeyProperty, tableName, type CollectionPlan } from './plan';
import {
  ORPHAN_RESOLUTIONS,
  parentKeysFrom,
  transformDocument,
  type OrphanRelation,
  type ResolutionContext,
  type ResolutionRule,
} from './resolutions';

/** Postgres truncates an identifier to this many bytes. */
const MAX_IDENTIFIER_LENGTH = 63;

/** Drizzle's default when a foreign key declares no `onDelete`. */
const DEFAULT_ON_DELETE: UpdateDeleteAction = 'no action';

/** How many offending ids to quote per finding. */
const SAMPLE_LIMIT = 5;

/** Distinct offending VALUES to keep per relation, so one bad join cannot flood. */
export const MAX_REPORTED_ORPHAN_VALUES = 50;

/** Offending document ids to keep per relation. */
export const MAX_REPORTED_ORPHAN_DOCUMENT_IDS = 100;

/** One column of a foreign key, under both its names. */
export interface RelationColumn {
  /** The TypeScript PROPERTY name — the key an emitted row uses. */
  readonly property: string;
  /** The SQL name — what the report and the error message print. */
  readonly sqlName: string;
  readonly notNull: boolean;
}

/** One foreign key, as this audit needs to read it. */
export interface Relation {
  /** The constraint name Postgres will print in a `23503`. */
  readonly constraint: string;
  readonly table: PgTable;
  readonly tableName: string;
  readonly columns: readonly RelationColumn[];
  readonly targetTable: PgTable;
  readonly targetTableName: string;
  readonly targetColumns: readonly RelationColumn[];
  /** Whether any component is nullable — changes the RECOMMENDATION, not the verdict. */
  readonly nullable: boolean;
  readonly onDelete: UpdateDeleteAction;
}

/**
 * Every foreign key on every table the given plans write.
 *
 * Deduplicated by constraint name and sorted, so the report is stable between
 * runs and a diff of two runs is readable.
 */
export function referentialRelations(plans: readonly CollectionPlan[]): Relation[] {
  const seen = new Set<string>();
  const relations: Relation[] = [];

  for (const plan of plans) {
    for (const table of planTables(plan)) {
      for (const foreignKey of getTableConfig(table).foreignKeys) {
        const relation = describeRelation(table, foreignKey.onDelete, foreignKey.reference());
        if (seen.has(relation.constraint)) continue;
        seen.add(relation.constraint);
        relations.push(relation);
      }
    }
  }

  return relations.sort((a, b) =>
    a.constraint < b.constraint ? -1 : a.constraint > b.constraint ? 1 : 0
  );
}

/** One drizzle `ForeignKey`, resolved into the names and nullability it implies. */
function describeRelation(
  table: PgTable,
  onDelete: UpdateDeleteAction | undefined,
  reference: {
    readonly name?: string;
    readonly columns: PgColumn[];
    readonly foreignTable: PgTable;
    readonly foreignColumns: PgColumn[];
  }
): Relation {
  if (!is(reference.foreignTable, PgTable)) {
    throw new Error(
      `The foreign key on ${tableName(table)} references something that is not a ` +
        'PgTable, so its referenced set cannot be determined. Skipping it would ' +
        'make this audit silently stop checking a real constraint.'
    );
  }

  const columns = reference.columns.map(toRelationColumn);
  const targetColumns = reference.foreignColumns.map(toRelationColumn);
  const sourceName = tableName(table);
  const targetName = tableName(reference.foreignTable);

  return {
    // The DDL names it from the SQL column names, so this must too — drizzle's
    // own `getName()` uses the TypeScript property names and answers a name
    // that appears nowhere in Postgres. An explicit `foreignKey({name})` wins,
    // exactly as it does in the generated migration. Then Postgres's own
    // truncation, so the name printed is the name the operator's `23503`
    // carries.
    constraint: truncateIdentifier(
      reference.name ??
        [
          sourceName,
          ...columns.map((column) => column.sqlName),
          targetName,
          ...targetColumns.map((column) => column.sqlName),
          'fk',
        ].join('_')
    ),
    table,
    tableName: sourceName,
    columns,
    targetTable: reference.foreignTable,
    targetTableName: targetName,
    targetColumns,
    nullable: columns.some((column) => !column.notNull),
    onDelete: onDelete ?? DEFAULT_ON_DELETE,
  };
}

/**
 * An identifier as Postgres STORES it, truncated to {@link MAX_IDENTIFIER_LENGTH}.
 *
 * Exported because it is the answer to "why does the constraint in my error not
 * match the one in the migration file".
 */
export function truncateIdentifier(name: string): string {
  return name.length <= MAX_IDENTIFIER_LENGTH ? name : name.slice(0, MAX_IDENTIFIER_LENGTH);
}

function toRelationColumn(column: PgColumn): RelationColumn {
  return {
    // `column.name` on a drizzle column is the TypeScript PROPERTY name — the
    // key an emitted row uses. `sqlColumnName` is the other half; confusing the
    // two is the trap `db/casing.ts` exists to close.
    property: column.name,
    sqlName: sqlColumnName(column),
    notNull: column.notNull,
  };
}

/** The relation as an operator reads it: `posts.parent_post_id -> posts.id`. */
export function describeRelationColumns(relation: Relation): string {
  const from = relation.columns.map((column) => column.sqlName).join(', ');
  const to = relation.targetColumns.map((column) => column.sqlName).join(', ');
  return `${relation.tableName}.${from} -> ${relation.targetTableName}.${to}`;
}

/** What an operator can do about a given orphan, derived from the schema. */
export type OrphanResolvability =
  /** The column is NULLABLE, so writing NULL keeps the row and satisfies the FK. */
  | 'nullable-column'
  /** The column is NOT NULL, so the row cannot be written at all. */
  | 'row-cannot-exist';

/** What the schema says an operator's options are for this relation. */
export function orphanResolvability(relation: Relation): OrphanResolvability {
  return relation.nullable ? 'nullable-column' : 'row-cannot-exist';
}

/** What one plan's traversal emitted, so a loss can be noticed. */
export interface PlanEmission {
  readonly collection: string;
  readonly documentsRead: number;
  /** Rows emitted for the plan's OWN table — one per document, when faithful. */
  readonly primaryRowsEmitted: number;
  /**
   * Documents a DOCUMENTED RULE removed whole, recorded by id.
   *
   * Subtracted below, and it is the only thing that is. See
   * `ResolutionContext.dropDocument` for why the two kinds of loss must stay
   * distinguishable.
   */
  readonly documentsDroppedByRule: number;
}

/**
 * Documents that produced no row in their own table AND that nothing decided
 * to remove.
 *
 * A transform emits exactly one primary row per document, so a shortfall is
 * data going missing. Reported as its own blocking finding whether or not any
 * foreign key points at the lost rows, and no resolution rule may clear it.
 *
 * The one subtraction is a drop a documented rule RECORDED BY ID — which is a
 * reviewed decision, not a loss. Note that a row a rule merely NULLs a column
 * on, or drops as an orphan, is still emitted and so never reaches this
 * arithmetic at all: `primaryRowsEmitted` counts what the transform emitted,
 * before any rule ran.
 */
export function droppedDocuments(emission: PlanEmission): number {
  return Math.max(
    0,
    emission.documentsRead - emission.primaryRowsEmitted - emission.documentsDroppedByRule
  );
}

/** Did this plan emit a primary row for every document it read? */
export function emissionIsFaithful(emission: PlanEmission): boolean {
  return droppedDocuments(emission) === 0;
}

/** One foreign key as POSTGRES holds it, read from `pg_constraint`. */
export interface DeployedRelation {
  readonly constraint: string;
  readonly tableName: string;
  readonly targetTableName: string;
}

/**
 * Every foreign key the migrated database actually has.
 *
 * `pg_constraint` is the authority here for the same reason `listCollections()`
 * is the authority for the source: the CODE is what might be wrong. A relation
 * this audit fails to derive from the drizzle metadata is invisible to every
 * other check in this file, and the report would still say "N relations
 * inspected" — a number that reads as coverage and is not.
 */
export async function deployedForeignKeys(db: Database): Promise<DeployedRelation[]> {
  const rows = await db.execute<{
    constraint_name: string;
    table_name: string;
    target_table_name: string;
  }>(sql`
    select c.conname as constraint_name,
           child.relname as table_name,
           parent.relname as target_table_name
    from pg_constraint c
    join pg_class child on child.oid = c.conrelid
    join pg_class parent on parent.oid = c.confrelid
    join pg_namespace n on n.oid = child.relnamespace
    where c.contype = 'f' and n.nspname = 'public'
    order by 1
  `);
  return rows.map((row) => ({
    constraint: row.constraint_name,
    tableName: row.table_name,
    targetTableName: row.target_table_name,
  }));
}

/**
 * How much of the deployed foreign-key graph this audit actually derived.
 *
 * ## Why IN SCOPE is the only fair denominator
 *
 * `referentialRelations` walks the tables the CURRENT plans write, so while
 * collections are still unplanned most of the schema's foreign keys are
 * legitimately outside its reach. Measuring against every deployed constraint
 * would report a huge permanent shortfall that is nobody's defect, and a gate
 * that reports a defect nobody can fix is a gate that gets disabled by whoever
 * hits it next.
 *
 * So the denominator is the constraints whose CHILD table a plan writes — the
 * ones the audit claims to cover. In a healthy state that number and
 * {@link derived} are equal, because both are computed from the same plan set;
 * a gap between them is a defect in the DERIVATION, not in the data and not in
 * how far the migration has got.
 */
export interface RelationCoverage {
  /** Deployed constraints whose child table a current plan writes. */
  readonly deployedInScope: number;
  /** How many of those the audit derived, by constraint name. */
  readonly derived: number;
  /** In scope and NOT derived — each one a defect in this checker. */
  readonly missing: readonly DeployedRelation[];
  /** Deployed constraints on tables no plan writes yet. Expected, not a fault. */
  readonly outOfScope: number;
}

/**
 * Reconcile the derived relation set against the deployed one.
 *
 * Compared by CONSTRAINT NAME, which is the identifier a `23503` carries and
 * therefore the only one an operator can act on. That also makes the check
 * catch a naming defect and not just a missing relation: if `describeRelation`
 * computes a name Postgres does not have, the audit has been reporting a
 * constraint that does not exist, and this is what says so.
 */
export function reconcileRelations(
  derived: readonly Relation[],
  deployed: readonly DeployedRelation[],
  plannedTables: ReadonlySet<string>
): RelationCoverage {
  const derivedNames = new Set(derived.map((relation) => relation.constraint));
  const inScope = deployed.filter((relation) => plannedTables.has(relation.tableName));
  const missing = inScope.filter((relation) => !derivedNames.has(relation.constraint));
  return {
    deployedInScope: inScope.length,
    derived: inScope.length - missing.length,
    missing,
    outOfScope: deployed.length - inScope.length,
  };
}

/** One offending value, with how many rows carried it. */
export interface OrphanValue {
  readonly value: string;
  readonly documents: number;
}

/** What one relation's check found. */
export interface RelationOrphans {
  readonly relation: Relation;
  readonly documents: number;
  readonly values: readonly OrphanValue[];
  readonly documentIds: readonly string[];
  readonly resolvedBy?: ResolutionRule;
}

/** Everything the pass inspected, whether or not it found anything. */
export interface ReferentialIntegrityReport {
  /** Absent when the pass ran; set to the reason when it deliberately did not. */
  readonly notRunReason?: string;
  readonly relationsInspected: number;
  /** Relations that actually saw a non-null reference. */
  readonly relationsExercised: number;
  /**
   * How much of the DEPLOYED foreign-key graph the derivation actually found.
   *
   * Absent when the pass did not run. This is the number that turns
   * `relationsInspected` from a count into coverage: 8 relations inspected is a
   * clean-looking report whether the schema has 8 constraints in scope or 42.
   */
  readonly coverage?: RelationCoverage;
  readonly collectionsInspected: number;
  readonly documentsInspected: number;
  readonly referencesChecked: number;
  readonly orphans: readonly RelationOrphans[];
  readonly emissions: readonly PlanEmission[];
  readonly findings: readonly AuditFinding[];
}

/** The report for a pass that deliberately did not run. */
export function referentialIntegrityNotRun(reason: string): ReferentialIntegrityReport {
  return {
    notRunReason: reason,
    relationsInspected: 0,
    relationsExercised: 0,
    collectionsInspected: 0,
    documentsInspected: 0,
    referencesChecked: 0,
    orphans: [],
    emissions: [],
    findings: [],
  };
}

/**
 * Raised when the pass inspected so little that a clean verdict proves nothing.
 *
 * The vacuity floor. A broken traversal — a plan list that came out empty, a
 * source that returned no documents, a relation derivation that found no
 * foreign keys — produces the identical "0 orphans" a healthy database does.
 * Refusing to report is the only way the two stay distinguishable.
 */
export class VacuousReferentialIntegrityError extends Error {
  constructor(
    readonly report: ReferentialIntegrityReport,
    reason: string
  ) {
    super(
      'The referential-integrity audit inspected nothing and therefore proves ' +
        `nothing: ${reason}. It derived ${report.relationsInspected} relation(s), ` +
        `exercised ${report.relationsExercised} of them, ` +
        `streamed ${report.collectionsInspected} collection(s), read ` +
        `${report.documentsInspected} document(s) and checked ` +
        `${report.referencesChecked} reference(s). A clean report from a check ` +
        'that never ran is the exact defect this audit was added to fix.'
    );
    this.name = 'VacuousReferentialIntegrityError';
  }
}

/**
 * Refuse a report that inspected too little to mean anything.
 *
 * Deliberately NOT a count of orphans — finding none is the expected healthy
 * outcome. What must be non-zero is the WORK: relations derived, collections
 * streamed, documents read. `referencesChecked` is exempt from the floor
 * because a schema whose tables genuinely hold no cross-references yet would
 * legitimately report zero, and a floor that fires on a correct state is a
 * floor someone disables.
 */
export function assertNotVacuous(report: ReferentialIntegrityReport): void {
  if (report.relationsInspected === 0) {
    throw new VacuousReferentialIntegrityError(report, 'no foreign key was derived at all');
  }
  if (report.collectionsInspected === 0) {
    throw new VacuousReferentialIntegrityError(report, 'no collection was streamed');
  }
  if (report.documentsInspected === 0) {
    throw new VacuousReferentialIntegrityError(report, 'no document was read');
  }
  // The half the floor was missing, and the one that matters most in practice.
  // The three checks above ask whether the pass did ANY work; this one asks
  // whether the work COVERED what it claims to. A derivation that silently
  // found 8 of 42 relations passes all three and reports "0 orphans" — a clean
  // verdict over a fifth of the graph, indistinguishable from a clean verdict
  // over all of it.
  //
  // Scoped to constraints whose CHILD table a current plan writes, because a
  // relation on an unplanned table is expected to be uncovered while
  // collections remain unplanned. Conflating the two would make this fire
  // permanently on a state nobody can fix, which is how a gate gets disabled.
  const coverage = report.coverage;
  if (coverage !== undefined && coverage.missing.length > 0) {
    throw new VacuousReferentialIntegrityError(
      report,
      `the derivation found ${coverage.derived} of ${coverage.deployedInScope} ` +
        'foreign key(s) deployed on tables these plans write, so this report ' +
        'covers less of the graph than it appears to. Deployed but NOT derived: ' +
        coverage.missing
          .map((relation) => `${relation.constraint} (${relation.tableName})`)
          .join(', ')
    );
  }
}

/** Accumulates one relation's offending values without unbounded growth. */
interface OrphanAccumulator {
  documents: number;
  readonly documentsByValue: Map<string, number>;
  readonly documentIds: string[];
}

/** What one documented rule did, measured by THIS pass rather than reported by the rule. */
interface AppliedTally {
  readonly relation: OrphanRelation;
  rows: number;
  readonly values: Set<string>;
  readonly documentIds: string[];
  readonly droppedIds: Set<string>;
}

/**
 * Stream every mapped collection, run its transform, and check every reference
 * the emitted rows carry.
 *
 * ## The two-phase shape, and why the parent set is what it is
 *
 * Phase 1 collects, per table, the primary keys the migration WILL produce.
 * Phase 2 re-streams and checks each reference against those sets. Two passes
 * rather than one because a reference can point forward — a reply's parent may
 * sort after it — so a single pass would report a healthy reference as an
 * orphan purely on cursor order.
 *
 * Nothing is written when this runs, so the parent set handed to the documented
 * rules is the set of ids phase 1 emitted: exactly the rows the copy will
 * create, which is the same question the foreign key will ask. That is a
 * DIFFERENT set from the one the copy uses (which reads Postgres) and it is
 * correct for this phase for the same reason — it is the set this phase can
 * prove.
 */
export async function auditReferentialIntegrity(
  db: Database,
  source: MongoSource,
  planned: ReadonlyArray<{ plan: CollectionPlan; documents: number }>,
  resolutions: ResolutionContext,
  options: { readonly batchSize?: number } = {}
): Promise<ReferentialIntegrityReport> {
  const batchSize = options.batchSize ?? 1000;
  const plans = planned.map((entry) => entry.plan);
  const relations = referentialRelations(plans);

  // Which relations can actually be exercised: only those whose TARGET table is
  // fed by a plan in this run. A reference to a table nothing feeds would report
  // every row as an orphan, which is true but useless — and the runner requires
  // the complete plan set precisely so this does not happen.
  const fedTables = new Set<string>();
  for (const plan of plans) for (const table of planTables(plan)) fedTables.add(tableName(table));

  // ---- phase 0: is the derivation itself complete? ------------------------
  //
  // Before asking anything about the DATA, ask whether this audit found the
  // constraints it is about to claim coverage of. `pg_constraint` is the
  // authority; the drizzle walk is the thing that might be wrong.
  const coverage = reconcileRelations(relations, await deployedForeignKeys(db), fedTables);
  const coverageFindings: AuditFinding[] = coverage.missing.map((relation) => ({
    collection: '(schema)',
    kind: 'undetected-relation' as const,
    detail:
      `${relation.constraint} is a foreign key on ${relation.tableName} → ` +
      `${relation.targetTableName} that Postgres HAS and this audit did not ` +
      'derive from the drizzle metadata. Every reference through it is therefore ' +
      'unchecked, and the orphan verdict below says nothing about it. This is a ' +
      'defect in the checker, not in the data — no change to Mongo can clear it.',
    documents: 0,
    sampleIds: [],
  }));

  // ---- phase 1: every primary key the migration will produce ---------------
  const emittedKeys = new Map<string, Set<string>>();
  for (const name of fedTables) emittedKeys.set(name, new Set());

  const emissions: PlanEmission[] = [];
  let collectionsInspected = 0;
  let documentsInspected = 0;

  // The rules stand down entirely in phase 1: their parent sets are not built
  // yet, so asking them anything would answer from an empty map. An empty
  // `ParentKeys` is honest about that — `keysFor` throws rather than pretending.
  const noParents = parentKeysFrom(new Map());

  for (const { plan } of planned) {
    collectionsInspected += 1;
    let documentsRead = 0;
    let primaryRowsEmitted = 0;
    const primaryName = tableName(plan.table);

    for await (const documents of streamCollection(source, plan.collection, batchSize)) {
      for (const doc of documents) {
        documentsRead += 1;
        transformDocument(plan, doc, resolutions, noParents, (row) => {
          const name = tableName(row.table);
          // Keys are taken from `source`, not `written`: phase 1 is building the
          // set of rows that EXIST for the purposes of checking references, and
          // a row a rule drops is measured separately by the overreach guard.
          const key = singlePrimaryKeyProperty(row.table);
          if (key !== null) {
            const value = row.source[key];
            if (typeof value === 'string' && value.length > 0) {
              emittedKeys.get(name)?.add(value);
            }
          }
          if (name === primaryName) primaryRowsEmitted += 1;
        });
      }
    }

    documentsInspected += documentsRead;
    emissions.push({
      collection: plan.collection,
      documentsRead,
      primaryRowsEmitted,
      // Read AFTER the whole collection streamed, so it covers every document a
      // rule removed rather than whatever had been seen partway through.
      documentsDroppedByRule: resolutions.documentsDroppedIn(plan.collection),
    });
  }

  // ---- phase 2: check every reference against those sets -------------------
  const parents = parentKeysFrom(emittedKeys);
  const relationsByTable = new Map<string, Relation[]>();
  for (const relation of relations) {
    if (!fedTables.has(relation.targetTableName)) continue;
    const existing = relationsByTable.get(relation.tableName);
    if (existing) existing.push(relation);
    else relationsByTable.set(relation.tableName, [relation]);
  }

  const orphansByConstraint = new Map<string, OrphanAccumulator>();
  const applied = new Map<OrphanRelation, AppliedTally>();
  const exercised = new Set<string>();
  let referencesChecked = 0;

  for (const { plan } of planned) {
    for await (const documents of streamCollection(source, plan.collection, batchSize)) {
      for (const doc of documents) {
        transformDocument(plan, doc, resolutions, parents, (row) => {
          const name = tableName(row.table);

          // Measure what the rules DID, independently of what they reported.
          for (const entry of row.applied) {
            const tally = applied.get(entry.relation) ?? {
              relation: entry.relation,
              rows: 0,
              values: new Set<string>(),
              documentIds: [],
              droppedIds: new Set<string>(),
            };
            tally.rows += 1;
            tally.values.add(entry.value);
            if (tally.documentIds.length < MAX_REPORTED_ORPHAN_DOCUMENT_IDS) {
              const id = row.source[singlePrimaryKeyProperty(row.table) ?? 'id'];
              if (typeof id === 'string') tally.documentIds.push(id);
            }
            if (row.written === null) {
              const key = singlePrimaryKeyProperty(row.table);
              const id = key === null ? null : row.source[key];
              if (typeof id === 'string') tally.droppedIds.add(id);
            }
            applied.set(entry.relation, tally);
          }

          // References are checked on the SOURCE row, so an orphan is still
          // found, counted and named even when a rule removes the row that
          // carried it. A rule that made the finding disappear would be a
          // silenced check.
          for (const relation of relationsByTable.get(name) ?? []) {
            // Composite keys are checked component-wise only when EVERY
            // component is present: under MATCH SIMPLE a single NULL satisfies
            // the constraint unconditionally.
            const values = relation.columns.map((column) => row.source[column.property]);
            if (values.some((value) => typeof value !== 'string' || value.length === 0)) continue;
            // Single-column is the only shape this schema uses; a composite
            // would need the target's own composite index to check against, and
            // asserting on the first component alone would be a check that
            // answers a narrower question than the constraint.
            if (relation.columns.length !== 1) continue;

            const value = values[0] as string;
            referencesChecked += 1;
            exercised.add(relation.constraint);
            if (emittedKeys.get(relation.targetTableName)?.has(value) ?? false) continue;

            const accumulator = orphansByConstraint.get(relation.constraint) ?? {
              documents: 0,
              documentsByValue: new Map<string, number>(),
              documentIds: [],
            };
            accumulator.documents += 1;
            if (
              accumulator.documentsByValue.size < MAX_REPORTED_ORPHAN_VALUES ||
              accumulator.documentsByValue.has(value)
            ) {
              accumulator.documentsByValue.set(
                value,
                (accumulator.documentsByValue.get(value) ?? 0) + 1
              );
            }
            if (accumulator.documentIds.length < MAX_REPORTED_ORPHAN_DOCUMENT_IDS) {
              const id = doc._id;
              if (id !== null && id !== undefined) accumulator.documentIds.push(String(id));
            }
            orphansByConstraint.set(relation.constraint, accumulator);
          }
        });
      }
    }
  }

  // ---- assemble ------------------------------------------------------------
  const answeredBy = new Map<string, ResolutionRule | undefined>();
  for (const relation of ORPHAN_RESOLUTIONS) {
    if (relation.trigger !== 'absent-parent') continue;
    for (const candidate of relations) {
      if (candidate.tableName !== relation.tableName) continue;
      if (!candidate.columns.some((column) => column.property === relation.property)) continue;
      answeredBy.set(candidate.constraint, relation.rule);
    }
  }

  const orphans: RelationOrphans[] = [];
  const findings: AuditFinding[] = [];

  for (const relation of relations) {
    const accumulator = orphansByConstraint.get(relation.constraint);
    if (accumulator === undefined) continue;
    const resolvedBy = answeredBy.get(relation.constraint);
    // `documents` alone is a TIE — and a tie is the NORMAL case here, because
    // most orphaned values are referenced exactly once. `MAX_REPORTED_ORPHAN_
    // VALUES` then keeps whichever 50 the sort happened to leave in front, so
    // two runs over the same data can report two different sets and an operator
    // who fixes the first 50 is handed a different 50 with nothing saying the
    // report was a sample. The value is unique per entry, so it makes the order
    // total and the truncation reproducible.
    const values = [...accumulator.documentsByValue.entries()]
      .map(([value, documents]) => ({ value, documents }))
      .sort((a, b) => b.documents - a.documents || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));

    orphans.push({
      relation,
      documents: accumulator.documents,
      values,
      documentIds: accumulator.documentIds,
      ...(resolvedBy === undefined ? {} : { resolvedBy }),
    });

    findings.push({
      collection: relation.tableName,
      kind: 'referential-integrity',
      detail:
        `${relation.constraint} (${describeRelationColumns(relation)}, ` +
        `ON DELETE ${relation.onDelete}) would reject ${accumulator.documents} row(s): ` +
        `they name a ${relation.targetTableName} row the migration does not produce. ` +
        `e.g. ${values
          .slice(0, SAMPLE_LIMIT)
          .map((entry) => `${JSON.stringify(entry.value)} (${entry.documents})`)
          .join(', ')}. ` +
        (orphanResolvability(relation) === 'nullable-column'
          ? 'The column is NULLABLE, so writing NULL would keep the row — but ' +
            'that is a decision, not a default.'
          : 'The column is NOT NULL, so no value satisfies the constraint and ' +
            'the row cannot be written at all.'),
      documents: accumulator.documents,
      sampleIds: accumulator.documentIds.slice(0, SAMPLE_LIMIT),
      ...(resolvedBy === undefined ? {} : { resolvedBy }),
    });
  }

  for (const emission of emissions) {
    if (emissionIsFaithful(emission)) continue;
    findings.push(describeDroppedDocuments(emission));
  }

  findings.push(...describeOverreach(applied, relations, orphansByConstraint));

  const report: ReferentialIntegrityReport = {
    coverage,
    relationsInspected: relations.length,
    relationsExercised: exercised.size,
    collectionsInspected,
    documentsInspected,
    referencesChecked,
    orphans,
    emissions,
    findings: [...coverageFindings, ...findings],
  };

  assertNotVacuous(report);
  return report;
}

/** A transform that read more documents than it emitted primary rows for. */
function describeDroppedDocuments(emission: PlanEmission): AuditFinding {
  const dropped = droppedDocuments(emission);
  return {
    collection: emission.collection,
    kind: 'dropped-document',
    detail:
      `The transform for ${emission.collection} read ${emission.documentsRead} ` +
      `document(s) but emitted only ${emission.primaryRowsEmitted} row(s) for its ` +
      `own table — ${dropped} document(s) produced nothing. A transform emits one ` +
      'primary row per document; a shortfall is data going missing, so the copy is ' +
      'refused. No resolution rule may answer this: the bug is in the transform.',
    documents: dropped,
    // Which documents were skipped is not knowable from a count, and inventing
    // a sample would be worse than an honest none — the transform is where to
    // look, and the transform is named above.
    sampleIds: [],
  };
}

/**
 * A documented rule that acted on rows this pass found NO orphan for.
 *
 * The guard against a widened predicate. A rule is supposed to fire only on a
 * reference whose parent the migration does not produce, and this pass builds
 * that set INDEPENDENTLY — from the rows the transforms emit, not from the
 * pre-pass the rule consults. When the rule acted on more rows than that set
 * contains, or on a value that is not in it, it fired on a row whose parent
 * EXISTS: it is deleting or altering live data.
 *
 * That is a finding no rule may ever answer, for the same reason
 * `dropped-document` is: a rule clearing it would be the migration agreeing
 * with itself.
 */
function describeOverreach(
  applied: ReadonlyMap<OrphanRelation, AppliedTally>,
  relations: readonly Relation[],
  orphansByConstraint: ReadonlyMap<string, OrphanAccumulator>
): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const tally of applied.values()) {
    const relation = relations.find(
      (candidate) =>
        candidate.tableName === tally.relation.tableName &&
        candidate.columns.some((column) => column.property === tally.relation.property)
    );
    if (relation === undefined) continue;
    const orphans = orphansByConstraint.get(relation.constraint);
    const orphanRows = orphans?.documents ?? 0;
    const unexplained = [...tally.values].filter(
      (value) => !(orphans?.documentsByValue.has(value) ?? false)
    );
    if (tally.rows <= orphanRows && unexplained.length === 0) continue;

    findings.push({
      collection: tally.relation.collection,
      kind: 'resolution-overreach',
      detail:
        `\`${tally.relation.rule.id}\` acted on ${tally.rows} row(s) of ` +
        `${relation.constraint}, but this pass found only ${orphanRows} row(s) ` +
        'whose parent is actually missing' +
        (unexplained.length === 0
          ? ''
          : ` — and ${unexplained.length} of the values it acted on name a ` +
            `${relation.targetTableName} row the migration DOES produce, e.g. ` +
            `${unexplained
              .slice(0, SAMPLE_LIMIT)
              .map((value) => JSON.stringify(value))
              .join(', ')}`) +
        '. The rule fired on a row whose parent EXISTS, which means it is ' +
        'removing or altering live production data. Its predicate is wrong, or ' +
        'the parent set it reads is. No resolution rule may answer this: the ' +
        'copy is refused until the two agree.',
      documents: tally.rows,
      sampleIds: tally.documentIds.slice(0, SAMPLE_LIMIT),
    });
  }

  return findings.sort((a, b) => (a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0));
}
