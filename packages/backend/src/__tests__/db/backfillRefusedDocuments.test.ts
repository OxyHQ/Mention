/**
 * A document the transform REFUSES is a finding, not the end of the run.
 *
 * `auditDefaultedColumns` runs the plans' own transforms, so a value `buildRow`
 * will not build arrives as a thrown `BackfillValueError` rather than as a query
 * result. Before this, the first such document ABORTED the whole pass — which
 * made the audit a queue rather than a report: it named exactly one document
 * per run, and each run costs an arm64 rebuild, a task-definition revision, a
 * probe migration and a Fargate task.
 *
 * That cost was paid twice against production for two instances of ONE class,
 * and nothing said whether a third was waiting:
 *
 *   BackfillValueError: preferredPostTypes.text: expected an integer, got 1432.8000000001784
 *   BackfillValueError: interactionCount: expected an integer, got 218.79999999999643
 *
 * Both are fractional affinity accumulators in integer columns, one table
 * apart. Reporting them lets one run enumerate the class.
 *
 * Three properties, and they fail in different directions:
 *
 *  1. the pass CONTINUES and the refusal is reported with a count and ids;
 *  2. it still BLOCKS — the copy genuinely cannot write that row;
 *  3. an error that is NOT a `BackfillValueError` still aborts, because that is
 *     a defect in the migration rather than a fact about the data.
 *
 * Fixtures are `brd-` prefixed.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import {
  auditDefaultedColumns,
  auditWouldBlockCopy,
  recordRefusedDocument,
  refusedDocumentFindings,
  type AuditFinding,
  type RefusedDocuments,
} from '../../db/backfill/audit';
import { auditReferentialIntegrity } from '../../db/backfill/referentialIntegrity';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import { mongoSourceFromDb, type MongoSource } from '../../db/backfill/mongoSource';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { buildRow } from '../../db/backfill/rowBuilder';
import { pushTokens } from '../../db/schema/discovery';
import { BackfillValueError, ownId, reqInt, reqStr } from '../../db/backfill/values';
import type { CollectionPlan } from '../../db/backfill/plan';
import {
  createResolutionContext,
  planResolutions,
  ResolutionLog,
} from '../../db/backfill/resolutions';

let mongod: MongoMemoryServer;
let client: MongoClient;
let mongo: Db;
let source: MongoSource;

const OWNER = 'brd-u1';

const planFor = (collection: string) => {
  const plan = COLLECTION_PLANS.find((entry) => entry.collection === collection);
  if (!plan) throw new Error(`no plan for ${collection}`);
  return plan;
};

/**
 * A plan whose transform refuses any document carrying a non-integer `weight`.
 *
 * Synthetic because the production instances are integer COLUMNS being widened
 * as they are found — a fixture pinned to one of them would go green the moment
 * that column changed, while the behaviour under test (what the pass does with
 * a refusal) is unchanged. `reqInt` is the real refusing function.
 */
const refusesFractionalWeight: CollectionPlan = {
  collection: 'pushtokens',
  table: pushTokens,
  transform: (doc, emit) => {
    // Throws `BackfillValueError` for a fractional value, exactly as
    // `userProfile`'s transform does for `interactionCount`.
    reqInt(doc, 'weight');
    emit(
      pushTokens,
      buildRow(
        pushTokens,
        {
          id: ownId(doc),
          userId: reqStr(doc, 'userId'),
          token: reqStr(doc, 'token'),
          type: 'fcm',
          platform: 'ios',
        },
        ownId(doc)
      )
    );
  },
};

/** The same plan, throwing something that is NOT a value error. */
const throwsProgrammerError: CollectionPlan = {
  ...refusesFractionalWeight,
  transform: () => {
    throw new TypeError('brd-not-a-value-error');
  },
};

async function audit(plan: CollectionPlan) {
  return auditDefaultedColumns(
    source,
    plan,
    createResolutionContext(await planResolutions(source), new ResolutionLog())
  );
}

const refusal = (findings: readonly AuditFinding[]) =>
  findings.find((finding) => finding.kind === 'refused-document');

beforeAll(async () => {
  await connectPostgres();
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  mongo = client.db('backfill_refused_documents_test');
  source = mongoSourceFromDb(mongo, async () => {
    await client.close();
  });
}, 120_000);

afterEach(async () => {
  await mongo.collection('pushtokens').deleteMany({});
  await mongo.collection('gifs').deleteMany({});
  await mongo.collection('moderation_outbox').deleteMany({});
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
  await closePostgres();
});

describe('a refused document', () => {
  it('is REPORTED with its count and ids, and the pass reaches the documents after it', async () => {
    const first = new ObjectId();
    const second = new ObjectId();
    await mongo.collection('pushtokens').insertMany([
      { _id: first, userId: OWNER, token: 'brd-1', weight: 218.79999999999643 },
      { _id: second, userId: OWNER, token: 'brd-2', weight: 1432.8000000001784 },
      // Sits AFTER both refusals: before the catch, the pass died on the first
      // document and this one was never read at all.
      { _id: new ObjectId(), userId: OWNER, token: 'brd-3', weight: 7 },
    ]);

    const finding = refusal(await audit(refusesFractionalWeight));

    expect(finding).toBeDefined();
    // TWO of three — one finding for the path, counting every document it
    // refused rather than stopping at the first.
    expect(finding?.documents).toBe(2);
    expect(finding?.sampleIds.sort()).toEqual([String(first), String(second)].sort());
    // The message keeps the value that was refused, which is what identifies
    // the class: a float in an integer column, not a corrupt row.
    expect(finding?.detail).toContain('expected an integer');
    expect(finding?.detail).toContain('weight');
  });

  it('BLOCKS the copy', async () => {
    // Reporting instead of aborting changes WHEN it is learned, never whether
    // it stops the copy.
    await mongo
      .collection('pushtokens')
      .insertOne({ _id: new ObjectId(), userId: OWNER, token: 'brd-4', weight: 0.5 });

    const finding = refusal(await audit(refusesFractionalWeight));
    expect(auditWouldBlockCopy(finding as AuditFinding)).toBe(true);
  });

  it('says nothing when every document builds', async () => {
    await mongo
      .collection('pushtokens')
      .insertOne({ _id: new ObjectId(), userId: OWNER, token: 'brd-5', weight: 3 });

    expect(refusal(await audit(refusesFractionalWeight))).toBeUndefined();
  });
});

describe('the tally itself', () => {
  it('keeps two collections APART when they refuse at the same path', () => {
    // Asserted against ONE tally, which is the only place the keying can be
    // observed. The end-to-end case below runs `auditDefaultedColumns` twice —
    // once per plan — so each call builds its OWN map and a path-only key would
    // never collapse anything there. Measured: with the key mutated to the path
    // alone, that case stayed GREEN and this one goes red. A test that cannot
    // see the defect it names is the failure this whole change is about.
    const refused: RefusedDocuments = new Map();
    recordRefusedDocument(refused, 'pushtokens', new BackfillValueError('weight', 'expected an integer, got 0.25'), 'id-a');
    recordRefusedDocument(refused, 'gifs', new BackfillValueError('weight', 'expected an integer, got 0.75'), 'id-b');

    expect(refused.size).toBe(2);
    const findings = refusedDocumentFindings(refused);
    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.collection)).toEqual(['gifs', 'pushtokens']);
    expect(findings.every((finding) => finding.documents === 1)).toBe(true);
  });

  it('MERGES two documents of one collection refusing at the same path', () => {
    // The other direction, and the reason the key is a pair rather than the
    // document id: one defect however many rows carry it.
    const refused: RefusedDocuments = new Map();
    recordRefusedDocument(refused, 'pushtokens', new BackfillValueError('weight', 'm'), 'id-a');
    recordRefusedDocument(refused, 'pushtokens', new BackfillValueError('weight', 'm'), 'id-b');

    expect(refused.size).toBe(1);
    const [finding] = refusedDocumentFindings(refused);
    expect(finding.documents).toBe(2);
    expect(finding.sampleIds).toEqual(['id-a', 'id-b']);
  });
});

describe('two collections refusing at the same field name', () => {
  it('reports BOTH, because the key is (collection, path) and not path alone', async () => {
    // The failure mode this guards is precisely the one the whole change exists
    // to remove: reporting one and leaving the other for the next round. Two
    // collections refusing at the SAME field name is the case where a
    // path-keyed tally silently collapses them into one.
    const inPushTokens = new ObjectId();
    const inGifs = new ObjectId();
    await mongo
      .collection('pushtokens')
      .insertOne({ _id: inPushTokens, userId: OWNER, token: 'brd-7', weight: 0.25 });
    await mongo.collection('gifs').insertOne({ _id: inGifs, klipyId: 'brd-gif', weight: 0.75 });

    const other: CollectionPlan = { ...refusesFractionalWeight, collection: 'gifs' };
    const findings = [
      ...(await audit(refusesFractionalWeight)),
      ...(await audit(other)),
    ].filter((finding) => finding.kind === 'refused-document');

    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.collection).sort()).toEqual(['gifs', 'pushtokens']);
    // Each names its OWN collection and path — a reader must not have to guess
    // which of two identically-worded findings belongs to which collection.
    for (const finding of findings) {
      expect(finding.detail).toContain(`${finding.collection}.weight REFUSED 1 document(s)`);
    }
    expect(findings.flatMap((finding) => finding.sampleIds).sort()).toEqual(
      [String(inPushTokens), String(inGifs)].sort()
    );
  });
});

describe('the referential pass, which runs the transforms too', () => {
  it('REPORTS the refusal instead of aborting, so fixing one pass does not just move the queue', async () => {
    // Without this the change would have been half a fix: `auditDefaultedColumns`
    // runs FIRST and its findings block, so the moment those cleared, the first
    // refused document would have aborted referential integrity instead — the
    // same queue, one pass along. Mutation-tested: re-throwing here leaves every
    // other test in the suite green.
    //
    // `moderation_outbox` is used because its plan carries a real foreign key,
    // so the pass has relations to derive and does not trip its own vacuity
    // floor — a refusal reported by a pass that inspected nothing would prove
    // nothing.
    const refusedId = new ObjectId();
    await mongo.collection('moderation_outbox').insertOne({
      _id: refusedId,
      kind: 'report.submit',
      payload: { reportId: new ObjectId().toHexString() },
      status: 'pending',
      // `attempts` is an integer column; a fraction is refused exactly as
      // `interactionCount` is in production.
      attempts: 2.5,
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    });

    const report = await auditReferentialIntegrity(
      getDb(),
      source,
      [
        { plan: planFor('reports'), documents: 0 },
        { plan: planFor('moderation_outbox'), documents: 1 },
      ],
      createResolutionContext(await planResolutions(source), new ResolutionLog())
    );

    const finding = report.findings.find((entry) => entry.kind === 'refused-document');
    expect(finding).toBeDefined();
    expect(finding?.collection).toBe('moderation_outbox');
    expect(finding?.documents).toBe(1);
    expect(finding?.sampleIds).toEqual([String(refusedId)]);
    // ONE finding, not two: phase 2 re-runs the same transforms over the same
    // documents, and recording there as well would double every count.
    expect(report.findings.filter((entry) => entry.kind === 'refused-document')).toHaveLength(1);
    expect(auditWouldBlockCopy(finding as AuditFinding)).toBe(true);
  });
});

describe('an error that is not about the data', () => {
  it('still ABORTS the pass', async () => {
    // A `TypeError` from a transform is a defect in the migration, and
    // continuing past it would report on rows built by code already known to be
    // wrong. Only `BackfillValueError` names a document.
    await mongo
      .collection('pushtokens')
      .insertOne({ _id: new ObjectId(), userId: OWNER, token: 'brd-6', weight: 1 });

    await expect(audit(throwsProgrammerError)).rejects.toThrow('brd-not-a-value-error');
  });

  it('is not a BackfillValueError, which is what the catch keys on', () => {
    // Guards the discriminator itself: if `BackfillValueError` stopped being
    // its own class, the catch above would swallow programmer errors and the
    // abort case would silently become a finding.
    expect(new BackfillValueError('p', 'm') instanceof BackfillValueError).toBe(true);
    expect(new TypeError('x') instanceof BackfillValueError).toBe(false);
  });
});
