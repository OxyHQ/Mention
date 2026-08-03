/**
 * The copy itself: Mongo → Postgres, batched, resumable, idempotent.
 *
 * ## Idempotence is structural, not bookkept
 *
 * Every insert is `ON CONFLICT DO NOTHING` with no conflict target, which
 * covers the primary key AND every unique constraint on the table. Because ids
 * are copied VERBATIM (`db/MIGRATION-CONTRACT.md`), a row that is already there
 * conflicts on its own id and is skipped. Re-running the whole backfill from
 * zero is therefore always safe — merely slower than resuming.
 *
 * That property is what makes the checkpoint an OPTIMISATION rather than a
 * correctness mechanism, which is the right way round: losing it must cost
 * time, never integrity. It is nonetheless stored in POSTGRES rather than a
 * file, because at this scale "merely slower" stops being merely — see
 * `checkpointStore.ts`.
 *
 * ## Sized against the largest collection, not the median
 *
 * Census, 2026-08-02: `authorfollowersnapshots` **2,155,466** documents,
 * `posts` **573,339**, and a long tail of collections in the hundreds. The
 * defaults below are chosen for the first of those, because the median
 * collection finishes in one batch either way and it is the 2.1M one that
 * decides whether the run is an afternoon or an evening.
 *
 * ## Self-references are deferred, per collection
 *
 * `posts` is the only self-referencing TABLE, and it carries FOUR such columns:
 * `boostOf`, `parentPostId`, `quoteOf`, `threadId`. Postgres checks each
 * IMMEDIATELY (none of the constraints is `DEFERRABLE`), so a row whose target
 * sorts later by `_id` fails on insert — routine rather than theoretical, since
 * a federated post's import-time `_id` bears no relation to the id of what it
 * replies to, boosts or quotes.
 *
 * So pass A inserts every self-referencing column as NULL, and pass B
 * re-streams the SAME collection and fills them in once every row of that table
 * exists. Pass B is a second read rather than an in-memory buffer so 573,339
 * posts cannot blow the task's memory — exactly the reason pass A is batched in
 * the first place. The columns are DERIVED (`selfReferencingColumns`), never
 * listed, so all four are handled without this comment having to be right.
 */

import { eq, getTableColumns, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { getPostgresClient, type Database } from '../postgres';
import {
  auditColumnCoverageForPlan,
  auditDefaultedColumns,
  auditEnums,
  auditNumerics,
  auditUniqueness,
  auditWouldBlockCopy,
  type AuditFinding,
} from './audit';
import { analyzeTables, copyRowsInto } from './bulkLoad';
import { classifyCollection, COLLECTION_PLANS, NOT_MIGRATED } from './collectionMap';
import {
  checkpointOf,
  streamCollection,
  type Checkpoint,
  type MongoSource,
} from './mongoSource';
import { planLevels, selfReferencingColumns } from './order';
import { planTables, tableName, type CollectionPlan } from './plan';
import {
  auditReferentialIntegrity,
  referentialIntegrityNotRun,
  scanEmittedRows,
  type ReferentialIntegrityReport,
} from './referentialIntegrity';
import { assertParentsPrecedeChildren, loadParentKeyMap, loadParentKeys } from './parentKeys';
import {
  createResolutionContext,
  parentKeysFrom,
  parentTablesForRules,
  planResolutions,
  ResolutionLog,
  transformDocument,
  type ParentKeys,
  type ResolutionContext,
  type ResolutionPlan,
  type ResolutionSummary,
} from './resolutions';

/**
 * How many documents to transform and load per COPY batch.
 *
 * 5,000 against the 2.1M collection is ~431 batches: small enough that a
 * failure loses seconds of work and that WAL, lock duration and peak memory all
 * stay bounded, large enough that the per-batch cost (two DDL statements and
 * one `INSERT … SELECT`) stays amortised. It is a knob because the right value
 * genuinely differs between `authorfollowersnapshots` (a handful of narrow
 * columns) and `posts` (wide rows feeding ten child tables).
 */
export const DEFAULT_BATCH_SIZE = 5000;

/**
 * How many collections of one FK level to copy concurrently.
 *
 * Bounded by the Postgres pool (`PG_MAX_POOL_SIZE`), because a `COPY` holds its
 * connection for the whole stream and each concurrent collection also holds a
 * Mongo cursor. 8 leaves room for the deferred-reference pass and the verifier
 * to hold connections at the same time.
 */
export const DEFAULT_CONCURRENCY = 8;

/** Where a run left off, per collection. */
export interface BackfillState {
  /** Collection name → the last `_id` committed. */
  readonly checkpoints: Record<string, Checkpoint>;
  /** Collections whose copy AND self-reference pass both finished. */
  readonly completed: readonly string[];
}

/** An empty state — what a first run starts from. */
export function emptyState(): BackfillState {
  return { checkpoints: {}, completed: [] };
}

/** What the discovery phase found. */
export interface Discovery {
  /** Live collections with a plan, and how many documents each holds. */
  readonly migrated: ReadonlyArray<{ plan: CollectionPlan; documents: number }>;
  /** Live collections deliberately excluded, with their document counts. */
  readonly excluded: ReadonlyArray<{ collection: string; reason: string; documents: number }>;
  /** Live collections in NEITHER list. Any entry here is a hard failure. */
  readonly unknown: readonly string[];
  /** Mapped collections that do not exist in the source at all. */
  readonly absent: readonly string[];
}

/** Raised when the source holds a collection the map has never heard of. */
export class UnknownCollectionError extends Error {
  constructor(readonly collections: readonly string[]) {
    super(
      `MongoDB holds ${collections.length} collection(s) that are neither mapped ` +
        `nor explicitly excluded: ${collections.join(', ')}. Every collection must ` +
        'be one or the other — add a plan in db/backfill/, or an entry in ' +
        'NOT_MIGRATED with the reason its data does not move. An unexplained ' +
        'collection is how data goes missing quietly.'
    );
    this.name = 'UnknownCollectionError';
  }
}

/** Raised when an audit found rows the schema would refuse. */
export class AuditBlockedError extends Error {
  constructor(readonly findings: readonly AuditFinding[]) {
    super(
      `${findings.length} audit finding(s) describe production rows the Postgres ` +
        'schema would REJECT. The copy is refused rather than started and aborted ' +
        'partway. Fix the data or widen the schema — both are decisions, which is ' +
        'why there is no override flag.\n\n' +
        findings
          .map(
            (finding) =>
              `  [${finding.kind}] ${finding.detail}\n` +
              `      ${finding.documents} document(s); e.g. ${
                finding.sampleIds.join(', ') || '(none sampled)'
              }`
          )
          .join('\n')
    );
    this.name = 'AuditBlockedError';
  }
}

/**
 * Compare the live collection list against the map.
 *
 * The `unknown` bucket is the point of this phase, and the census proved it:
 * eight collections holding real data — `hashtags` at 1,677 among them — were
 * invisible to a map derived from `src/models/` alone, because their models had
 * been deleted or lived elsewhere (`src/mcp/models/`). `db.listCollections()`
 * is the authority precisely because the code is not.
 */
export async function discover(source: MongoSource): Promise<Discovery> {
  const live = await source.listCollections();
  const migrated: Array<{ plan: CollectionPlan; documents: number }> = [];
  const excluded: Array<{ collection: string; reason: string; documents: number }> = [];
  const unknown: string[] = [];

  for (const collection of live) {
    // Mongo's own bookkeeping namespaces are not application data and are not a
    // migration decision. `system.*` is reserved by the server.
    if (collection.startsWith('system.')) continue;
    const classification = classifyCollection(collection);
    if (classification.kind === 'migrated') {
      migrated.push({ plan: classification.plan, documents: await source.count(collection) });
    } else if (classification.kind === 'excluded') {
      excluded.push({
        collection,
        reason: classification.exclusion.reason,
        documents: await source.count(collection),
      });
    } else {
      unknown.push(collection);
    }
  }

  const liveSet = new Set(live);
  const absent = [
    ...COLLECTION_PLANS.map((plan) => plan.collection),
    ...NOT_MIGRATED.map((entry) => entry.collection),
  ]
    .filter((name) => !liveSet.has(name))
    .sort();

  return { migrated, excluded, unknown, absent };
}

/**
 * Run every audit for every mapped, non-empty collection.
 *
 * `resolutions` is a required parameter rather than something this function
 * computes, so the audit phase and the copy phase provably share ONE set of
 * decisions — an `--audit-only` report would otherwise be able to disagree with
 * what the copy then does.
 *
 * The referential-integrity audit runs LAST and once, over everything. It is
 * also the expensive one: it streams every mapped collection and runs its
 * transform, so this phase costs roughly the read half of a copy rather than a
 * handful of index-assisted aggregations. That is deliberate — the run it
 * exists to prevent got three levels in before a `23503` stopped it.
 */
export async function runAudits(
  db: Database,
  source: MongoSource,
  discovery: Discovery,
  resolutions: ResolutionContext,
  options: { readonly batchSize?: number } = {}
): Promise<{ findings: AuditFinding[]; referentialIntegrity: ReferentialIntegrityReport }> {
  const findings: AuditFinding[] = [];

  for (const { plan, documents } of discovery.migrated) {
    // An empty collection has nothing to audit and `distinct` on one returns
    // `[]`, so skipping is not a shortcut that could hide anything.
    if (documents === 0) continue;
    // The context goes in so a rule named on an enum/numeric audit can be
    // VERIFIED against the documents it claims, rather than believed.
    findings.push(...(await auditEnums(source, plan, resolutions)));
    findings.push(...(await auditNumerics(source, plan, resolutions)));
    findings.push(...(await auditUniqueness(source, plan, resolutions)));
  }

  // ONE pass over EVERY mapped collection, empty ones included, and outside the
  // loop above on purpose: a foreign key is a relation between two collections,
  // so it cannot be answered one collection at a time. The complete set is
  // required — a referenced table fed by a plan that is not here holds no rows,
  // and healthy references to it would then read as orphans.
  //
  // LAST, and only when nothing else blocks: this pass runs the plans' own
  // transforms, and a transform THROWS on a document the schema refuses.
  // Running it over data an earlier audit already reported on would replace
  // that report with the first `BackfillValueError` — losing the enum value or
  // the colliding pair the operator has to act on. The copy is refused either
  // way; the report says NOT RUN rather than printing a clean answer.
  const blocked = findings.filter(auditWouldBlockCopy);

  // The defaulted-column pass runs the TRANSFORMS, so it carries the same
  // hazard as the referential pass below and sits behind the same guard: a
  // transform throws on a document an earlier audit already reported, and
  // running it first would replace that report with a `BackfillValueError`.
  //
  // It costs one more full read of every mapped collection. That is stated
  // rather than hidden — it could be folded into the referential audit's first
  // phase, which already streams and runs each transform, and the reason it is
  // not is that a separate function is the one that can be exercised on its own.
  if (blocked.length === 0) {
    for (const { plan, documents } of discovery.migrated) {
      if (documents === 0) continue;
      findings.push(
        ...(await auditDefaultedColumns(source, plan, resolutions, {
          batchSize: options.batchSize,
        }))
      );
      // Same guard, same hazard, and the question the other passes cannot ask:
      // they count ROWS per document, this one counts COLUMNS per row. A
      // rehearsal of 4,986,482 rows reported `transform fidelity 58/58` and
      // `FK coverage 47/47` while dropping eleven columns that hold real
      // values, because both numbers were true and neither was about columns.
      findings.push(
        ...(await auditColumnCoverageForPlan(source, plan, resolutions, {
          batchSize: options.batchSize,
        }))
      );
    }
  }

  const stillBlocked = findings.filter(auditWouldBlockCopy);
  const referentialIntegrity =
    stillBlocked.length > 0
      ? referentialIntegrityNotRun(
          `${stillBlocked.length} earlier finding(s) already block the copy, and this ` +
            'pass runs the transforms — which refuse exactly those documents. ' +
            'Fix them and re-run: referential integrity is UNKNOWN, not clean.'
        )
      : await auditReferentialIntegrity(db, source, discovery.migrated, resolutions, {
          batchSize: options.batchSize,
        });
  findings.push(...referentialIntegrity.findings);

  return { findings, referentialIntegrity };
}

/** Per-collection copy result. */
export interface CopyResult {
  readonly collection: string;
  readonly documentsRead: number;
  readonly rowsByTable: Record<string, number>;
  readonly selfReferencesFilled: number;
  /**
   * Wall-clock for this collection, so the report quotes a MEASURED rate rather
   * than an estimate. Set by `runBackfill`; `copyCollection` on its own reports
   * 0 because it does not own the clock.
   */
  readonly elapsedMs: number;
}

/** Everything a run needs, so the runner itself opens no connections. */
export interface RunnerOptions {
  readonly db: Database;
  readonly source: MongoSource;
  readonly batchSize?: number;
  readonly concurrency?: number;
  /**
   * The documented decisions, and the log they report through.
   *
   * `runBackfill` builds ONE for the whole run so the report counts each
   * degraded document once.
   */
  readonly resolutions?: ResolutionContext;
  /**
   * The parent rows the documented resolutions decide against.
   *
   * Read from POSTGRES at the start of the LEVEL rather than per collection, so
   * one read serves every collection in it — and so the set is taken at a
   * single, nameable instant rather than drifting between neighbours.
   */
  readonly parents?: ParentKeys;
  /** Called after each committed batch, so a caller can persist the checkpoint. */
  readonly onCheckpoint?: (
    collection: string,
    checkpoint: Checkpoint,
    documentsCopied: number
  ) => Promise<void> | void;
  /** Called once a collection's copy AND self-reference pass both finished. */
  readonly onCompleted?: (collection: string) => Promise<void> | void;
  /**
   * Called after each LEVEL with the resolution records not yet made durable,
   * so the audit trail survives a run that dies.
   *
   * Per level rather than per batch because a level is the unit whose rows are
   * all committed — inside one, several collections are copying concurrently
   * and a drain would race their transforms.
   */
  readonly onResolutions?: (
    summaries: readonly ResolutionSummary[]
  ) => Promise<void> | void;
  /** Progress reporting. Never the place for data. */
  readonly onProgress?: (message: string) => void;
}

/**
 * The tables one plan writes, ordered so a parent is inserted before its
 * children.
 *
 * Within a plan the graph is trivially a tree, but it is derived rather than
 * assumed so a child that gains a reference to another child is ordered
 * correctly without anyone remembering to reorder a literal.
 */
export function orderPlanTables(plan: CollectionPlan): PgTable[] {
  const tables = planTables(plan);
  const names = new Set(tables.map(tableName));
  const ordered: PgTable[] = [];
  const placed = new Set<string>();

  let progressed = true;
  while (ordered.length < tables.length && progressed) {
    progressed = false;
    for (const table of tables) {
      const name = tableName(table);
      if (placed.has(name)) continue;
      const config = getTableConfig(table);
      const blocked = config.foreignKeys.some((foreignKey) => {
        const target = foreignKey.reference().foreignTable;
        if (!is(target, PgTable)) return false;
        const targetName = getTableConfig(target).name;
        return targetName !== name && names.has(targetName) && !placed.has(targetName);
      });
      if (blocked) continue;
      ordered.push(table);
      placed.add(name);
      progressed = true;
    }
  }
  // A cycle among a plan's own tables would be a schema bug, not a data one;
  // appending the remainder keeps the copy honest rather than dropping rows.
  for (const table of tables) if (!placed.has(tableName(table))) ordered.push(table);
  return ordered;
}

/**
 * Copy one collection.
 *
 * Pass A streams, transforms and inserts in batches. Pass B fills in the
 * deferred self-referencing columns, and only runs for a plan whose tables have
 * any.
 */
export async function copyCollection(
  plan: CollectionPlan,
  options: RunnerOptions,
  resumeFrom?: Checkpoint
): Promise<CopyResult> {
  const { db, source } = options;
  const client = getPostgresClient();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const resolutions =
    options.resolutions ??
    createResolutionContext(await planResolutions(source), new ResolutionLog());
  const tables = orderPlanTables(plan);
  const deferredByTable = new Map<string, readonly string[]>();
  for (const table of tables) {
    const columns = selfReferencingColumns(table);
    if (columns.length > 0) deferredByTable.set(tableName(table), columns);
  }

  // A SELF-REFERENCING table decides against what this copy will PRODUCE, not
  // against what Postgres holds right now.
  //
  // `runBackfill` loads a level's parent set before any row of the level is
  // built — right for every other table, and empty for one that references
  // itself. That emptiness is the "loaded and empty" answer, so every orphan
  // rule stood down for the whole posts copy and the deferred self-reference
  // pass then wrote the orphan value for real and hit the foreign key. The set
  // that matters is what the constraint will hold when the level ENDS.
  //
  // `scanEmittedRows` is the referential audit's own phase 1, called here so
  // the copy and the audit share ONE definition of "the rows the migration
  // produces". Two implementations that agree today is how a green audit stops
  // predicting a successful cutover.
  const parents = deferredByTable.size === 0
    ? options.parents ?? (await loadParentKeys(db, parentTablesForRules()))
    : await (async () => {
        const ruleTables = parentTablesForRules();
        const loaded = await loadParentKeyMap(db, ruleTables);
        const fed = new Set(ruleTables.map((table) => tableName(table)));
        const scan = await scanEmittedRows(source, [{ plan }], resolutions, fed, batchSize);
        for (const [name, keys] of scan.emittedKeys) {
          const existing = loaded.get(name);
          if (existing) for (const key of keys) existing.add(key);
          else loaded.set(name, new Set(keys));
        }
        return parentKeysFrom(loaded);
      })();

  const rowsByTable: Record<string, number> = {};
  for (const table of tables) rowsByTable[tableName(table)] = 0;
  let documentsRead = 0;

  for await (const documents of streamCollection(source, plan.collection, batchSize, resumeFrom)) {
    const collected = new Map<string, { table: PgTable; rows: Record<string, unknown>[] }>();
    for (const table of tables) collected.set(tableName(table), { table, rows: [] });

    for (const doc of documents) {
      transformDocument(plan, doc, resolutions, parents, (emitted) => {
        const name = tableName(emitted.table);
        const bucket = collected.get(name);
        if (!bucket) {
          throw new Error(
            `Plan for ${plan.collection} emitted a row for ${name}, which it does ` +
              'not declare in `table`/`childTables`. Declare it: the verifier uses ' +
              'that declaration to tell "empty because nothing fed it" from ' +
              '"empty because the copy produced nothing".'
          );
        }
        // `written` is null for a row a documented rule removes — the audit has
        // already reported it by id under that rule, and the audit is what let
        // this run start at all.
        if (emitted.written === null) return;
        const deferred = deferredByTable.get(name);
        bucket.rows.push(deferred ? withoutDeferred(emitted.written, deferred) : emitted.written);
      });
    }
    documentsRead += documents.length;

    // Tables in FK order, each loaded with COPY → staging → INSERT … SELECT …
    // ON CONFLICT DO NOTHING. NOT wrapped in one transaction across tables: the
    // order already guarantees a parent lands before its child, and a
    // batch-wide transaction would hold every table's locks for the whole batch
    // while buying nothing — the copy is idempotent, so a partial batch is
    // re-done rather than rolled back.
    for (const table of tables) {
      const bucket = collected.get(tableName(table));
      if (!bucket || bucket.rows.length === 0) continue;
      rowsByTable[tableName(table)] += await copyRowsInto(client, table, bucket.rows);
    }

    // AFTER the batch is committed, never before: a checkpoint written first
    // would let a resume skip documents the copy never actually wrote.
    const last = documents[documents.length - 1];
    if (last !== undefined && options.onCheckpoint) {
      await options.onCheckpoint(plan.collection, checkpointOf(last), documentsRead);
    }
  }

  const selfReferencesFilled =
    deferredByTable.size === 0
      ? 0
      : await fillSelfReferences(plan, options, tables, deferredByTable, resolutions, parents);

  return { collection: plan.collection, documentsRead, rowsByTable, selfReferencesFilled, elapsedMs: 0 };
}

/** A copy of `row` with the deferred columns removed, so they insert as NULL. */
function withoutDeferred(
  row: Record<string, unknown>,
  deferred: readonly string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (deferred.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Pass B: re-stream the collection and fill in the deferred self-references.
 *
 * Only rows that actually HAVE a self-reference are updated, so the write
 * volume is the number of replies rather than the post count. A row whose every
 * deferred column is null needs no statement at all, which is why this is
 * affordable as a second pass over 573,339 documents.
 *
 * It re-runs the transform, so it takes the SAME resolutions pass A used — both
 * because a re-decided resolution could write a different value here, and
 * because {@link ResolutionLog} keys on `(rule, document, within)` so this
 * second run over the same documents cannot double-count what the report says
 * was changed.
 */
async function fillSelfReferences(
  plan: CollectionPlan,
  options: RunnerOptions,
  tables: readonly PgTable[],
  deferredByTable: ReadonlyMap<string, readonly string[]>,
  resolutions: ResolutionContext,
  parents: ParentKeys
): Promise<number> {
  const { db, source } = options;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const tableByName = new Map(tables.map((table) => [tableName(table), table]));
  let filled = 0;

  for await (const documents of streamCollection(source, plan.collection, batchSize)) {
    const updates: Array<{ table: PgTable; id: string; values: Record<string, unknown> }> = [];

    for (const doc of documents) {
      transformDocument(plan, doc, resolutions, parents, (emitted) => {
        const table = emitted.table;
        const name = tableName(table);
        const deferred = deferredByTable.get(name);
        if (!deferred) return;
        // A row the copy never inserted has nothing to fill in.
        const row = emitted.written;
        if (row === null) return;
        const values: Record<string, unknown> = {};
        for (const column of deferred) {
          const value = row[column];
          if (value === null || value === undefined) continue;
          values[column] = value;
        }
        if (Object.keys(values).length === 0) return;

        // Re-assert every `$onUpdate` column from the SOURCE row.
        //
        // Drizzle applies `$onUpdate` to any `db.update(...)`, so this pass —
        // which exists only to fill in a foreign key — would stamp
        // `updated_at = now()` onto the row and destroy the historical value.
        // `schema/CONVENTIONS.md` names that exact hazard as the reason
        // `updated_at` is maintained by the application and NOT by a trigger:
        // a trigger would fire during backfill and overwrite the very value the
        // migration exists to preserve.
        for (const [property, column] of Object.entries(getTableColumns(table))) {
          if (typeof column.onUpdateFn !== 'function') continue;
          const original = row[property];
          if (original === undefined) continue;
          values[property] = original;
        }

        const rowId = row.id;
        if (typeof rowId !== 'string') {
          throw new Error(
            `${name} has self-referencing columns (${deferred.join(', ')}) but the ` +
              'emitted row carries no string `id`, so the deferred update cannot be ' +
              'keyed.'
          );
        }
        const resolved = tableByName.get(name);
        if (resolved) updates.push({ table: resolved, id: rowId, values });
      });
    }

    if (updates.length === 0) continue;
    await db.transaction(async (tx) => {
      for (const update of updates) {
        const idColumn = idColumnOf(update.table);
        await tx.update(update.table).set(update.values).where(eq(idColumn, update.id));
      }
    });
    filled += updates.length;
  }

  return filled;
}

/**
 * The `id` column of a table, for keying a deferred update.
 *
 * Reached through `getTableColumns` from `drizzle-orm` rather than
 * `getTableConfig(...).columns` from `drizzle-orm/pg-core`, and the distinction
 * is not cosmetic: the two subpaths can declare structurally incompatible
 * versions of `PgColumn`, so a column obtained from `pg-core` is not assignable
 * to `eq`, which comes from the package root. Taking both from the root keeps
 * them the same type.
 */
function idColumnOf(table: PgTable): ReturnType<typeof getTableColumns>[string] {
  const column = getTableColumns(table).id;
  if (!column) {
    throw new Error(`${tableName(table)} has no \`id\` column to key a deferred update on`);
  }
  return column;
}

/** The whole run: discover, audit, copy in FK order. */
export interface RunSummary {
  readonly discovery: Discovery;
  readonly findings: readonly AuditFinding[];
  /**
   * What the referential-integrity audit inspected, orphans or not.
   *
   * Carried whole rather than folded into `findings` alone, because the COUNTS
   * are the evidence that the check ran: `0 orphans` means something only next
   * to the number of relations, documents and references it looked at.
   */
  readonly referentialIntegrity: ReferentialIntegrityReport;
  readonly copies: readonly CopyResult[];
  /** What the documented resolutions were GOING to do, decided before the copy. */
  readonly resolutionPlan: ResolutionPlan;
  /** What the documented resolutions ACTUALLY did, per rule, with the ids. */
  readonly resolutions: readonly ResolutionSummary[];
  /**
   * The records `onResolutions` was NOT handed — everything decided after the
   * last level, which the caller still owes the durable log.
   *
   * Separate from {@link resolutions} because they answer different questions:
   * that one is the whole run for the REPORT, this one is the remainder for the
   * WRITER. Handing the writer the whole summary after the levels already took
   * most of it would double every row.
   */
  readonly undrainedResolutions: readonly ResolutionSummary[];
}

/**
 * Run the backfill.
 *
 * @param options Database and source handles, plus batching/checkpoint hooks.
 * @param state Where a previous run left off.
 * @param only Restrict the copy to these collections. The discovery and audit
 *   phases still cover EVERYTHING, because a restricted copy must not narrow
 *   the check that nothing is unaccounted for.
 */
export async function runBackfill(
  options: RunnerOptions,
  state: BackfillState = emptyState(),
  only?: readonly string[]
): Promise<RunSummary> {
  const report = options.onProgress ?? (() => undefined);
  const discovery = await discover(options.source);

  if (discovery.unknown.length > 0) throw new UnknownCollectionError(discovery.unknown);

  // ONE pre-pass and ONE log for the whole run: the audit phase and the copy
  // phase then share the same decisions by construction, and each degraded
  // document is counted once no matter how many times its transform re-runs.
  const resolutionLog = new ResolutionLog();
  const resolutionPlan = await planResolutions(options.source);
  const resolutions = createResolutionContext(resolutionPlan, resolutionLog);

  const { findings, referentialIntegrity } = await runAudits(
    options.db,
    options.source,
    discovery,
    resolutions,
    { batchSize: options.batchSize }
  );
  const blocking = findings.filter(auditWouldBlockCopy);
  if (blocking.length > 0) throw new AuditBlockedError(blocking);

  const selected = discovery.migrated
    .map((entry) => entry.plan)
    .filter((plan) => only === undefined || only.includes(plan.collection));

  // LEVELS, not a flat order: within a level no plan depends on another, so
  // they run concurrently; between levels the parents-before-children rule is
  // absolute. 47 of this schema's 73 tables have no foreign key at all, so the
  // levels are wide and this is where the wall-clock is won.
  const levels = planLevels(selected);
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const copies: CopyResult[] = [];

  // The topological order is the whole reason reading Postgres is exact, so it
  // is checked rather than assumed — against the same derivation the copy uses.
  assertParentsPrecedeChildren(selected);

  for (const [index, level] of levels.entries()) {
    const pending = level.filter((plan) => {
      if (!state.completed.includes(plan.collection)) return true;
      report(`${plan.collection}: already completed, skipping`);
      return false;
    });
    if (pending.length === 0) continue;

    report(
      `level ${index + 1}/${levels.length}: ${pending.length} collection(s), ` +
        `up to ${concurrency} at a time`
    );

    // ONE read of the parent tables per level, taken now — after every earlier
    // level committed and before any row of this one is built. That instant is
    // what makes the documented resolutions exact: the set they decide against
    // is the set the foreign key will check, not a snapshot of a source that is
    // still taking writes.
    const parents = await loadParentKeys(options.db, parentTablesForRules());

    // A simple worker pool over the level's queue, bounded because the Postgres
    // pool is bounded and a COPY holds a connection for its whole stream.
    const queue = [...pending];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let plan = queue.shift(); plan !== undefined; plan = queue.shift()) {
        const startedAt = Date.now();
        report(`${plan.collection}: copying`);
        const result = await copyCollection(
          plan,
          { ...options, resolutions, parents },
          state.checkpoints[plan.collection]
        );
        copies.push({ ...result, elapsedMs: Date.now() - startedAt });
        // Marked complete only after BOTH passes returned. A collection whose
        // second pass died must not be skipped on the next run just because its
        // first pass reached the end.
        if (options.onCompleted) await options.onCompleted(plan.collection);
      }
    });
    await Promise.all(workers);

    // The level's rows are committed, so the record of what the rules DID to
    // them is made durable now rather than after the whole copy returns. A run
    // that dies at level 4 of 6 then still has levels 1–3 written down; the
    // previous shape wrote the trail once at the end, so a 26-minute failure
    // that resolved hundreds of rows recorded none of them.
    if (options.onResolutions) await options.onResolutions(resolutionLog.drain());
  }

  // Statistics describe an empty table until this runs, so the first queries
  // after cutover would plan against `n_distinct` values that are simply wrong.
  const touched = new Set<string>();
  for (const plan of selected) for (const table of planTables(plan)) touched.add(tableName(table));
  await analyzeTables(getPostgresClient(), [...touched]);

  return {
    discovery,
    findings,
    referentialIntegrity,
    copies,
    resolutionPlan,
    resolutions: resolutionLog.summary(),
    // Drained LAST, after the levels have taken theirs, so a caller can write
    // the remainder without writing every record a second time. The
    // self-reference pass and the deferred writes land after the final level,
    // so this is not always empty.
    undrainedResolutions: resolutionLog.drain(),
  };
}
