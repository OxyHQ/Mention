/**
 * `--start-from-empty`: the gate that makes a re-run CONVERGE, not just repeat.
 *
 * ## Idempotent is not the same as convergent, and the difference is silent
 *
 * Every insert is `ON CONFLICT DO NOTHING`, so running the backfill twice never
 * duplicates a row. It is tempting to read that as "a re-run fixes whatever was
 * wrong", and it does not: `DO NOTHING` means a row that is ALREADY THERE is
 * left exactly as it was. A second run over a partly-populated target therefore
 * refreshes nothing — it fills the gaps and leaves every previously-written row
 * frozen at whatever the source said the first time.
 *
 * The result is a table holding two points in time with no marker saying which
 * row came from which, and no error anywhere. That is worse than an obvious
 * failure, because the run reports success.
 *
 * So there are exactly two supported ways to start:
 *
 * - **Resume** an interrupted run from its checkpoints. Correct because the
 *   rows already written were written by the same run, from the same source
 *   state, and the checkpoint says precisely where to continue.
 * - **Start from empty**, with this function, which TRUNCATES the target tables
 *   and forgets every checkpoint. Correct because there is no prior state left
 *   to mix with.
 *
 * "Run it again over whatever is there" is not on the list.
 *
 * ## Why it is a separate, explicit step
 *
 * This deletes production rows. It is not a flag the runner may infer, and it
 * refuses to guess: `assertTargetsEmpty` is what a normal run calls to find out
 * it should have been used, and it names the tables rather than silently
 * proceeding.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../postgres';
import { clearState } from './checkpointStore';
import { COLLECTION_PLANS } from './collectionMap';
import { planTables, tableName } from './plan';

/** Every table any plan writes to, deduplicated. */
export function targetTables(): string[] {
  const names = new Set<string>();
  for (const plan of COLLECTION_PLANS) {
    for (const table of planTables(plan)) names.add(tableName(table));
  }
  return [...names].sort();
}

/** A table that already holds rows, and how many. */
export interface PopulatedTable {
  readonly table: string;
  readonly rows: number;
}

/** Which of the given tables are non-empty. */
export async function populatedTables(
  db: Database,
  tables: readonly string[] = targetTables()
): Promise<PopulatedTable[]> {
  const populated: PopulatedTable[] = [];
  for (const table of tables) {
    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from ${sql.identifier(table)}`
    );
    const count = Number(rows[0]?.n ?? '0');
    if (count > 0) populated.push({ table, rows: count });
  }
  return populated;
}

/** Raised when a fresh run would write into a target that already holds rows. */
export class TargetNotEmptyError extends Error {
  constructor(readonly populated: readonly PopulatedTable[]) {
    super(
      `${populated.length} target table(s) already hold rows, and this run has no ` +
        'checkpoint to resume from:\n' +
        populated.map((entry) => `  ${entry.table}: ${entry.rows}`).join('\n') +
        '\n\nEvery insert is ON CONFLICT DO NOTHING, so continuing would FILL THE ' +
        'GAPS and leave every existing row frozen at whatever the source said when ' +
        'it was first written — one table holding two points in time, with no ' +
        'error and no marker saying which row is which. Either resume a run that ' +
        'has checkpoints, or pass --start-from-empty to truncate these tables ' +
        'first. There is no third option that is correct.'
    );
    this.name = 'TargetNotEmptyError';
  }
}

/**
 * Refuse a fresh run whose targets are not empty.
 *
 * Called when there is nothing to resume from. A run WITH checkpoints skips
 * this: rows already written there came from the same run and the same source
 * state, which is the case `ON CONFLICT DO NOTHING` is actually correct for.
 */
export async function assertTargetsEmpty(
  db: Database,
  tables: readonly string[] = targetTables()
): Promise<void> {
  const populated = await populatedTables(db, tables);
  if (populated.length > 0) throw new TargetNotEmptyError(populated);
}

/**
 * Truncate every target table and forget every checkpoint.
 *
 * ONE statement for all of them, with `CASCADE`: the tables reference each other
 * (`likes.post_id → posts.id`), so truncating them one at a time would fail on
 * the first parent whose children are still populated, and truncating in
 * reverse-topological order would merely be a second place to keep that
 * derivation correct. `RESTART IDENTITY` is not used — every id in this schema
 * is application-generated, so there is no sequence to reset.
 *
 * `CASCADE` here reaches only tables in the same foreign-key closure, which for
 * this schema is exactly the migration's own targets. It is still the most
 * destructive statement in the whole backfill, which is why nothing calls it
 * without an explicit flag.
 */
export async function startFromEmpty(
  db: Database,
  tables: readonly string[] = targetTables()
): Promise<{ truncated: readonly string[] }> {
  if (tables.length === 0) return { truncated: [] };

  const identifiers = tables.map((table) => sql.identifier(table));
  await db.execute(
    sql`truncate table ${sql.join(identifiers, sql`, `)} cascade`
  );
  // The checkpoints describe rows that no longer exist; leaving them would make
  // the next run resume past data it never wrote.
  await clearState(db);

  return { truncated: [...tables] };
}
