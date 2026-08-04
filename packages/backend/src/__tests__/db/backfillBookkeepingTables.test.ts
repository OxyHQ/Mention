/**
 * The guard that replaced `create table if not exists`.
 *
 * Both bookkeeping tables now arrive with migration
 * `0016_backfill_bookkeeping_tables`, and nothing creates them at runtime. What
 * has to be true of the check that replaced the creation is narrow and worth
 * pinning exactly:
 *
 *  1. it PASSES for a table the migration created — otherwise every run is
 *     blocked by its own safety check;
 *  2. it FAILS for a table that is absent — otherwise it is decoration, and the
 *     first thing anyone would see is a `42P01` from whichever insert ran first;
 *  3. its message names the MIGRATION, because "relation does not exist" and
 *     "apply 0016" send an operator to two different places, and the wrong one
 *     is a privilege hunt.
 *
 * The absent case is asserted against a name that has never existed rather than
 * by dropping a real table. `mention_backfill_checkpoints` is shared by four
 * test files running in parallel workers against ONE database (see
 * `checkpointTableLock.ts`), so dropping it to observe the failure would make
 * this file the cause of a red in a file that touched nothing — the precise
 * failure the lock exists to prevent, reintroduced by the test for the fix.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import {
  assertBookkeepingTableExists,
  BOOKKEEPING_MIGRATION,
  MissingBookkeepingTableError,
} from '../../db/backfill/bookkeepingTables';
import { CHECKPOINT_TABLE } from '../../db/backfill/checkpointStore';
import { RESOLUTION_LOG_TABLE } from '../../db/backfill/resolutionLogStore';

/** A name no migration creates, so its absence is a property of the schema. */
const ABSENT_TABLE = 'mention_backfill_no_such_table';

beforeAll(async () => {
  await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

describe('assertBookkeepingTableExists', () => {
  it('passes for both tables migration 0016 creates', async () => {
    // Not "does not throw" for one of them: the migration creates two, and a
    // check wired to only the first would leave the resolution log unguarded
    // until the end of a copy — hours in, with the audit trail as the casualty.
    await expect(assertBookkeepingTableExists(getDb(), CHECKPOINT_TABLE)).resolves.toBeUndefined();
    await expect(
      assertBookkeepingTableExists(getDb(), RESOLUTION_LOG_TABLE)
    ).resolves.toBeUndefined();
  });

  it('is a no-op called repeatedly, which a resumed task does', async () => {
    await assertBookkeepingTableExists(getDb(), CHECKPOINT_TABLE);
    await expect(assertBookkeepingTableExists(getDb(), CHECKPOINT_TABLE)).resolves.toBeUndefined();
  });

  it('refuses an absent table and names the migration that would create it', async () => {
    await expect(assertBookkeepingTableExists(getDb(), ABSENT_TABLE)).rejects.toThrow(
      MissingBookkeepingTableError
    );
    await expect(assertBookkeepingTableExists(getDb(), ABSENT_TABLE)).rejects.toThrow(
      BOOKKEEPING_MIGRATION
    );
  });

  it('says the failure is NOT a privilege problem', async () => {
    // The message this replaced was `42501: permission denied for schema public`,
    // which sent the last operator to hunt a grant. Anyone who reaches this
    // error while carrying that memory has to be told the difference in the
    // error itself.
    await expect(assertBookkeepingTableExists(getDb(), ABSENT_TABLE)).rejects.toThrow(
      /NOT a privilege problem/
    );
  });

  it('names the table it could not find', async () => {
    // A run checks two tables. An error that says only "a bookkeeping table is
    // missing" leaves the operator to work out which, and they have different
    // consequences: one blocks the copy at its first statement, the other loses
    // the audit trail at its last.
    await expect(assertBookkeepingTableExists(getDb(), ABSENT_TABLE)).rejects.toThrow(ABSENT_TABLE);
  });
});
