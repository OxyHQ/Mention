/**
 * The verifier and the `--start-from-empty` gate, against real Mongo + Postgres.
 *
 * A verifier that cannot fail is worse than none, so every case here either
 * BREAKS something and asserts the verifier notices, or asserts the floor
 * refuses a report that compared nothing. "It returned no mismatches" on its own
 * is not evidence and is never the whole of a case below.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { mutes, pokes } from '../../db/schema/engagement';
import { mongoSourceFromDb, type MongoSource } from '../../db/backfill/mongoSource';
import { copyCollection } from '../../db/backfill/runner';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import {
  createResolutionContext,
  parentKeysFrom,
  planResolutions,
  ResolutionLog,
} from '../../db/backfill/resolutions';
import {
  comparable,
  VacuousVerificationError,
  verifyBackfill,
  verifyCollection,
  verificationPassed,
} from '../../db/backfill/verify';
import {
  assertTargetsEmpty,
  populatedTables,
  startFromEmpty,
  TargetNotEmptyError,
} from '../../db/backfill/reset';
import { assertBookkeepingTableExists } from '../../db/backfill/bookkeepingTables';
import { CHECKPOINT_TABLE, loadState, saveCheckpoint } from '../../db/backfill/checkpointStore';
import { lockCheckpointTable } from './checkpointTableLock';

let mongod: MongoMemoryServer;
let client: MongoClient;
let mongo: Db;
let source: MongoSource;

const OWNER = 'bfv-u1';
const POKER = 'bfv-a';
const NO_PARENTS = parentKeysFrom(new Map());

const mutesPlan = () => {
  const plan = COLLECTION_PLANS.find((entry) => entry.collection === 'mutes');
  if (!plan) throw new Error('no plan for mutes');
  return plan;
};

async function context() {
  return createResolutionContext(await planResolutions(source), new ResolutionLog());
}

let releaseCheckpointTable: () => Promise<void>;

beforeAll(async () => {
  await connectPostgres();
  // Held for the whole file: the `--start-from-empty` case writes a checkpoint
  // row, and `backfillCheckpoint.test.ts` clears and drops the same table.
  // See `checkpointTableLock.ts`.
  releaseCheckpointTable = await lockCheckpointTable();
  // `saveCheckpoint` assumes the table exists — the RUN creates it once via
  // `loadState`, and this file stands in for that.
  await assertBookkeepingTableExists(getDb(), CHECKPOINT_TABLE);
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  mongo = client.db('backfill_verify_test');
  source = mongoSourceFromDb(mongo, async () => {
    await client.close();
  });
}, 120_000);

afterEach(async () => {
  // Scoped: vitest runs one worker per file against ONE shared database, so an
  // unscoped delete truncates a table another suite is mid-way through using.
  await getDb().delete(mutes).where(eq(mutes.userId, OWNER));
  await getDb().delete(pokes).where(eq(pokes.pokerId, POKER));
  for (const info of await mongo.listCollections({}, { nameOnly: true }).toArray()) {
    await mongo.collection(info.name).deleteMany({});
  }
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
  await releaseCheckpointTable();
  await closePostgres();
});

/** Seed `n` mutes and copy them faithfully. */
async function seedAndCopy(n: number): Promise<string[]> {
  const ids: string[] = [];
  const docs = Array.from({ length: n }, () => {
    const id = new ObjectId();
    ids.push(id.toHexString());
    return { _id: id, userId: OWNER, mutedId: `bfv-${id.toHexString()}`, createdAt: new Date() };
  });
  await mongo.collection('mutes').insertMany(docs);
  await copyCollection(mutesPlan(), {
    db: getDb(),
    source,
    resolutions: await context(),
    parents: NO_PARENTS,
  });
  return ids;
}

describe('field fidelity', () => {
  it('passes on a faithful copy — and says how much it compared', async () => {
    await seedAndCopy(3);
    const result = await verifyCollection(
      getDb(),
      source,
      mutesPlan(),
      await context(),
      NO_PARENTS
    );

    expect(result.mismatches).toStrictEqual([]);
    expect(result.missingRows).toStrictEqual([]);
    // The counts are the evidence the check RAN. "0 mismatches" next to
    // "0 columns compared" would mean nothing at all.
    expect(result.rowsCompared).toBe(3);
    expect(result.columnsCompared).toBeGreaterThan(0);
  });

  it('CATCHES a column the copy got wrong', async () => {
    const ids = await seedAndCopy(2);
    // Corrupt one stored row behind the verifier's back — exactly the shape a
    // transform bug produces, and invisible to any row count.
    await getDb()
      .update(mutes)
      .set({ mutedId: 'tampered' })
      .where(eq(mutes.id, ids[0] as string));

    const result = await verifyCollection(
      getDb(),
      source,
      mutesPlan(),
      await context(),
      NO_PARENTS
    );

    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]).toMatchObject({ table: 'mutes', column: 'mutedId' });
    expect(result.mismatches[0]?.actual).toContain('tampered');
  });

  it('CATCHES a timestamp the copy defaulted instead of copying', async () => {
    const ids = await seedAndCopy(1);
    await getDb()
      .update(mutes)
      .set({ createdAt: new Date('2099-01-01T00:00:00.000Z') })
      .where(eq(mutes.id, ids[0] as string));

    const result = await verifyCollection(
      getDb(),
      source,
      mutesPlan(),
      await context(),
      NO_PARENTS
    );
    expect(result.mismatches.map((m) => m.column)).toContain('createdAt');
  });

  it('CATCHES a row that never arrived', async () => {
    const ids = await seedAndCopy(2);
    await getDb().delete(mutes).where(eq(mutes.id, ids[0] as string));

    const result = await verifyCollection(
      getDb(),
      source,
      mutesPlan(),
      await context(),
      NO_PARENTS
    );
    expect(result.missingRows).toHaveLength(1);
    expect(result.missingRows[0]).toContain(ids[0] as string);
    // And the count check sees it independently.
    expect(result.counts[0]?.expected).toBe(2);
    expect(result.counts[0]?.actual).toBe(1);
  });
});

describe('the vacuity floor', () => {
  it('refuses a report that read documents but compared nothing', async () => {
    await seedAndCopy(2);
    await expect(
      verifyBackfill(getDb(), source, [mutesPlan()], await context(), NO_PARENTS, { sample: 0 })
    ).rejects.toThrow(VacuousVerificationError);
  });

  it('does NOT fire when there was genuinely nothing to check', async () => {
    // An empty collection compares nothing and is not a failure. A floor that
    // fired here would cry wolf, and a gate that cries wolf gets disabled.
    const report = await verifyBackfill(
      getDb(),
      source,
      [mutesPlan()],
      await context(),
      NO_PARENTS
    );
    expect(verificationPassed(report)).toBe(true);
    expect(report.columnsCompared).toBe(0);
  });
});

describe('comparable', () => {
  it('treats two Dates for the same instant as equal', () => {
    // Postgres can return microsecond precision where Mongo stored
    // milliseconds; comparing ISO strings would report a false mismatch.
    expect(comparable(new Date('2024-01-01T00:00:00.000Z'))).toBe(
      comparable(new Date('2024-01-01T00:00:00.000Z'))
    );
  });

  it('does not confuse a null with the STRING "null"', () => {
    expect(comparable(null)).not.toBe(comparable('null'));
  });

  it('does not confuse a number with its string form', () => {
    expect(comparable(1)).not.toBe(comparable('1'));
  });

  it('ignores object key ORDER but not object content', () => {
    expect(comparable({ a: 1, b: 2 })).toBe(comparable({ b: 2, a: 1 }));
    expect(comparable({ a: 1 })).not.toBe(comparable({ a: 2 }));
  });
});

describe('the --start-from-empty gate', () => {
  it('REFUSES a fresh run whose target already holds rows', async () => {
    await seedAndCopy(1);
    await expect(assertTargetsEmpty(getDb(), ['mutes'])).rejects.toThrow(TargetNotEmptyError);
    // The message has to name what to do, or an operator under pressure
    // reaches for something worse.
    await expect(assertTargetsEmpty(getDb(), ['mutes'])).rejects.toThrow(/--start-from-empty/);
  });

  it('permits a fresh run when the target is empty', async () => {
    await expect(assertTargetsEmpty(getDb(), ['mutes'])).resolves.toBeUndefined();
  });

  it('truncates the target AND forgets the checkpoints', async () => {
    await seedAndCopy(2);
    await saveCheckpoint(getDb(), 'mutes', { value: 'aaa', kind: 'string' }, 2);
    expect(await populatedTables(getDb(), ['mutes'])).toHaveLength(1);

    await startFromEmpty(getDb(), ['mutes']);

    expect(await populatedTables(getDb(), ['mutes'])).toStrictEqual([]);
    // Leaving the checkpoint would make the next run resume PAST data it never
    // wrote — the one failure a reset must not leave behind.
    expect((await loadState(getDb())).checkpoints.mutes).toBeUndefined();
  });

  it('is a no-op on an empty table list rather than truncating everything', async () => {
    await seedAndCopy(1);
    await startFromEmpty(getDb(), []);
    const rows = await getDb().execute<{ n: string }>(
      sql`select count(*)::text as n from mutes`
    );
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);
  });
});
