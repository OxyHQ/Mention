/**
 * Where a run's resume position lives — POSTGRES, not a file.
 *
 * ## This is a DELIBERATE DIVERGENCE from the reference implementation
 *
 * The oxy-api migration this machinery is modelled on checkpoints to a FILE.
 * That is the one part of its design deliberately NOT copied here, and this
 * paragraph exists so nobody later "restores consistency with the reference
 * implementation" and reintroduces the defect.
 *
 * It was not a mistake there. oxy-api's largest collection was ~296k documents
 * and its whole migration ~495k, so losing a checkpoint cost minutes of
 * re-read — which is why the flaw never bit and never had to be noticed. The
 * numbers here are different in kind, not degree: `authorfollowersnapshots`
 * alone holds 2,155,466 documents (census, 2026-08-02), more than four times
 * that entire migration.
 *
 * ## Why not a file, which is the obvious answer
 *
 * The backfill runs as a one-shot Fargate task. That task has no durable local
 * disk: when it dies, everything it wrote to its filesystem dies with it. A
 * file-based checkpoint is therefore not a resume mechanism at all — it
 * survives exactly the failures that do not need it (a clean exit) and is lost
 * in exactly the ones that do (OOM, spot reclaim, a `23503` three levels in).
 *
 * That is survivable when the largest collection is ~300k documents, because
 * re-reading from zero is minutes. It is not survivable here.
 * `authorfollowersnapshots` holds **2,155,466 documents** and `posts` **573,339**
 * (census, 2026-08-02) — four times the entire sibling migration in one
 * collection. A run that dies at document 1.8M and restarts at 0 has not
 * "lost some time"; it has lost the run, and the operator will be tempted to
 * reach for something worse under pressure.
 *
 * So the checkpoint goes into the database the copy is already filling. It is
 * committed by the same connection pool, immediately after the batch it
 * describes, and it is still there when a replacement task starts.
 *
 * ## Why it is safe for this table to live outside the drizzle SCHEMA, while
 * still being created by a MIGRATION
 *
 * `mention_backfill_checkpoints` is created by
 * `drizzle/0016_backfill_bookkeeping_tables.sql` and is absent from the schema
 * barrel. Those are two separate decisions and both matter.
 *
 * It stays out of the barrel because it is migration BOOKKEEPING, not
 * application data: `tablesWithoutAPlan()` refuses to start a copy while any
 * barrel table has no plan feeding it, and this table has no Mongo source by
 * construction.
 *
 * It is nonetheless created by a MIGRATION rather than at runtime, which is the
 * part that changed — so that its shape is versioned rather than decided by a
 * `create table if not exists` that accepts whatever a previous run left. It is
 * NOT a privilege fix: the copy still needs `CREATE` on the schema for
 * `bulkLoad.ts`'s staging tables. See `bookkeepingTables.ts` for the whole
 * argument, including why `dropCheckpointTable` is gone rather than kept.
 *
 * ## The checkpoint is an OPTIMISATION, and that ordering matters
 *
 * Every insert is `ON CONFLICT DO NOTHING` and every id is copied verbatim, so
 * re-running from zero is always CORRECT — merely slow. Losing a checkpoint
 * must therefore cost time and never integrity, which is what lets this table
 * be created outside the schema, dropped freely, and ignored entirely by
 * `--start-from-empty`.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../postgres';
import { assertBookkeepingTableExists } from './bookkeepingTables';
import type { Checkpoint } from './mongoSource';
import type { BackfillState } from './runner';

/** The bookkeeping table this module owns. */
export const CHECKPOINT_TABLE = 'mention_backfill_checkpoints';

/**
 * Record where a collection has got to.
 *
 * Called after each COMMITTED batch, so the position it names is a position
 * whose rows are already durable. Writing it before the batch would produce the
 * one failure mode a checkpoint must not have: a resume that skips documents
 * the copy never actually wrote.
 */
export async function saveCheckpoint(
  db: Database,
  collection: string,
  checkpoint: Checkpoint,
  documentsCopied: number
): Promise<void> {
  await db.execute(sql`
    insert into ${sql.identifier(CHECKPOINT_TABLE)}
      (collection, checkpoint_value, checkpoint_kind, documents_copied, updated_at)
    values (${collection}, ${checkpoint.value}, ${checkpoint.kind}, ${documentsCopied}, now())
    on conflict (collection) do update set
      checkpoint_value = excluded.checkpoint_value,
      checkpoint_kind = excluded.checkpoint_kind,
      documents_copied = excluded.documents_copied,
      updated_at = now()
  `);
}

/**
 * Mark a collection finished — its copy AND its deferred-reference pass.
 *
 * Separate from the position because they answer different questions: a
 * position says "resume here", `completed` says "do not resume at all". A
 * collection whose second pass died must NOT be treated as done just because
 * its first pass reached the end.
 */
export async function markCompleted(db: Database, collection: string): Promise<void> {
  await db.execute(sql`
    insert into ${sql.identifier(CHECKPOINT_TABLE)} (collection, completed, updated_at)
    values (${collection}, true, now())
    on conflict (collection) do update set completed = true, updated_at = now()
  `);
}

/**
 * Read every checkpoint back, as the runner's resume state.
 *
 * The table check lives HERE and in `clearState` because those two are the
 * copy's front door — the first thing a run touches. `saveCheckpoint` and
 * `markCompleted` deliberately do not repeat it: they run once per batch, and
 * paying a catalog lookup thousands of times to re-answer a question settled
 * before the first document was read buys nothing.
 */
export async function loadState(db: Database): Promise<BackfillState> {
  await assertBookkeepingTableExists(db, CHECKPOINT_TABLE);
  const rows = await db.execute<{
    collection: string;
    checkpoint_value: string | null;
    checkpoint_kind: string | null;
    completed: boolean;
  }>(sql`
    select collection, checkpoint_value, checkpoint_kind, completed
    from ${sql.identifier(CHECKPOINT_TABLE)}
  `);

  const checkpoints: Record<string, Checkpoint> = {};
  const completed: string[] = [];
  for (const row of rows) {
    if (row.completed) completed.push(row.collection);
    if (row.checkpoint_value === null) continue;
    // The kind is READ, never guessed from the value's shape.
    if (row.checkpoint_kind !== 'objectId' && row.checkpoint_kind !== 'string') continue;
    checkpoints[row.collection] = {
      value: row.checkpoint_value,
      kind: row.checkpoint_kind,
    };
  }
  return { checkpoints, completed };
}

/** Forget every checkpoint, so the next run starts from the beginning. */
export async function clearState(db: Database): Promise<void> {
  await assertBookkeepingTableExists(db, CHECKPOINT_TABLE);
  await db.execute(sql`delete from ${sql.identifier(CHECKPOINT_TABLE)}`);
}
