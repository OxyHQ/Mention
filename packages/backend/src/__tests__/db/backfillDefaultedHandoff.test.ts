/**
 * The hand-off between the two audits that both look at an absent field.
 *
 * `auditMissingRequired` (reached through `auditEnums`/`auditNumerics`) predicts
 * a `23502`. A `NOT NULL` column carrying a DEFAULT cannot produce one — the
 * transform omits the value, Postgres supplies it, the row inserts. So the
 * probe used to assert a rejection that could not happen, and the price was not
 * a wrong sentence in a report: **every finding blocks, and
 * `auditDefaultedColumns` runs only once nothing blocks**, so a false `23502`
 * gated out the exact pass that owns a defaulted column.
 *
 * Measured against production, `posts.replyPermission` was the entire live
 * effect at 147,198 documents; `mutewords.targets` is the only other column of
 * that shape and holds none.
 *
 * What the defaulted pass asks instead is the question the case really raises:
 * not "would this row be rejected" but "is a value nobody chose about to land
 * with nothing left to notice it afterwards". It still BLOCKS — deliberately,
 * and for a reason written out in `auditWouldBlockCopy` — but the way past it is
 * a decision recorded in the plan rather than a data fix that would change
 * nothing.
 *
 * Both directions are asserted, because a change that merely stopped reporting
 * would satisfy the first alone. Fixtures are `bdh-` prefixed.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import {
  auditEnums,
  auditDefaultedColumns,
  auditWouldBlockCopy,
  type AuditFinding,
} from '../../db/backfill/audit';
import { mongoSourceFromDb, type MongoSource } from '../../db/backfill/mongoSource';
import { closePostgres, connectPostgres } from '../../db/postgres';
import { buildRow, tableShape } from '../../db/backfill/rowBuilder';
import { pushTokens } from '../../db/schema/discovery';
import { ownId, reqStr, str } from '../../db/backfill/values';
import type { CollectionPlan } from '../../db/backfill/plan';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import {
  createResolutionContext,
  planResolutions,
  ResolutionLog,
} from '../../db/backfill/resolutions';

let mongod: MongoMemoryServer;
let client: MongoClient;
let mongo: Db;
let source: MongoSource;

const OWNER = 'bdh-u1';
const TOKEN = 'bdh-token-1';

/**
 * A plan whose transform OMITS a `NOT NULL DEFAULT` enum column.
 *
 * `push_tokens.type` is `NOT NULL DEFAULT 'unknown'` in the real schema, so the
 * shape is real even though the real plan supplies the value — which is the
 * point: the hand-off has to work for a plan that does not, and today no
 * shipped plan is in that position. Building it here is what makes the
 * behaviour testable at all rather than asserted about a case with no instance.
 */
const omitsDefaultedType: CollectionPlan = {
  collection: 'pushtokens',
  table: pushTokens,
  enumAudits: [{ path: 'type', column: pushTokens.type }],
  transform: (doc, emit) => {
    emit(
      pushTokens,
      buildRow(
        pushTokens,
        {
          id: ownId(doc),
          userId: reqStr(doc, 'userId'),
          token: reqStr(doc, 'token'),
          platform: str(doc, 'platform') ?? 'unknown',
          // `type` deliberately absent — this is the case under test.
        },
        ownId(doc)
      )
    );
  },
};

async function defaulted(plan: CollectionPlan) {
  return auditDefaultedColumns(
    source,
    plan,
    createResolutionContext(await planResolutions(source), new ResolutionLog())
  );
}

beforeAll(async () => {
  await connectPostgres();
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  mongo = client.db('backfill_defaulted_handoff_test');
  source = mongoSourceFromDb(mongo, async () => {
    await client.close();
  });
}, 120_000);

afterEach(async () => {
  await mongo.collection('pushtokens').deleteMany({});
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
  await closePostgres();
});

describe('the shape this is about', () => {
  it('is a NOT NULL column that carries a DEFAULT', () => {
    // If this stopped being true the test below would pass for the wrong
    // reason — silence from a column that was never defaulted at all.
    expect(pushTokens.type.notNull).toBe(true);
    expect(pushTokens.type.hasDefault).toBe(true);
    expect(tableShape(pushTokens).defaulted.has('type')).toBe(true);
  });
});

describe('auditEnums, on a defaulted column whose source field is absent', () => {
  it('does NOT claim a 23502 Postgres would never raise', async () => {
    await mongo
      .collection('pushtokens')
      .insertOne({ _id: new ObjectId(), userId: OWNER, token: TOKEN, platform: 'android' });

    expect(await auditEnums(source, omitsDefaultedType)).toEqual([]);
  });
});

describe('auditDefaultedColumns picks it up', () => {
  it('reports the omission with its count and its sample ids', async () => {
    const kept = new ObjectId();
    await mongo.collection('pushtokens').insertMany([
      { _id: kept, userId: OWNER, token: TOKEN, platform: 'android' },
      { _id: new ObjectId(), userId: OWNER, token: `${TOKEN}-2`, platform: 'ios' },
    ]);

    const findings = await defaulted(omitsDefaultedType);
    const type = findings.find((finding) => finding.detail.startsWith('push_tokens.type'));

    expect(type).toBeDefined();
    expect(type?.kind).toBe('defaulted-column');
    // The count is the whole reason this pass exists — "some row somewhere"
    // would not let anyone tell two rows from two hundred thousand.
    expect(type?.documents).toBe(2);
    expect(type?.sampleIds).toContain(String(kept));
    // It still stops the copy, by design: Postgres ACCEPTS this row, so an
    // un-blocked finding is a value nobody chose landing in production. The way
    // past is a decision recorded in the plan, not a data fix.
    expect(auditWouldBlockCopy(type as AuditFinding)).toBe(true);
  });

  it('says nothing when the transform supplies the value itself', async () => {
    // The REAL `pushtokens` plan, which writes `type` rather than leaving it to
    // the database. A transform that decides is not a silent default, so
    // NEITHER audit has anything to say — which is what makes this a hand-off
    // rather than a second place to be noisy. It is also why the change removed
    // a finding from production entirely instead of moving one: both columns of
    // this shape are supplied by their transforms today.
    const real = COLLECTION_PLANS.find((entry) => entry.collection === 'pushtokens');
    if (!real) throw new Error('no plan for pushtokens');
    await mongo
      .collection('pushtokens')
      .insertOne({ _id: new ObjectId(), userId: OWNER, token: TOKEN, platform: 'android' });

    expect(await auditEnums(source, real)).toEqual([]);
    const findings = await defaulted(real);
    expect(findings.some((finding) => finding.detail.startsWith('push_tokens.type'))).toBe(false);
  });
});
