/**
 * `adminscriptcursors` and `repairfetchfailures` — resume state for the
 * destructive one-shot sweeps.
 *
 * These copy because of what their ABSENCE causes an operator to DO.
 * `completed_at` is the record that a destructive sweep ran to exhaustion; lose
 * it and "already purged" becomes indistinguishable from "never ran", and the
 * recovery a reasonable person reaches for is re-running the sweep.
 *
 * ## The dangerous column, and the direction of its harm
 *
 * `completed_at` is an instance of the shape this migration keeps meeting: a
 * value meaning "I could not tell" consumed as one meaning "there is nothing".
 * NULL means NOT KNOWN TO HAVE FINISHED — stopped on a limit, died mid-page, or
 * still running.
 *
 * Its harm points the OPPOSITE way from the usual one, which is why it gets its
 * own case. An invented `completed_at` fails toward SILENCE (a purge quietly not
 * re-run); a missing one fails toward WORK (a purge re-run unnecessarily).
 * Between a destructive sweep skipped and one repeated, only the second is
 * recoverable, and the copy must never be the thing that chooses.
 *
 * Fixtures are `bfa-` prefixed and every cleanup is SCOPED.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { adminScriptCursors, repairFetchFailures } from '../../db/schema/adminScripts';
import { mongoSourceFromDb, type MongoSource } from '../../db/backfill/mongoSource';
import { copyCollection } from '../../db/backfill/runner';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import {
  createResolutionContext,
  parentKeysFrom,
  planResolutions,
  ResolutionLog,
} from '../../db/backfill/resolutions';

let mongod: MongoMemoryServer;
let client: MongoClient;
let mongo: Db;
let source: MongoSource;

/** Scoped to this file — see the header. */
const SCRIPT = 'bfa-purge-sweep';

const planFor = (collection: string) => {
  const plan = COLLECTION_PLANS.find((entry) => entry.collection === collection);
  if (!plan) throw new Error(`no plan for ${collection}`);
  return plan;
};

async function copy(collection: string) {
  return copyCollection(planFor(collection), {
    db: getDb(),
    source,
    resolutions: createResolutionContext(await planResolutions(source), new ResolutionLog()),
    parents: parentKeysFrom(new Map()),
  });
}

beforeAll(async () => {
  await connectPostgres();
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  mongo = client.db('backfill_admin_scripts_test');
  source = mongoSourceFromDb(mongo, async () => {
    await client.close();
  });
}, 120_000);

afterEach(async () => {
  const db = getDb();
  await db.delete(adminScriptCursors).where(eq(adminScriptCursors.script, SCRIPT));
  await db.delete(repairFetchFailures).where(eq(repairFetchFailures.script, SCRIPT));
  for (const name of await mongo.listCollections({}, { nameOnly: true }).toArray()) {
    await mongo.collection(name.name).deleteMany({});
  }
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
  await closePostgres();
});

describe('admin script cursors', () => {
  it('keeps completed_at NULL for a sweep that has not finished', async () => {
    const id = new ObjectId();
    await mongo.collection('adminscriptcursors').insertOne({
      _id: id,
      script: SCRIPT,
      scope: 'bfa-shard-0',
      cursor: '65f0000000000000000000aa',
      scanned: 1200,
      // `completedAt` ABSENT — the sweep stopped on a limit or died mid-page.
      // This is the state the whole case exists for, and the fixture must NOT
      // supply the field: a fixture that always sets it cannot test its default.
    });
    await copy('adminscriptcursors');

    const [row] = await getDb()
      .select()
      .from(adminScriptCursors)
      .where(eq(adminScriptCursors.id, id.toHexString()));

    // NULL is "not known to have finished". A substituted timestamp would tell
    // an operator a DESTRUCTIVE sweep completed when it did not, and the harm
    // points toward silence — a purge quietly never re-run.
    expect(row?.completedAt).toBeNull();
    expect(row?.scanned).toBe(1200);
  });

  it('keeps completed_at when the sweep really did finish', async () => {
    const id = new ObjectId();
    const completedAt = new Date('2025-08-08T00:00:00.000Z');
    await mongo.collection('adminscriptcursors').insertOne({
      _id: id,
      script: SCRIPT,
      scope: 'bfa-shard-1',
      cursor: '65f0000000000000000000bb',
      scanned: 46291,
      completedAt,
    });
    await copy('adminscriptcursors');

    const [row] = await getDb()
      .select()
      .from(adminScriptCursors)
      .where(eq(adminScriptCursors.id, id.toHexString()));

    // The negative control for the case above: without it, a transform that
    // always wrote NULL would pass the first case and lose every completion
    // record — the failure that makes an operator re-run a destructive sweep.
    expect(row?.completedAt).toStrictEqual(completedAt);
  });

  it('carries the cursor verbatim, because it is a row id', async () => {
    const id = new ObjectId();
    await mongo.collection('adminscriptcursors').insertOne({
      _id: id,
      script: SCRIPT,
      scope: 'bfa-shard-2',
      cursor: '65f0000000000000000000cc',
      scanned: 7,
    });
    await copy('adminscriptcursors');

    const [row] = await getDb()
      .select()
      .from(adminScriptCursors)
      .where(eq(adminScriptCursors.id, id.toHexString()));

    // Ids are preserved verbatim by this migration, so the position keeps
    // meaning the same row after the cutover. That is the whole reason the ROW
    // is portable and not merely the table.
    expect(row?.cursor).toBe('65f0000000000000000000cc');
  });

  it('REFUSES a cursor row with no position rather than resuming from the start', async () => {
    await mongo.collection('adminscriptcursors').insertOne({
      _id: new ObjectId(),
      script: SCRIPT,
      scope: 'bfa-shard-3',
      scanned: 3,
    });

    // An invented position — the empty string, the zero id — would resume from
    // the START of a range the sweep already walked, re-doing destructive work.
    await expect(copy('adminscriptcursors')).rejects.toThrow(/cursor/);
  });
});

describe('repair fetch failures', () => {
  it('keeps status NULL for a failure that never saw one', async () => {
    const id = new ObjectId();
    await mongo.collection('repairfetchfailures').insertOne({
      _id: id,
      script: SCRIPT,
      postId: '65f0000000000000000000dd',
      reason: 'timeout',
      // No `status`: a timeout never got an answer to record. Absent on purpose
      // — see the note on the previous file about fixtures that always supply.
      failedAt: new Date('2025-08-01T00:00:00.000Z'),
    });
    await copy('repairfetchfailures');

    const [row] = await getDb()
      .select()
      .from(repairFetchFailures)
      .where(eq(repairFetchFailures.id, id.toHexString()));

    // NULL is meaningful: `status` is what separates "retry politely" (429, 5xx)
    // from "do not come back" (403, 401) INSIDE the single `httpStatus` reason.
    // A defaulted 0 or 500 would invent a remote answer and move the row across
    // that line.
    expect(row?.status).toBeNull();
    expect(row?.reason).toBe('timeout');
  });

  it('keeps the status when the transport got far enough to see one', async () => {
    const id = new ObjectId();
    await mongo.collection('repairfetchfailures').insertOne({
      _id: id,
      script: SCRIPT,
      postId: '65f0000000000000000000ee',
      reason: 'httpStatus',
      status: 410,
      failedAt: new Date('2025-08-01T00:00:00.000Z'),
    });
    await copy('repairfetchfailures');

    const [row] = await getDb()
      .select()
      .from(repairFetchFailures)
      .where(eq(repairFetchFailures.id, id.toHexString()));

    // 410 is the "do not come back" end of the range — a targeted retry must be
    // able to tell it from a 429.
    expect(row?.status).toBe(410);
  });

  it('REFUSES a failure with no failedAt rather than dating it to the migration', async () => {
    await mongo.collection('repairfetchfailures').insertOne({
      _id: new ObjectId(),
      script: SCRIPT,
      postId: '65f0000000000000000000ff',
      reason: 'transport',
    });

    // The row's whole claim is that a fetch failed AT a time, and a consumer
    // intersects these with the live candidate filter. An invented `now()` would
    // make every migrated failure look like it happened during the migration.
    await expect(copy('repairfetchfailures')).rejects.toThrow(/failedAt/);
  });
});
