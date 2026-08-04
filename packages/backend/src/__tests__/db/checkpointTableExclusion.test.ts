/**
 * The two halves of the shared-checkpoint-table problem, both deterministic.
 *
 * The symptom that started this — one full-suite run red on
 * `backfillCheckpoint.test.ts` with a row only `backfillVerify.test.ts` writes
 * — is a RACE, and a race is exactly what a test cannot pin by reproducing it:
 * ten paired runs of those two files passed 10/10, because with two files the
 * overlap window is narrow. A loop that green-lights a fix it could never have
 * failed against is not evidence.
 *
 * So this pins the MECHANISM instead, which is deterministic and cannot pass by
 * luck:
 *
 *  1. the checkpoint table has no isolation of its own — one session's clear
 *     destroys another session's row, which is precisely what the two files do
 *     to each other;
 *  2. `lockCheckpointTable` supplies that isolation — a second holder is
 *     refused while it is held, and admitted once it is released.
 *
 * Fixtures are `cte-` prefixed.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assertBookkeepingTableExists } from '../../db/backfill/bookkeepingTables';
import {
  CHECKPOINT_TABLE,
  clearState,
  loadState,
  saveCheckpoint,
} from '../../db/backfill/checkpointStore';
import { closePostgres, connectPostgres, getDb, getPostgresClient } from '../../db/postgres';
import { CHECKPOINT_TABLE_LOCK_KEY, lockCheckpointTable } from './checkpointTableLock';

let releaseCheckpointTable: () => Promise<void>;

beforeAll(async () => {
  await connectPostgres();
  // This file touches the shared table too, so it plays by the same rule it
  // exists to establish.
  releaseCheckpointTable = await lockCheckpointTable();
  await assertBookkeepingTableExists(getDb(), CHECKPOINT_TABLE);
}, 120_000);

afterEach(async () => {
  await clearState(getDb());
});

afterAll(async () => {
  await releaseCheckpointTable();
  await closePostgres();
});

describe('the checkpoint table is global state with no per-session isolation', () => {
  it("one session's clear destroys another session's row", async () => {
    await saveCheckpoint(getDb(), 'cte-collection', { value: 'zzz', kind: 'string' }, 1);
    expect((await loadState(getDb())).checkpoints['cte-collection']?.value).toBe('zzz');

    // A second connection, standing in for the other test file's worker. It is
    // a different session against the same database — which is the entire
    // relationship between two vitest files.
    const other = await getPostgresClient().reserve();
    try {
      await other`delete from mention_backfill_checkpoints`;
    } finally {
      other.release();
    }

    // Gone. Nothing errored, nothing warned, and the row simply is not there —
    // which is why the failure this causes lands in whichever file happens to
    // read next, never the one at fault.
    expect((await loadState(getDb())).checkpoints['cte-collection']).toBeUndefined();
  });
});

describe('lockCheckpointTable', () => {
  it('refuses a second holder while it is held, and admits one after release', async () => {
    // This file already holds the lock (`beforeAll`), so a would-be second
    // holder must be turned away. `pg_try_advisory_lock` is the non-blocking
    // form — a blocking acquire here would hang the suite instead of failing
    // it, and a test that hangs on regression is a test nobody keeps.
    const contender = await getPostgresClient().reserve();
    try {
      const [held] = await contender<{ locked: boolean }[]>`
        select pg_try_advisory_lock(${CHECKPOINT_TABLE_LOCK_KEY}) as locked
      `;
      expect(held?.locked).toBe(false);

      // And the lock is not merely permanently unavailable — releasing it hands
      // the table over. Without this half, a `lockCheckpointTable` that failed
      // to acquire anything at all would still pass the assertion above.
      await releaseCheckpointTable();
      const [after] = await contender<{ locked: boolean }[]>`
        select pg_try_advisory_lock(${CHECKPOINT_TABLE_LOCK_KEY}) as locked
      `;
      expect(after?.locked).toBe(true);

      await contender`select pg_advisory_unlock(${CHECKPOINT_TABLE_LOCK_KEY})`;
    } finally {
      contender.release();
      // Retake it for `afterAll`, which releases unconditionally.
      releaseCheckpointTable = await lockCheckpointTable();
    }
  });
});
