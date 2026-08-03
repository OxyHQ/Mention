/**
 * Mutual exclusion over the ONE checkpoint table several test files share.
 *
 * `mention_backfill_checkpoints` is global state with no per-file scoping: it
 * is created at runtime from a single constant, keyed by collection name, and
 * two test files own operations that span the WHOLE table —
 * `backfillCheckpoint.test.ts` clears it in `beforeEach`, drops and recreates
 * it, and asserts it is empty; `backfillVerify.test.ts` writes a row into it.
 * Vitest runs test files in parallel workers against one Postgres, so those
 * overlap.
 *
 * That is not theoretical. A full-suite run failed on "forgets everything on
 * clear" expecting `{}` and receiving `{mutes: {value: 'aaa', kind: 'string'}}`
 * — the exact row `backfillVerify.test.ts` writes, under the exact key, while
 * the other file asserted the table was empty. Re-running the identical tree
 * passed. A random red in a shared suite is worse than a deterministic one:
 * the first thing it costs is somebody's afternoon attributing it to whichever
 * branch happens to be in flight.
 *
 * Renaming the colliding KEY does not fix it, which is the trap worth writing
 * down. The clear is a table-wide `DELETE` and the assertion is a table-wide
 * `toStrictEqual({})`, so a row under any other name fails it just the same;
 * and the `DROP` leaves a window in which the other file's `saveCheckpoint`
 * (which does not call `ensureCheckpointTable` first) hits a table that does
 * not exist. The collision is table-level and runs in both directions.
 *
 * A Postgres advisory lock is the fix that needs no production change and
 * weakens no assertion: the files serialise against each other and each still
 * gets a table it genuinely owns for the duration. Every file that touches this
 * table must take it — see `checkpointTableExclusion.test.ts`, which proves
 * both that the table has no isolation of its own and that this lock supplies
 * it.
 */

import { getPostgresClient } from '../../db/postgres';

/**
 * The advisory key. Arbitrary, but it must be the SAME value in every file —
 * two files holding different keys exclude nothing while looking correct.
 */
export const CHECKPOINT_TABLE_LOCK_KEY = 4_871_233;

/**
 * Take the lock on a DEDICATED connection, and return its release.
 *
 * The connection is reserved rather than taken from the pool per statement,
 * because `pg_advisory_lock` is session-scoped: acquired on one pooled
 * connection and released from whichever one the pool hands out next, the
 * unlock is a no-op that WARNS and the lock leaks for the rest of the run.
 *
 * Call it in `beforeAll` after `connectPostgres()`, and release in `afterAll`
 * BEFORE `closePostgres()`.
 */
export async function lockCheckpointTable(): Promise<() => Promise<void>> {
  const connection = await getPostgresClient().reserve();
  await connection`select pg_advisory_lock(${CHECKPOINT_TABLE_LOCK_KEY})`;
  return async () => {
    await connection`select pg_advisory_unlock(${CHECKPOINT_TABLE_LOCK_KEY})`;
    connection.release();
  };
}
