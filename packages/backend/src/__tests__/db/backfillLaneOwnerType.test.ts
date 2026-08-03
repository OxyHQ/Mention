/**
 * `lanes.ownerType`, and a rule whose PREMISE is re-measured every run.
 *
 * The field is absent from production's only lane because the writer on `main`
 * never set it — `ownerType` appears nowhere in `lanes.routes.ts` — so the
 * discriminator every lane query scopes by is missing and that lane is
 * invisible to its own owner. `NOT NULL` with no default, so the copy is
 * refused over it.
 *
 * The value is DERIVED rather than chosen: `ownerType` ranges over exactly two
 * possibilities and `'channel'` requires a channel to own it, so a source
 * holding NO channels leaves one. That is a fact about the data, which is
 * precisely why it must not become `absentAs` — a declared substitute keeps
 * answering after its premise expires, and a channel-owned lane is a thing the
 * product supports. The rule therefore stands down the moment any channel
 * exists, and the lane goes back to blocking for a human.
 *
 * So the two cases that matter are opposites, and a change that merely stopped
 * reporting would satisfy only the first:
 *
 *  1. no channels ⇒ the lane is answered and the copy is not blocked;
 *  2. ANY channel ⇒ the rule is silent and the lane blocks again.
 *
 * Fixtures are `blo-` prefixed; every id is scoped to this file.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { auditEnums, auditWouldBlockCopy, type AuditFinding } from '../../db/backfill/audit';
import { mongoSourceFromDb, type MongoSource } from '../../db/backfill/mongoSource';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import { copyCollection } from '../../db/backfill/runner';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { lanes } from '../../db/schema/channels';
import { eq } from 'drizzle-orm';
import {
  createResolutionContext,
  parentKeysFrom,
  planResolutions,
  ResolutionLog,
} from '../../db/backfill/resolutions';

let mongod: MongoMemoryServer;
let client: MongoClient;
let mongo: Db;

/**
 * A source whose collection list is taken NOW.
 *
 * `mongoSourceFromDb` memoizes `listCollections()` for the lifetime of the
 * handle, which is right for a run — the audit and the copy must agree about
 * what the source contained — and wrong for a suite, where one test creating
 * `channels` after another has already listed would be invisible to the second.
 * A fresh handle per test makes each case measure its own fixture instead of
 * inheriting the previous one's snapshot.
 */
const freshSource = (): MongoSource => mongoSourceFromDb(mongo, async () => undefined);

const OWNER = 'blo-owner-1';
const LANE_NAME = 'blo-lane';
const LANE_ID = new ObjectId('b10b10b10b10b10b10b10b10');

const planFor = (collection: string) => {
  const plan = COLLECTION_PLANS.find((entry) => entry.collection === collection);
  if (!plan) throw new Error(`no plan for ${collection}`);
  return plan;
};

/** The lane production actually holds: everything but `ownerType`. */
async function insertLaneWithoutOwnerType(): Promise<void> {
  await mongo.collection('lanes').insertOne({
    _id: LANE_ID,
    ownerId: OWNER,
    name: LANE_NAME,
    nameLower: LANE_NAME,
    createdAt: new Date('2026-07-30T00:00:00.000Z'),
    updatedAt: new Date('2026-07-30T00:00:00.000Z'),
  });
}

const laneFinding = (findings: readonly AuditFinding[]) =>
  findings.find((finding) => finding.detail.startsWith('lanes.ownerType is MISSING'));

beforeAll(async () => {
  await connectPostgres();
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  mongo = client.db('backfill_lane_owner_test');
}, 120_000);

afterEach(async () => {
  await getDb().delete(lanes).where(eq(lanes.name, LANE_NAME));
  await mongo.collection('lanes').deleteMany({});
  await mongo.collection('channels').deleteMany({});
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
  await closePostgres();
});

describe('with no channels in the source', () => {
  it('answers the finding rather than blocking, and reports the lane by id', async () => {
    await insertLaneWithoutOwnerType();

    const source = freshSource();
    const resolutions = createResolutionContext(await planResolutions(source), new ResolutionLog());
    const finding = laneFinding(await auditEnums(source, planFor('lanes'), resolutions));

    // Still computed, still counted, still printed — a rule answers a finding,
    // it does not delete one.
    expect(finding).toBeDefined();
    expect(finding?.documents).toBe(1);
    expect(finding?.resolvedBy?.id).toBe('derive-lane-owner-type');
    expect(auditWouldBlockCopy(finding as AuditFinding)).toBe(false);
    expect(resolutions.actedOn.get('derive-lane-owner-type')?.has(String(LANE_ID))).toBe(true);
  });

  it("copies the lane as 'user' and records what it inferred", async () => {
    await insertLaneWithoutOwnerType();

    const log = new ResolutionLog();
    const source = freshSource();
    await copyCollection(planFor('lanes'), {
      db: getDb(),
      source,
      resolutions: createResolutionContext(await planResolutions(source), log),
      parents: parentKeysFrom(new Map()),
    });

    const rows = await getDb().select().from(lanes).where(eq(lanes.name, LANE_NAME));
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerType).toBe('user');
    expect(rows[0].ownerId).toBe(OWNER);

    // A value the source never held has to leave a trace, or the migration
    // invented one silently.
    const summary = log.summary().find((entry) => entry.rule.id === 'derive-lane-owner-type');
    expect(summary?.documents).toBe(1);
    expect(summary?.records[0].documentId).toBe(String(LANE_ID));
    expect(summary?.records[0].evidence).toStrictEqual({
      'lanes.ownerId': OWNER,
      'lanes.ownerType (written)': 'user',
    });
  });
});

describe('as soon as the source holds ANY channel', () => {
  it('stands down entirely, and the lane blocks again', async () => {
    // The premise is gone: with a channel in existence an absent `ownerType`
    // stops being derivable and becomes a question about WHICH owner. One
    // channel is enough, and it need not be related to this lane — the rule
    // refuses to guess rather than refusing per-lane, because "which lanes
    // might this channel own" is exactly the judgement it is not entitled to.
    await insertLaneWithoutOwnerType();
    await mongo.collection('channels').insertOne({
      _id: new ObjectId(),
      handle: 'blo-channel',
      name: 'blo channel',
      ownerOxyUserId: OWNER,
    });

    const source = freshSource();
    const resolutions = createResolutionContext(await planResolutions(source), new ResolutionLog());
    const finding = laneFinding(await auditEnums(source, planFor('lanes'), resolutions));

    expect(resolutions.actedOn.get('derive-lane-owner-type')?.size ?? 0).toBe(0);
    expect(finding).toBeDefined();
    expect(finding?.resolvedBy).toBeUndefined();
    expect(auditWouldBlockCopy(finding as AuditFinding)).toBe(true);
  });
});

describe('a lane that already carries ownerType', () => {
  it('is copied verbatim and the rule records nothing', async () => {
    // NARROW BY CONSTRUCTION: the rule reaches only documents the pre-pass
    // claimed, so a lane the source already answered is untouched — including a
    // channel-owned one, which is the value the rule can never infer.
    await mongo.collection('lanes').insertOne({
      _id: LANE_ID,
      ownerType: 'channel',
      ownerId: OWNER,
      name: LANE_NAME,
      nameLower: LANE_NAME,
    });

    const log = new ResolutionLog();
    const source = freshSource();
    await copyCollection(planFor('lanes'), {
      db: getDb(),
      source,
      resolutions: createResolutionContext(await planResolutions(source), log),
      parents: parentKeysFrom(new Map()),
    });

    const rows = await getDb().select().from(lanes).where(eq(lanes.name, LANE_NAME));
    expect(rows[0].ownerType).toBe('channel');
    expect(log.summary().find((entry) => entry.rule.id === 'derive-lane-owner-type')?.documents ?? 0).toBe(0);
    expect(laneFinding(await auditEnums(source, planFor('lanes'), createResolutionContext(await planResolutions(source), new ResolutionLog())))).toBeUndefined();
  });
});
