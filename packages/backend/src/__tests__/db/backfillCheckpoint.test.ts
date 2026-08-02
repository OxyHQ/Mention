/**
 * The resume path, against a real Postgres.
 *
 * A checkpoint that only works within one process is not a resume mechanism.
 * The backfill runs as a one-shot Fargate task with no durable local disk, and
 * `authorfollowersnapshots` holds 2,155,466 documents (census, 2026-08-02) —
 * so a run that dies at 1.8M and restarts at 0 has lost the run, not some time.
 *
 * These cases therefore assert DURABILITY and TYPE FIDELITY rather than that
 * the functions return without throwing: the checkpoint is read back through a
 * fresh query after being written, and the BSON kind is asserted to survive,
 * because `{$gt: ObjectId(...)}` against a string `_id` matches nothing in
 * Mongo silently — a resumed run would report "0 documents remaining" and be
 * believed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import {
  CHECKPOINT_TABLE,
  clearState,
  dropCheckpointTable,
  ensureCheckpointTable,
  loadState,
  markCompleted,
  saveCheckpoint,
} from '../../db/backfill/checkpointStore';

beforeAll(async () => {
  await connectPostgres();
  await ensureCheckpointTable(getDb());
});

beforeEach(async () => {
  await clearState(getDb());
});

afterAll(async () => {
  // Dropped to prove `dropCheckpointTable` does what it says, then RECREATED
  // immediately. Vitest runs test files in parallel against ONE database, and
  // `mention_backfill_checkpoints` is shared state: leaving it dropped raced
  // `backfillVerify.test.ts`, whose `--start-from-empty` case writes a
  // checkpoint and died on `relation … does not exist` — a failure in a file
  // that had touched nothing, arriving only when the scheduler happened to
  // order the two that way.
  await dropCheckpointTable(getDb());
  await ensureCheckpointTable(getDb());
  await closePostgres();
});

describe('the durable checkpoint', () => {
  it('is readable back after the process that wrote it is gone', async () => {
    // `loadState` issues its own query rather than returning anything cached,
    // so a value that survives it survives a task restart — that is the whole
    // claim the Fargate one-shot depends on.
    await saveCheckpoint(getDb(), 'posts', { value: '6a1b2c3d4e5f60718293a4b5', kind: 'objectId' }, 5000);

    const state = await loadState(getDb());
    expect(state.checkpoints.posts).toStrictEqual({
      value: '6a1b2c3d4e5f60718293a4b5',
      kind: 'objectId',
    });
  });

  it('preserves the BSON KIND, which cannot be inferred from the value', async () => {
    // Both are 24 hex characters. Only the stored kind distinguishes them, and
    // getting it wrong makes a resumed run silently match zero documents.
    await saveCheckpoint(getDb(), 'objectid-keyed', { value: 'abcdef012345678901234567', kind: 'objectId' }, 1);
    await saveCheckpoint(getDb(), 'string-keyed', { value: 'abcdef012345678901234567', kind: 'string' }, 1);

    const state = await loadState(getDb());
    expect(state.checkpoints['objectid-keyed']?.kind).toBe('objectId');
    expect(state.checkpoints['string-keyed']?.kind).toBe('string');
  });

  it('advances rather than accumulating — one row per collection', async () => {
    await saveCheckpoint(getDb(), 'posts', { value: 'aaa', kind: 'string' }, 5000);
    await saveCheckpoint(getDb(), 'posts', { value: 'bbb', kind: 'string' }, 10000);

    const rows = await getDb().execute<{ n: string }>(
      sql`select count(*)::text as n from ${sql.identifier(CHECKPOINT_TABLE)} where collection = 'posts'`
    );
    expect(rows[0]?.n).toBe('1');
    const state = await loadState(getDb());
    expect(state.checkpoints.posts?.value).toBe('bbb');
  });

  it('keeps `completed` separate from a position, so a dead pass B is not "done"', async () => {
    // A collection whose copy reached the end but whose deferred-reference pass
    // died must be RE-RUN, not skipped. Recording only a position expresses
    // that; `completed` is the separate, stronger claim.
    await saveCheckpoint(getDb(), 'posts', { value: 'zzz', kind: 'string' }, 573339);
    let state = await loadState(getDb());
    expect(state.completed).not.toContain('posts');

    await markCompleted(getDb(), 'posts');
    state = await loadState(getDb());
    expect(state.completed).toContain('posts');
    // And the position is still there — marking complete must not erase it.
    expect(state.checkpoints.posts?.value).toBe('zzz');
  });

  it('can mark a collection complete that has no position at all', async () => {
    // An empty collection is copied by reading zero batches, so no checkpoint
    // is ever written for it — but it is still completed, and the upsert has to
    // create the row rather than assume one exists.
    await markCompleted(getDb(), 'trendsummaries');
    const state = await loadState(getDb());
    expect(state.completed).toContain('trendsummaries');
    expect(state.checkpoints.trendsummaries).toBeUndefined();
  });

  it('forgets everything on clear, which is what --start-from-empty needs', async () => {
    await saveCheckpoint(getDb(), 'posts', { value: 'aaa', kind: 'string' }, 1);
    await markCompleted(getDb(), 'likes');

    await clearState(getDb());

    const state = await loadState(getDb());
    expect(state.checkpoints).toStrictEqual({});
    expect(state.completed).toStrictEqual([]);
  });

  it('is safe to create twice — a resumed task calls ensure again', async () => {
    await ensureCheckpointTable(getDb());
    await ensureCheckpointTable(getDb());
    await saveCheckpoint(getDb(), 'posts', { value: 'aaa', kind: 'string' }, 1);
    expect((await loadState(getDb())).checkpoints.posts?.value).toBe('aaa');
  });

  it('refuses a kind the resume path could not act on', async () => {
    // The CHECK is the guard: a row with a nonsense kind would be read back and
    // fed to `reviveCheckpoint`, which only knows two answers.
    await expect(
      getDb().execute(
        sql`insert into ${sql.identifier(CHECKPOINT_TABLE)} (collection, checkpoint_value, checkpoint_kind)
            values ('bogus', 'x', 'uuid')`
      )
    ).rejects.toThrow();
  });
});
