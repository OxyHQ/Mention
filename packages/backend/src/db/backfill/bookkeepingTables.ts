/**
 * The backfill's bookkeeping tables exist because a MIGRATION created them, and
 * this module is the only thing that checks.
 *
 * ## What changed, and what else believed the old answer
 *
 * `checkpointStore.ts` and `resolutionLogStore.ts` each used to open with
 * `create table if not exists`. The tables are now created by
 * `0016_backfill_bookkeeping_tables` and these two modules only ASK.
 *
 * **This is not a privilege fix.** `bulkLoad.ts` creates an unlogged staging
 * table on every load, thousands of times per run, so the copy needs `CREATE` on
 * the schema regardless of what happens here — see 0016's own header for the
 * measurement. What changed is that a table's shape is no longer decided by a
 * statement that silently accepts whatever a previous run left behind, and that
 * the runtime question became a different one: not "is it there yet" but "did
 * the migration run". The error has to say so, because a `42P01` from whichever
 * insert ran first sends the reader looking for a permission.
 *
 * ## Why the check is not just left to the first `insert`
 *
 * It would fail. `42P01: relation "mention_backfill_checkpoints" does not exist`
 * is a true statement that names nothing an operator can act on, arriving from
 * whichever query happened to run first. Naming the migration turns a diagnosis
 * into an instruction.
 *
 * ## Why there is no `drop` counterpart any more
 *
 * There was one, `dropCheckpointTable`, for "when the migration is retired".
 * With the table in the ledger, retiring it is a migration too — and a runtime
 * drop is now actively dangerous: 0016 is recorded applied and never re-runs, so
 * a process that dropped the table would leave every later run throwing "apply
 * 0016" against a migration that has already been applied. The capability moved
 * to where the table's lifetime now lives.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../postgres';

/** The migration that creates every table this module guards. */
export const BOOKKEEPING_MIGRATION = '0016_backfill_bookkeeping_tables';

/** Raised when a bookkeeping table its migration should have created is absent. */
export class MissingBookkeepingTableError extends Error {
  constructor(readonly table: string) {
    super(
      `The backfill bookkeeping table \`${table}\` does not exist. It is created ` +
        `by migration \`${BOOKKEEPING_MIGRATION}\`, and by nothing else — no code ` +
        'path creates it at runtime, deliberately. Apply the migrations against ' +
        'this database (`bun packages/backend/dist/src/db/migrate.js` against ' +
        'DATABASE_URL) and run again. This is NOT a privilege problem: a role ' +
        'that may not create tables is the case this arrangement exists to serve.'
    );
    this.name = 'MissingBookkeepingTableError';
  }
}

/**
 * Verify a bookkeeping table is present, and never create it.
 *
 * The name is left UNQUALIFIED on purpose: `to_regclass` then resolves it
 * through the same `search_path` every subsequent `insert` and `select` will
 * use, so a table that resolves here is the table those statements will reach.
 * Qualifying it `public.` would answer a question no other statement in these
 * two modules asks.
 *
 * @throws {MissingBookkeepingTableError} When the table does not exist.
 */
export async function assertBookkeepingTableExists(db: Database, table: string): Promise<void> {
  const rows = await db.execute<{ present: boolean }>(
    sql`select to_regclass(${table}) is not null as present`
  );
  if (rows[0]?.present !== true) throw new MissingBookkeepingTableError(table);
}
