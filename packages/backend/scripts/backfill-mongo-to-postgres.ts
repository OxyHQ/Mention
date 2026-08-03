/**
 * One-shot MongoDB → PostgreSQL backfill.
 *
 * Runs as an ECS Fargate one-shot inside the VPC, because production Mongo and
 * the Postgres instance are both unreachable from a laptop:
 *
 * ```bash
 * aws --profile oxy --region us-west-2 ecs run-task \
 *   --cluster oxy-cluster --task-definition oxy-mention --launch-type FARGATE \
 *   --network-configuration 'awsvpcConfiguration={subnets=[…],securityGroups=[…],assignPublicIp=ENABLED}' \
 *   --overrides '{"containerOverrides":[{"name":"mention","command":[
 *      "bun","run","packages/backend/scripts/backfill-mongo-to-postgres.ts",
 *      "--target-database=mention_audit_probe","--audit-only"]}]}'
 * ```
 *
 * ## `--target-database` is REQUIRED, on every mode
 *
 * The database this writes to is decided entirely by the `DATABASE_URL` secret,
 * which is a line of JSON on a task definition. `--target-database=<name>` is
 * the operator saying where they believe that points, and the run refuses
 * unless `current_database()` agrees — so a stale, wrong-environment or
 * recreated-under-another-name URL fails closed instead of succeeding quietly.
 * `--start-from-empty` additionally requires `--confirm-truncate=<name>`.
 * See `db/backfill/targetDatabase.ts`.
 *
 * ## The phases, and why they are separable
 *
 * | flag | phases |
 * |---|---|
 * | `--audit-only` | discover + audit. Writes no application row. Run this FIRST. |
 * | (default) | discover + audit + copy |
 * | `--verify` | …and verify afterwards |
 * | `--verify-only` | verify an already-copied database |
 *
 * `--audit-only` exists because the audits are the phase whose OUTPUT is a
 * DECISION: an enum value the CHECK refuses, two rows that collide under an
 * index Mongo never had, or a row naming a parent that does not exist, has to
 * be resolved by a human before a copy is worth starting. Discovering that
 * partway through a multi-hundred-thousand-document run is the outcome this
 * separation prevents — the operator would then be choosing between aborting a
 * half-migrated database and hand-patching data under time pressure.
 *
 * `--audit-only` is NOT cheap. The referential-integrity pass streams every
 * mapped collection and runs its transform, so it costs roughly the read half
 * of a copy. `--batch-size` applies to it.
 *
 * ## Where the audit runs, and why that differs by mode
 *
 * `runBackfill` audits internally and REFUSES to copy when anything blocks, so
 * a plain copy needs no pre-pass here — this script prints the findings out of
 * the summary it returns. The two modes that DO pre-audit are the two where the
 * verdict is load-bearing before any work happens:
 *
 * - `--audit-only`, where the audit is the entire job, and
 * - `--start-from-empty`, where the target is TRUNCATED first. Emptying the
 *   target and only then discovering that the copy is refused would leave less
 *   than there was before, so the verdict has to exist before the truncate.
 *   That run pays for the referential pass twice, and that is the correct
 *   trade: the alternative is destroying rows on a guess.
 *
 * ## What an interrupted run leaves behind — read this before hand-repairing
 *
 * A document that produces rows in several tables is **not** written
 * atomically. `copyCollection` loads one table at a time (COPY → staging →
 * `INSERT … ON CONFLICT DO NOTHING`) and deliberately does NOT wrap the batch
 * in one transaction: the FK order already guarantees a parent lands before its
 * child, and a batch-wide transaction would hold every table's locks for the
 * whole batch while buying nothing. So a crash midway through a batch can leave
 * a `custom_feeds` row with its definition modules and no members, or a `posts`
 * row with media and no mentions, ON DISK.
 *
 * **That partial state cannot survive a resume, and no checkpoint needs
 * repairing by hand.** The checkpoint is written only AFTER every table in the
 * batch is loaded, so an interrupted batch never advanced it; the resume
 * re-reads from the last COMPLETED batch's `_id` and re-emits every row of
 * every document in the interrupted one. The rows that already landed become
 * no-ops and the missing ones are written.
 *
 * What actually carries that convergence is worth stating precisely, because
 * the obvious answer is wrong. The loader's `ON CONFLICT DO NOTHING` names **no
 * conflict target**, so it fires on ANY unique constraint — and every child
 * table in this schema has a NATURAL unique key (`(post_id, position)`,
 * `(feed_id, oxy_user_id)`, `(preference_id, key)`, …). Those keys are what
 * make the re-emitted rows no-ops, and they would do so even if the ids were
 * random. Measured, not reasoned: making `childRowId` non-deterministic leaves
 * the convergence test green.
 *
 * The derived id's determinism is therefore the SECOND line, not the first —
 * and it is the only line for any future child table added without a natural
 * unique key, where a random id would turn a partial batch into a duplicated
 * one with `ON CONFLICT DO NOTHING` reporting success either way. That is why
 * `src/__tests__/db/backfillChildKeys.test.ts` asserts every child table has
 * one rather than leaving it to whoever adds the next.
 *
 * The transient partial is acceptable because nothing reads Postgres during the
 * cutover copy. If that ever stops being true, this is the paragraph to revisit.
 *
 * ## Safety
 *
 * - MongoDB access is read-only BY CONSTRUCTION (`mongoSource.ts` hands out a
 *   Proxy that throws on anything but a read).
 * - Every insert is `ON CONFLICT DO NOTHING`, so an interrupted run resumes.
 *   That is idempotence, NOT convergence — see `db/backfill/reset.ts`; a fresh
 *   run into a non-empty target is refused rather than mixed, because filling
 *   gaps without refreshing rows would leave one table holding two points in
 *   time.
 * - Checkpoints live in Postgres (`mention_backfill_checkpoints`), so a resumed
 *   run needs no file to have survived the task that wrote it.
 * - Neither bookkeeping table is created here. Both come from migration
 *   `0016_backfill_bookkeeping_tables` and are VERIFIED before anything is read,
 *   so this tool never needs `CREATE` on the target schema — see
 *   `db/backfill/bookkeepingTables.ts`. `--audit-only` does write the resolution
 *   log (that is the whole point of a durable audit trail), which is why the
 *   check is unconditional rather than copy-only.
 */

import { closePostgres, connectPostgres, type Database } from '../src/db/postgres';
import { auditWouldBlockCopy, type AuditFinding } from '../src/db/backfill/audit';
import {
  COLLECTION_PLANS,
  knownCollections,
  NOT_MIGRATED,
  tablesWithoutAPlan,
} from '../src/db/backfill/collectionMap';
import { assertBookkeepingTableExists } from '../src/db/backfill/bookkeepingTables';
import {
  assertTargetDatabase,
  assertTargetDeclared,
} from '../src/db/backfill/targetDatabase';
import {
  CHECKPOINT_TABLE,
  clearState,
  loadState,
  markCompleted,
  saveCheckpoint,
} from '../src/db/backfill/checkpointStore';
import { connectMongoSource, redactUri, type MongoSource } from '../src/db/backfill/mongoSource';
import { randomUUID } from 'node:crypto';
import { loadParentKeys } from '../src/db/backfill/parentKeys';
import {
  RESOLUTION_LOG_TABLE,
  writeResolutionLog,
} from '../src/db/backfill/resolutionLogStore';
import { planTables, tableName } from '../src/db/backfill/plan';
import {
  describeRelationColumns,
  droppedDocuments,
  emissionIsFaithful,
  orphanResolvability,
  VacuousReferentialIntegrityError,
  type ReferentialIntegrityReport,
} from '../src/db/backfill/referentialIntegrity';
import {
  createResolutionContext,
  parentTablesForRules,
  planResolutions,
  ResolutionLog,
  type ResolutionSummary,
} from '../src/db/backfill/resolutions';
import {
  assertResetIsAllowed,
  assertTargetsEmpty,
  populatedTables,
  ResetNotAllowedError,
  startFromEmpty,
  targetTables,
  TargetNotEmptyError,
} from '../src/db/backfill/reset';
import {
  AuditBlockedError,
  DEFAULT_BATCH_SIZE,
  DEFAULT_CONCURRENCY,
  discover,
  runAudits,
  runBackfill,
  UnknownCollectionError,
  type Discovery,
} from '../src/db/backfill/runner';
import {
  DEFAULT_FIDELITY_SAMPLE,
  VacuousVerificationError,
  verificationPassed,
  verifyBackfill,
} from '../src/db/backfill/verify';

interface Options {
  readonly auditOnly: boolean;
  readonly verify: boolean;
  readonly verifyOnly: boolean;
  /** Forget every checkpoint and copy from the beginning. */
  readonly restart: boolean;
  /**
   * DESTRUCTIVE: empty every table the plans write before copying.
   *
   * The only flag on this tool that removes anything. `ON CONFLICT DO NOTHING`
   * makes a re-run safe but not CONVERGENT, so a copy over a partly-populated
   * target is a mixture of two points in time with nothing marking which row is
   * which — see `db/backfill/reset.ts`.
   */
  readonly startFromEmpty: boolean;
  /**
   * The database this run believes it is pointed at. REQUIRED.
   *
   * Checked against `current_database()` before anything is read or written —
   * see `db/backfill/targetDatabase.ts` for why an affirmative rather than a
   * denylist.
   */
  readonly targetDatabase: string | undefined;
  /** Must repeat `targetDatabase` to arm `--start-from-empty`. */
  readonly confirmTruncate: string | undefined;
  readonly batchSize: number;
  readonly concurrency: number;
  readonly only: readonly string[] | undefined;
  readonly sample: number;
}

function parseOptions(argv: readonly string[]): Options {
  const flag = (name: string): boolean => argv.includes(`--${name}`);
  const value = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const found = argv.find((arg) => arg.startsWith(prefix));
    return found?.slice(prefix.length);
  };
  const numeric = (name: string, fallback: number): number => {
    const raw = value(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`--${name} must be a positive integer, got ${JSON.stringify(raw)}`);
    }
    return parsed;
  };
  const only = value('only');
  return {
    auditOnly: flag('audit-only'),
    verify: flag('verify'),
    verifyOnly: flag('verify-only'),
    restart: flag('restart'),
    startFromEmpty: flag('start-from-empty'),
    targetDatabase: value('target-database'),
    confirmTruncate: value('confirm-truncate'),
    batchSize: numeric('batch-size', DEFAULT_BATCH_SIZE),
    concurrency: numeric('concurrency', DEFAULT_CONCURRENCY),
    only: only === undefined ? undefined : only.split(',').map((entry) => entry.trim()),
    sample: numeric('sample-size', DEFAULT_FIDELITY_SAMPLE),
  };
}

/**
 * One id for this process, so a re-run, a resumed run and the cutover are
 * separable rows rather than one undifferentiated pile.
 *
 * Time-ordered on purpose: the id sorts the way the runs happened, which is how
 * anyone reads them back.
 */
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;

function say(message: string): void {
  process.stdout.write(`${message}\n`);
}

function heading(title: string): void {
  say(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));

  // `--audit-only` and `--verify-only` touch nothing BY CONTRACT, and the whole
  // value of that contract is that it holds without reading the code. The
  // refusal lives in `reset.ts` so it is one checkable function rather than a
  // condition here that someone later re-reads and simplifies.
  assertResetIsAllowed(options);

  // WHERE this run believes it is pointed, stated by the operator and checked
  // against the connection below. Argument-only, so a mistyped flag is refused
  // before a socket is opened rather than after two handshakes.
  const targetDatabase = assertTargetDeclared(options);

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('MONGODB_URI is not set — it names the SOURCE database');
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set — it names the TARGET database');
  }

  say(`Source (MongoDB):  ${redactUri(mongoUri)}`);
  say(`Target (Postgres): ${redactUri(process.env.DATABASE_URL)}`);
  say(`Batch size: ${options.batchSize}, concurrency: ${options.concurrency}`);

  // Checked BEFORE either connection, because it is a property of the CODE and
  // an operator should learn that the map is incomplete without waiting for two
  // handshakes. A table with no plan is a table the cutover leaves empty, and
  // nothing downstream would say so.
  const orphanTables = tablesWithoutAPlan();
  if (orphanTables.length > 0) {
    throw new Error(
      `${orphanTables.length} of the schema's tables have no plan feeding them: ` +
        `${orphanTables.join(', ')}. Every table must have a source or be a ` +
        'deliberate post-cutover-only table — and there is currently no member ' +
        'of that second class, so this is a gap, not a configuration. The ' +
        'cutover cannot start until it is closed.'
    );
  }
  say(
    `Map: ${COLLECTION_PLANS.length} collection(s) migrated, ` +
      `${NOT_MIGRATED.length} excluded, ${knownCollections().length} known in total.`
  );

  const db = await connectPostgres();
  const source = await connectMongoSource(mongoUri);

  try {
    // The FIRST thing done with the connection, before a document is read or a
    // table is touched: is this the database the operator named? Everything
    // else in this file assumes the answer is yes.
    await assertTargetDatabase(db, targetDatabase);

    // Both bookkeeping tables, checked HERE rather than where they are first
    // written. The checkpoint table is touched at the START of the copy and the
    // resolution log at the very END of it, so leaving each to its own writer
    // means a target missing the second one absorbs the whole run before saying
    // so — hours of reading, and then no audit trail of what the rules did.
    // They come from ONE migration, so they are one precondition and belong
    // together, before anything is read. Inside the `try` so the throw still
    // closes both connections: a one-shot that leaks the Mongo socket never
    // exits, and a Fargate task that never exits has to be killed by hand.
    await assertBookkeepingTableExists(db, CHECKPOINT_TABLE);
    await assertBookkeepingTableExists(db, RESOLUTION_LOG_TABLE);

    if (options.verifyOnly) {
      return await runVerification(db, source, options);
    }

    // ---- discover ---------------------------------------------------------
    heading('DISCOVERY');
    const discovery = await discover(source);
    reportDiscovery(discovery);
    if (discovery.unknown.length > 0) throw new UnknownCollectionError(discovery.unknown);

    // ---- audit (pre-pass) -------------------------------------------------
    if (options.auditOnly || options.startFromEmpty) {
      const blocking = await runPreAudit(db, source, discovery, options);
      if (options.auditOnly) {
        heading(blocking === 0 ? 'AUDIT CLEAN' : 'AUDIT FOUND BLOCKING ROWS');
        return blocking === 0 ? 0 : 1;
      }
      if (blocking > 0) {
        heading('REFUSED');
        say(
          `  --start-from-empty was requested, but ${blocking} finding(s) BLOCK ` +
            'the copy. Nothing was destroyed: emptying the target and then ' +
            'refusing to fill it would leave less than there is now.'
        );
        return 1;
      }
    }

    // ---- reset (destructive, and only when asked) -------------------------
    //
    // AFTER the audit on purpose. A blocking finding must leave the target
    // exactly as it was.
    if (options.startFromEmpty) {
      await emptyTheTarget(db, options.only);
    } else if (options.restart) {
      // A restart re-copies from the beginning, so it is a FRESH run and gets
      // the same emptiness requirement one would: `ON CONFLICT DO NOTHING` over
      // rows an earlier attempt wrote would leave them frozen at whatever the
      // source said then.
      await clearState(db);
      say('  Checkpoints cleared — this run starts from the beginning.');
    }

    // ---- copy -------------------------------------------------------------
    heading('COPY');
    const state = options.startFromEmpty ? await loadState(db) : await resumeState(db, options);
    const summary = await runBackfill(
      {
        db,
        source,
        batchSize: options.batchSize,
        concurrency: options.concurrency,
        onProgress: (message) => say(`  ${message}`),
        onCheckpoint: (collection, checkpoint, documentsCopied) =>
          saveCheckpoint(db, collection, checkpoint, documentsCopied),
        onCompleted: (collection) => markCompleted(db, collection),
      },
      state,
      options.only
    );

    heading('COPY RESULT');
    let totalRows = 0;
    for (const copy of summary.copies) {
      const seconds = copy.elapsedMs / 1000;
      say(
        `  ${copy.collection}: ${copy.documentsRead} document(s) read in ` +
          `${seconds.toFixed(1)}s`
      );
      for (const [table, rows] of Object.entries(copy.rowsByTable)) {
        say(`      → ${table.padEnd(40)} ${rows} row(s)`);
        totalRows += rows;
      }
      if (copy.selfReferencesFilled > 0) {
        say(`      → self-references filled: ${copy.selfReferencesFilled}`);
      }
    }
    say(`\n  ${totalRows} row(s) written across ${summary.copies.length} collection(s).`);

    // The audit ran INSIDE `runBackfill` on this path, so its findings and its
    // referential report are reported from the summary rather than re-computed
    // — re-running the referential pass to print it would cost the read half of
    // a copy for a number already in hand.
    reportFindings(summary.findings);
    reportReferentialIntegrity(summary.referentialIntegrity);
    reportResolutionsApplied(summary.resolutions, 'RESOLUTIONS APPLIED');
    await persistResolutionLog(db, summary.resolutions);

    if (options.verify) return await runVerification(db, source, options);
    return 0;
  } catch (error) {
    if (
      error instanceof UnknownCollectionError ||
      error instanceof AuditBlockedError ||
      error instanceof TargetNotEmptyError ||
      error instanceof ResetNotAllowedError
    ) {
      heading('REFUSED');
      say(error.message);
      return 1;
    }
    // A vacuous referential pass is not a data problem and not a clean run — it
    // says the audit itself did not work, which must never read as "no orphans".
    if (error instanceof VacuousReferentialIntegrityError) {
      heading('AUDIT DID NOT RUN');
      say(error.message);
      return 1;
    }
    throw error;
  } finally {
    await source.close();
    await closePostgres();
  }
}

/**
 * The resume position, refusing a FRESH run whose targets already hold rows.
 *
 * The two supported starts are "resume what this run already wrote" and "start
 * from empty". A run with no checkpoints is neither of those when the target is
 * populated, and `assertTargetsEmpty` is what says so rather than letting
 * `ON CONFLICT DO NOTHING` quietly produce a table holding two points in time.
 */
async function resumeState(db: Database, options: Options): Promise<Awaited<ReturnType<typeof loadState>>> {
  const state = await loadState(db);
  const resuming = Object.keys(state.checkpoints).length > 0 || state.completed.length > 0;
  if (resuming) {
    say(
      `  Resuming: ${state.completed.length} collection(s) already complete, ` +
        `${Object.keys(state.checkpoints).length} with a saved position.`
    );
    return state;
  }
  // `--only` narrows the COPY, so it narrows what "already holds rows" may
  // legitimately mean: a table this run will not write is not this run's
  // business. Every other table is.
  const tables =
    options.only === undefined
      ? targetTables()
      : targetTables().filter((table) => tablesFor(options.only ?? []).has(table));
  await assertTargetsEmpty(db, tables);
  return state;
}

/** The tables the named collections' plans write to. */
function tablesFor(collections: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const plan of COLLECTION_PLANS) {
    if (!collections.includes(plan.collection)) continue;
    for (const table of planTables(plan)) names.add(tableName(table));
  }
  return names;
}

/**
 * Run the audit as a pre-pass and print it. Returns how many findings BLOCK.
 *
 * Only the two modes that need a verdict before any work call this — see the
 * file header for why a plain copy does not.
 */
async function runPreAudit(
  db: Database,
  source: MongoSource,
  discovery: Discovery,
  options: Options
): Promise<number> {
  // The resolution pre-pass runs FIRST, because a finding a documented rule
  // answers has to be reported as answered rather than as blocking — and this
  // report must show the same decisions the copy would apply.
  const resolutionPlan = await planResolutions(source);
  // The log is held rather than discarded: the audit phase RUNS the plans'
  // transforms, so by the end of it every rule has already acted on exactly the
  // rows it will act on during the copy. Printing that is how an operator sees
  // the specific list BEFORE anything is written rather than after.
  const log = new ResolutionLog();
  const resolutions = createResolutionContext(resolutionPlan, log);

  heading('AUDIT');
  const { findings, referentialIntegrity } = await runAudits(db, source, discovery, resolutions, {
    batchSize: options.batchSize,
  });
  reportFindings(findings);
  reportReferentialIntegrity(referentialIntegrity);
  reportResolutionsApplied(log.summary(), 'RESOLUTIONS THE COPY WOULD APPLY');
  await persistResolutionLog(db, log.summary());
  return findings.filter(auditWouldBlockCopy).length;
}

function reportDiscovery(discovery: Discovery): void {
  for (const entry of discovery.migrated) {
    say(`  migrate  ${entry.plan.collection.padEnd(32)} ${entry.documents} document(s)`);
  }
  for (const entry of discovery.excluded) {
    say(`  EXCLUDE  ${entry.collection.padEnd(32)} ${entry.documents} document(s)`);
    say(`           reason: ${entry.reason}`);
  }
  if (discovery.absent.length > 0) {
    say(
      `\n  Mapped but absent from this database (nothing to do): ` +
        `${discovery.absent.join(', ')}`
    );
  }
}

/**
 * Every audit finding, saying plainly whether it blocks.
 *
 * A finding a rule answers is printed in FULL — same value, same count, same
 * ids — with the rule and its decision underneath. The point of a resolution is
 * that the operator can see the decision was applied as stated; a finding that
 * quietly stopped being printed would defeat exactly that.
 */
function reportFindings(findings: readonly AuditFinding[]): void {
  if (findings.length === 0) {
    say('  No findings. Every value the schema constrains is one the schema accepts.');
    return;
  }
  for (const finding of findings) {
    say(`  [${finding.kind}] ${finding.detail}`);
    say(`      ${finding.documents} document(s); e.g. ${finding.sampleIds.join(', ') || '(none)'}`);
    if (finding.resolvedBy === undefined) {
      say('      BLOCKS the copy — fix the data, widen the schema, or write a rule.');
      continue;
    }
    say(`      RESOLVED by \`${finding.resolvedBy.id}\` — does not block.`);
    say(`      decision: ${finding.resolvedBy.decision}`);
  }
  const blocking = findings.filter(auditWouldBlockCopy).length;
  say(
    `\n  ${blocking} finding(s) BLOCK the copy; ${findings.length - blocking} answered ` +
      'by a documented resolution rule.'
  );
}

/**
 * The referential-integrity pass: what it inspected, then every orphan.
 *
 * The COUNTS print whether or not anything was found, and that is the point —
 * "no orphans" is a claim about a CHECK, so the operator has to be able to see
 * that the check looked at a real number of relations and references rather
 * than at nothing.
 */
function reportReferentialIntegrity(report: ReferentialIntegrityReport): void {
  heading('REFERENTIAL INTEGRITY');
  if (report.notRunReason !== undefined) {
    say('  NOT RUN — referential integrity is UNKNOWN, which is not the same as clean.');
    say(`  ${report.notRunReason}`);
    return;
  }
  // COVERAGE FIRST, as a fraction, because it is what makes every number below
  // it mean anything. "8 relations inspected" reads as a clean report whether
  // the plans' tables carry 8 constraints or 42, and that ambiguity is what let
  // an audit over a fifth of the graph look complete.
  const coverage = report.coverage;
  if (coverage === undefined) {
    say('  Coverage: UNKNOWN — the derived set was never reconciled against pg_constraint.');
  } else {
    say(
      `  Coverage: ${coverage.derived}/${coverage.deployedInScope} foreign key(s) ` +
        'deployed on tables these plans write were derived and checked' +
        (coverage.outOfScope === 0
          ? '.'
          : `; ${coverage.outOfScope} more are deployed on tables no plan writes yet ` +
            'and are OUT OF SCOPE — expected while collections remain unplanned, ' +
            'and not a defect.')
    );
    for (const missing of coverage.missing) {
      say(
        `    NOT DERIVED  ${missing.constraint} on ${missing.tableName} → ` +
          `${missing.targetTableName} — every reference through it is unchecked.`
      );
    }
  }

  // The SUBJECT, before any count taken over it. A bound nobody sees is a
  // vacuity floor waiting to happen: a run that declined to look at forty
  // thousand recent documents must not read as a run that found them clean.
  const bound = report.liveSourceBound;
  if (bound === undefined) {
    say('  Live-source bound: UNKNOWN — this report does not say what it declined to read.');
  } else if (bound.excluded === 0) {
    say(
      '  Live-source bound: nothing was written to any mapped collection while this ' +
        'pass ran, so it read every document that existed when it started AND every ' +
        'one that exists now.'
    );
  } else {
    say(
      `  Live-source bound: ${bound.excluded} document(s) arrived while this pass ran ` +
        'and were EXCLUDED — it reports on the source as it stood when it started, ' +
        'which is the only instant a two-phase check can honestly speak about. They ' +
        'are not clean and not dirty; they were not looked at.'
    );
    for (const [collection, count] of [...bound.excludedByCollection].sort()) {
      say(`    ${collection.padEnd(32)} ${count} document(s) newer than the bound`);
    }
  }

  say(
    `  ${report.relationsInspected} foreign key(s) derived from the schema, ` +
      `${report.relationsExercised} of them exercised by this data; ` +
      `${report.collectionsInspected} collection(s) streamed, ` +
      `${report.documentsInspected} document(s) read, ` +
      `${report.referencesChecked} non-NULL reference(s) resolved.`
  );

  // ROW CARDINALITY first: it is the evidence behind every orphan verdict below,
  // and a deficit here is a worse problem than any orphan. The two reasons a
  // plan emits fewer rows than it read print APART, because they are opposite
  // events: one is a decision with the ids to check it against, the other is
  // silent data loss.
  //
  // It was called "transform fidelity" until a rehearsal that scored 58/58 was
  // found to be silently dropping eleven columns. The number was true; the NAME
  // asserted the whole transform was verified while the computation counted one
  // thing — rows per document — and a reader seeing "fidelity 58/58" had no
  // reason to ask "fidelity of what, exactly". Columns are a separate question
  // and are answered by `columnCoverage.ts`, separately labelled.
  const lossy = report.emissions.filter((entry) => !emissionIsFaithful(entry));
  say(
    `  Row cardinality: ${report.emissions.length - lossy.length} of ` +
      `${report.emissions.length} plan(s) emitted exactly one primary row per ` +
      'document read, once documented removals are accounted for. This says ' +
      'NOTHING about which columns of those rows were filled.'
  );
  for (const entry of report.emissions) {
    if (entry.documentsDroppedByRule > 0) {
      say(
        `    by RULE  ${entry.collection}: read ${entry.documentsRead}, emitted ` +
          `${entry.primaryRowsEmitted} — ${entry.documentsDroppedByRule} document(s) ` +
          'removed by a documented resolution, each reported by id below.'
      );
    }
    const unexplained = droppedDocuments(entry);
    if (unexplained > 0) {
      say(
        `    DROPPED  ${entry.collection}: read ${entry.documentsRead}, emitted ` +
          `${entry.primaryRowsEmitted} — ${unexplained} document(s) LOST by the ` +
          'copy, with nothing accounting for them.'
      );
    }
  }

  if (report.orphans.length === 0) {
    say('  Every reference names a row the migration produces.');
    return;
  }

  say(`\n  ${report.orphans.length} relation(s) hold orphans:`);
  for (const orphans of report.orphans) {
    const relation = orphans.relation;
    say(
      `\n    ${describeRelationColumns(relation)}  [${relation.constraint}, ` +
        `${relation.nullable ? 'NULLABLE' : 'NOT NULL'}, ON DELETE ${relation.onDelete}]`
    );
    say(
      `      ${orphans.documents} row(s) across ${orphans.values.length} missing ` +
        `value(s) — resolvability: ${orphanResolvability(relation)}`
    );
    if (orphans.resolvedBy !== undefined) {
      say(
        `      RESOLVED by \`${orphans.resolvedBy.id}\` — all ${orphans.documents} ` +
          'row(s) provably never reach Postgres, so this does not block.'
      );
    }
    for (const value of orphans.values) {
      say(`      missing ${JSON.stringify(value.value)} — ${value.documents} row(s)`);
    }
    const ids = orphans.documentIds.join(', ');
    if (ids.length > 0) say(`      referencing document(s): ${ids}`);
  }
}

/**
 * What the resolutions did, per rule, with every id.
 *
 * Every id, not a sample: the whole point is that the operator can check the
 * decision landed exactly where the audit said it would — and, where a rule
 * DESTROYS a row, that the carried columns are the only remaining handle on
 * whatever the row was describing.
 */
/**
 * Write the id-level record somewhere it can be read WHOLE, and say where.
 *
 * The printed report is a courtesy; this is the artefact. Run 10's report
 * truncated mid-stream at CloudWatch's page limit and read exactly like a run
 * that produced no verdict, which is the failure this closes — the cutover's
 * log is strictly larger and its content is the record of what we did to
 * production.
 *
 * The row count is printed BESIDE the rule totals on purpose: two numbers from
 * two paths that must agree, so a log that silently wrote nothing is visible
 * rather than assumed.
 */
async function persistResolutionLog(
  db: Database,
  summaries: readonly ResolutionSummary[]
): Promise<void> {
  const expected = summaries.reduce((total, summary) => total + summary.records.length, 0);
  const written = await writeResolutionLog(db, RUN_ID, summaries);
  heading('RESOLUTION LOG');
  say(`  run id: ${RUN_ID}`);
  say(`  ${written} record(s) written to \`${RESOLUTION_LOG_TABLE}\` (report claimed ${expected}).`);
  if (written !== expected) {
    say('  MISMATCH — the printed report and the durable log disagree. Trust neither.');
  }
  say(`  read it back:  select * from ${RESOLUTION_LOG_TABLE} where run_id = '${RUN_ID}';`);
}

function reportResolutionsApplied(
  summaries: readonly ResolutionSummary[],
  title: string
): void {
  if (summaries.length === 0) return;
  heading(title);
  for (const summary of summaries) {
    say(`  ${summary.rule.id} — ${summary.documents} document(s) changed`);
    if (summary.documents === 0) {
      say('      nothing in this data needed it.');
      continue;
    }
    for (const record of summary.records) {
      say(`      ${record.documentId}: ${record.detail}`);
      if (record.evidence === undefined) continue;
      const carried = Object.entries(record.evidence)
        .map(([column, value]) => `${column}=${value}`)
        .join('  ');
      say(`          ${carried}`);
    }
  }
}

/**
 * Empty every target table, after saying exactly what that destroys.
 *
 * The manifest is printed BEFORE the truncate and carries real counts, because
 * that is the number an operator is authorising.
 *
 * `--only` deliberately does NOT narrow it. The flag means "start this cutover
 * from nothing", and emptying a subset while leaving the rest of an earlier
 * attempt in place would produce precisely the mixture it exists to remove.
 */
async function emptyTheTarget(db: Database, only: readonly string[] | undefined): Promise<void> {
  heading('START FROM EMPTY — THIS DESTROYS DATA');
  const tables = targetTables();
  const populated = await populatedTables(db, tables);
  const totalRows = populated.reduce((total, entry) => total + entry.rows, 0);

  say(
    `  ${tables.length} table(s) will be TRUNCATED — every table the plans write. ` +
      `${populated.length} of them hold data today, ${totalRows} row(s) in total, ` +
      'and all of it is about to be removed.'
  );
  for (const entry of populated) {
    say(`    ${entry.table.padEnd(44)} ${entry.rows} row(s)`);
  }
  if (populated.length === 0) {
    say('    (every one of them is already empty — this is a no-op)');
  }
  if (only !== undefined) {
    say(
      `  NOTE: --only=${only.join(',')} restricts the COPY, not this reset. Every ` +
        'table above is emptied; only the listed collections are then refilled.'
    );
  }

  await startFromEmpty(db, tables);
  say('  Done — the target is empty and every checkpoint is forgotten.');
}

async function runVerification(
  db: Database,
  source: MongoSource,
  options: Options
): Promise<number> {
  heading('VERIFY');
  const live = new Set(await source.listCollections());
  const plans = COLLECTION_PLANS.filter(
    (plan) =>
      live.has(plan.collection) &&
      (options.only === undefined || options.only.includes(plan.collection))
  );

  // The verifier re-runs each transform to compute what Postgres SHOULD hold,
  // so it has to run it under the same decisions the copy did. They are derived
  // from the source rather than remembered, which is what makes rebuilding them
  // here equivalent rather than approximate.
  const resolutions = createResolutionContext(await planResolutions(source), new ResolutionLog());
  const parents = await loadParentKeys(db, parentTablesForRules());

  try {
    const report = await verifyBackfill(db, source, plans, resolutions, parents, {
      batchSize: options.batchSize,
      sample: options.sample,
    });
    if (verificationPassed(report)) {
      say(
        `  PASS — ${report.collections.length} collection(s), ` +
          `${report.documentsSampled} sampled document(s), ` +
          `${report.columnsCompared} column comparison(s).`
      );
      return 0;
    }

    heading('VERIFICATION FAILED');
    for (const count of report.countMismatches) {
      say(
        `  count  ${count.table}: the transforms produced ${count.expected} row(s), ` +
          `Postgres holds ${count.actual}.`
      );
    }
    for (const mismatch of report.fieldMismatches) {
      say(
        `  field  ${mismatch.table}.${mismatch.column} on row ${mismatch.rowId}: ` +
          `expected ${mismatch.expected}, found ${mismatch.actual}.`
      );
    }
    if (report.missingRows > 0) {
      say(`  ${report.missingRows} row(s) the transforms produced are not in Postgres at all.`);
    }
    return 1;
  } catch (error) {
    if (error instanceof VacuousVerificationError) {
      heading('VERIFICATION PROVED NOTHING');
      say(error.message);
      return 1;
    }
    throw error;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`\nBackfill FAILED: ${describeError(error)}\n`);
    if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  });
