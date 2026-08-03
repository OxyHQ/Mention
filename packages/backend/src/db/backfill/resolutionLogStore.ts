/**
 * The durable record of what the migration DID to the data, in the database it
 * did it to.
 *
 * ## Why this exists
 *
 * The resolution report is the audit trail for every row a documented rule
 * changed or removed — 1,500 of them on the 2026-08-03 production audit, each
 * named by id with its reason. It was printed to stdout and nowhere else, and
 * on run 10 that report exceeded CloudWatch's 10,000-event page and truncated
 * MID-REPORT. The read looked exactly like a run that had produced no verdict.
 *
 * **A clean verdict, a missing verdict and a truncated read are three different
 * things that look identical**, and the run where that distinction is most
 * expensive is the cutover, whose log is strictly larger than the audit's. A
 * record of what we did to production has to be readable AFTERWARDS, not only
 * at the moment it scrolls past.
 *
 * ## Why a table rather than an object store
 *
 * Same pattern, and the same reasoning, as `checkpointStore.ts`: bookkeeping the
 * migration owns, created at runtime with `create table if not exists`, living
 * in the database the migration writes. It needs no bucket, no IAM policy on the
 * task role and no credential path — so it works on the next run rather than
 * after an infrastructure change — and it is QUERYABLE, which a log file is not:
 * "which posts did we null a parent link on" is a `where`, not a `grep`.
 *
 * Keyed by RUN ID, so a re-run, a resumed run and the eventual cutover are
 * separable rather than a single undifferentiated pile.
 *
 * One row per RECORD, not per rule. The rule-level counts are a summary anyone
 * can recompute; the id-level rows are the thing that cannot be reconstructed
 * once the process exits.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../postgres';
import type { ResolutionSummary } from './resolutions';

/** The bookkeeping table this module owns. */
export const RESOLUTION_LOG_TABLE = 'mention_backfill_resolution_log';

/** Create the log table if it is not already there. */
export async function ensureResolutionLogTable(db: Database): Promise<void> {
  await db.execute(sql`
    create table if not exists ${sql.identifier(RESOLUTION_LOG_TABLE)} (
      -- A surrogate key: this is an append-only journal with no natural one,
      -- since the "within" column is nullable by design and so cannot be part
      -- of a primary key. schemaInvariants.test.ts requires every table to have
      -- one, and satisfying that rule beats carving an exception into it.
      id bigint generated always as identity primary key,
      run_id text not null,
      rule_id text not null,
      collection text not null,
      document_id text not null,
      within text,
      detail text not null,
      evidence jsonb,
      written_at timestamptz not null default now()
    )
  `);
  // The two questions anyone actually asks: everything one run did, and
  // everything ever done to one document.
  await db.execute(sql`
    create index if not exists ${sql.identifier(`${RESOLUTION_LOG_TABLE}_run_rule_idx`)}
      on ${sql.identifier(RESOLUTION_LOG_TABLE)} (run_id, rule_id)
  `);
  await db.execute(sql`
    create index if not exists ${sql.identifier(`${RESOLUTION_LOG_TABLE}_document_idx`)}
      on ${sql.identifier(RESOLUTION_LOG_TABLE)} (document_id)
  `);
}

/**
 * Persist every record the rules produced, and return how many rows were written.
 *
 * The count is RETURNED rather than logged so the caller can print it beside the
 * rule summary — a number the operator can compare against what the report
 * claimed, which is the check that catches a log that silently wrote nothing.
 */
export async function writeResolutionLog(
  db: Database,
  runId: string,
  summaries: readonly ResolutionSummary[]
): Promise<number> {
  await ensureResolutionLogTable(db);

  const rows = summaries.flatMap((summary) =>
    summary.records.map((record) => ({
      ruleId: record.rule.id,
      collection: record.rule.collection,
      documentId: record.documentId,
      within: record.within ?? null,
      detail: record.detail,
      evidence: record.evidence === undefined ? null : JSON.stringify(record.evidence),
    }))
  );
  if (rows.length === 0) return 0;

  // Batched, because a cutover writes thousands of these and one statement per
  // row would dominate the run's tail.
  const BATCH = 500;
  for (let index = 0; index < rows.length; index += BATCH) {
    const batch = rows.slice(index, index + BATCH);
    const values = batch.map(
      (row) =>
        sql`(${runId}, ${row.ruleId}, ${row.collection}, ${row.documentId}, ${row.within}, ${row.detail}, ${row.evidence}::jsonb)`
    );
    await db.execute(sql`
      insert into ${sql.identifier(RESOLUTION_LOG_TABLE)}
        (run_id, rule_id, collection, document_id, within, detail, evidence)
      values ${sql.join(values, sql`, `)}
    `);
  }

  return rows.length;
}
