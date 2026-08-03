/**
 * The referential pass over a source that is still being written.
 *
 * It reads the collections TWICE — once to build the set of keys the migration
 * will produce, once to check every reference against that set. Production does
 * not stop between the two, and without a bound the second pass sees documents
 * the first never captured and reports their references as orphans.
 *
 * That is not hypothetical. The 2026-08-03 production run reported 407 orphan
 * rows across five relations — `post_attachments`, `post_authorships`,
 * `post_content_variants`, `post_media`, `post_mentions` — whose parent rows are
 * built from arrays EMBEDDED IN the same document that produces them, so an
 * orphan is structurally impossible. Every one of those ids had been written
 * inside the run's last four minutes, and every parent was present in Mongo the
 * whole time. The audit was answering about two different databases.
 *
 * The fix is a bound rather than a single pass, because it makes the CLAIM
 * honest rather than merely quiet: a gate over a live source cannot say
 * "everything", but it can say "everything that existed when I started", and
 * phase 1's greatest `_id` is that sentence in code.
 *
 * Two properties, and the second is the one a fix could easily miss:
 *
 *  1. a document written between the passes does not become an orphan;
 *  2. it is COUNTED and reported — a silent bound is a vacuity floor, because a
 *     run that declined to read forty thousand documents would otherwise read
 *     as a run that found them clean.
 *
 * Fixtures are `blsb-` prefixed.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { auditReferentialIntegrity } from '../../db/backfill/referentialIntegrity';
import { mongoSourceFromDb, type MongoSource } from '../../db/backfill/mongoSource';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import {
  createResolutionContext,
  planResolutions,
  ResolutionLog,
} from '../../db/backfill/resolutions';

let mongod: MongoMemoryServer;
let client: MongoClient;
let mongo: Db;
let source: MongoSource;

const planFor = (collection: string) => {
  const plan = COLLECTION_PLANS.find((entry) => entry.collection === collection);
  if (!plan) throw new Error(`no plan for ${collection}`);
  return plan;
};

/**
 * A source that INSERTS a document the first time a collection is streamed.
 *
 * The race cannot be reproduced by seeding Mongo up front — the whole point is a
 * write that lands after phase 1 has passed that collection and before phase 2
 * reaches it. Wrapping `collection()` is the only seam that can do that from a
 * test, and it writes through the same driver handle the audit reads, so the
 * document is as real as any other.
 */
function sourceThatWritesBetweenPasses(inner: MongoSource, collection: string, doc: object): MongoSource {
  let streamed = 0;
  return {
    listCollections: () => inner.listCollections(),
    count: (name) => inner.count(name),
    close: () => inner.close(),
    collection(name) {
      const handle = inner.collection(name);
      if (name !== collection) return handle;
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property !== 'find') return Reflect.get(target, property, receiver);
          return (...args: Parameters<typeof handle.find>) => {
            streamed += 1;
            const cursor = handle.find(...args);
            // Phase 1's scan: nothing to do.
            if (streamed !== 2) return cursor;
            // Phase 2's. The write is AWAITED inside the iterator rather than
            // fired off beside it: an un-awaited insert lands whenever it lands,
            // which makes the race a coin flip AND leaks the document into the
            // next test. Deferring it into the first `next()` puts it exactly
            // where production puts it — after the key set, before the check.
            // `batchSize()` must return the WRAPPER, not the cursor.
            // `streamCollection` calls `.find(...).batchSize(n)` and iterates
            // what THAT returns, so handing back the real cursor discards the
            // wrapper, the insert never runs, and the test passes its two
            // orphan assertions vacuously — which is exactly what it did.
            const wrapper = {
              batchSize: () => wrapper,
              async *[Symbol.asyncIterator]() {
                await mongo.collection(collection).insertOne(doc as never);
                yield* cursor;
              },
            };
            return wrapper as unknown as typeof cursor;
          };
        },
      }) as typeof handle;
    },
  };
}

beforeAll(async () => {
  await connectPostgres();
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  mongo = client.db('backfill_live_source_bound_test');
  source = mongoSourceFromDb(mongo, async () => {
    await client.close();
  });
}, 120_000);

afterEach(async () => {
  await mongo.collection('moderation_outbox').deleteMany({});
  await mongo.collection('reports').deleteMany({});
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
  await closePostgres();
});

async function audit(from: MongoSource) {
  return auditReferentialIntegrity(
    getDb(),
    from,
    [
      { plan: planFor('reports'), documents: 1 },
      { plan: planFor('moderation_outbox'), documents: 1 },
    ],
    createResolutionContext(await planResolutions(from), new ResolutionLog())
  );
}

/** A report whose `reportId` names a report that DOES exist. */
const outboxFor = (reportId: ObjectId) => ({
  _id: new ObjectId(),
  kind: 'report.submit',
  payload: { reportId: reportId.toHexString() },
  status: 'pending',
  attempts: 0,
  expiresAt: new Date('2030-01-01T00:00:00.000Z'),
});

/**
 * The field is `reporter`, not `reporterId`.
 *
 * Worth the comment: the first draft used `reporterId`, the plan refused the
 * document, its key was never emitted, and the outbox row that pointed at it
 * came back as an ORPHAN — a fixture bug wearing the exact costume of the
 * finding under test. It surfaced as a finding rather than a crash only because
 * of the refused-document catch added a few commits earlier.
 */
const reportDoc = (id: ObjectId) => ({
  _id: id,
  reporter: 'blsb-reporter',
  reportedId: 'blsb-subject',
  reportedType: 'post',
  categories: ['spam'],
});

describe('a document written between the two passes', () => {
  it('is NOT reported as an orphan, and IS counted as excluded', async () => {
    const seededReport = new ObjectId();
    await mongo.collection('reports').insertOne(reportDoc(seededReport));
    await mongo.collection('moderation_outbox').insertOne(outboxFor(seededReport));

    // Arrives after phase 1 has streamed `moderation_outbox`. Its `reportId`
    // names a report that exists, so the ONLY way it can look like an orphan is
    // the race — which is what makes this fixture discriminating rather than
    // merely late.
    const late = outboxFor(seededReport);
    const report = await audit(
      sourceThatWritesBetweenPasses(source, 'moderation_outbox', late)
    );

    // The insert is the whole fixture, so assert it happened. Without this the
    // two clean assertions below hold just as well when the race was never
    // staged at all.
    expect(await mongo.collection('moderation_outbox').countDocuments({})).toBe(2);

    expect(report.findings.filter((finding) => finding.kind === 'referential-integrity')).toEqual([]);
    expect(report.orphans).toEqual([]);

    // …and the report SAYS it did not read it.
    expect(report.liveSourceBound).toBeDefined();
    expect(report.liveSourceBound?.excluded).toBe(1);
    expect(report.liveSourceBound?.excludedByCollection.get('moderation_outbox')).toBe(1);
  });

  it('reports a bound of zero when nothing is written while it runs', async () => {
    // The quiet case has to be distinguishable from the bounded one, or the
    // report cannot be read: "excluded 0" and "excluded 40,000" are different
    // claims about the same clean verdict.
    const seededReport = new ObjectId();
    await mongo.collection('reports').insertOne(reportDoc(seededReport));
    await mongo.collection('moderation_outbox').insertOne(outboxFor(seededReport));

    const report = await audit(source);

    expect(report.liveSourceBound?.excluded).toBe(0);
    expect(report.liveSourceBound?.excludedByCollection.size).toBe(0);
    expect(report.orphans).toEqual([]);
  });
});

describe('a REAL orphan, which the bound must not hide', () => {
  it('is still reported', async () => {
    // The direction a bound could break: excluding recent documents must not
    // become excluding the evidence. This row existed before phase 1, so it is
    // inside the subject and its dangling reference is a genuine finding.
    await mongo.collection('moderation_outbox').insertOne(outboxFor(new ObjectId()));

    const report = await audit(source);

    const detail = report.findings.map((finding) => finding.detail).join('\n');
    expect(detail).toContain('moderation_outbox_payload_report_id_reports_id_fk');
    expect(report.liveSourceBound?.excluded).toBe(0);
  });
});
