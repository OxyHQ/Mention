/**
 * The moderation plans — six collections, and the four properties that are
 * decisions rather than transcription.
 *
 * - **A queue is copied MID-FLIGHT.** `moderation_outbox` is lease-claimed, so
 *   the copy runs while a live dispatcher holds rows. Clearing the lease would
 *   look tidier and would be wrong twice: a second worker could claim a row the
 *   old one is still processing, and the only evidence of which worker had it
 *   would be gone. A `dead_letter` status is carried for the same reason — it is
 *   evidence somebody still has to look at.
 * - **`payload` stays LOOSE.** §10.11 makes a published decision extensible, so
 *   the column is `jsonb` and the transform reads it with `jsonValue`. Narrowing
 *   to an object would abort a run over a payload the column stores fine.
 * - **`reports.categories` is auditable only half way.** The ELEMENT domain is
 *   audited (Mongo's `distinct` on an array returns elements, and the accepted
 *   set is read through the array column's base column); the `>= 1` LENGTH half
 *   cannot be, because an empty array contributes no elements, so the transform
 *   refuses one.
 * - **`moderation_events.id` is the CrowdSource event id**, and preserving it
 *   verbatim is what keeps the dedupe true across the cutover.
 *
 * Fixtures are `bfm-` prefixed and every cleanup is SCOPED. Nothing here writes
 * a row a global query selects on.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import {
  contentLabels,
  labelerLabelDefinitions,
  labelers,
  moderationEnforcements,
  moderationEvents,
  moderationOutbox,
  reports,
} from '../../db/schema/moderation';
import { mongoSourceFromDb, type MongoSource } from '../../db/backfill/mongoSource';
import { copyCollection } from '../../db/backfill/runner';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import { auditEnums } from '../../db/backfill/audit';
import { auditReferentialIntegrity } from '../../db/backfill/referentialIntegrity';
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
const REPORTER = 'bfm-reporter';
const CREATOR = 'bfm-creator';
const OUTBOX_ID = 'bfm-outbox-1';
const EVENT_ID = 'bfm-event-1';
const DECISION_ID = 'bfm-decision-1';

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

/** A `moderation_outbox` row needs one, and it is NOT NULL with no substitute. */
const EXPIRES_AT = new Date('2027-01-01T00:00:00.000Z');

beforeAll(async () => {
  await connectPostgres();
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  mongo = client.db('backfill_moderation_test');
  source = mongoSourceFromDb(mongo, async () => {
    await client.close();
  });
}, 120_000);

afterEach(async () => {
  const db = getDb();
  await db.delete(moderationOutbox).where(eq(moderationOutbox.id, OUTBOX_ID));
  await db.delete(moderationEvents).where(eq(moderationEvents.id, EVENT_ID));
  await db.delete(moderationEnforcements).where(eq(moderationEnforcements.decisionId, DECISION_ID));
  await db.delete(reports).where(eq(reports.reporter, REPORTER));
  // `content_labels` and `labeler_label_definitions` both CASCADE from `labelers`.
  await db.delete(labelers).where(eq(labelers.creatorId, CREATOR));
  for (const name of await mongo.listCollections({}, { nameOnly: true }).toArray()) {
    await mongo.collection(name.name).deleteMany({});
  }
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
  await closePostgres();
});

describe('reports', () => {
  it('copies the receipt and defaults BOTH status axes', async () => {
    const id = new ObjectId();
    await mongo.collection('reports').insertOne({
      _id: id,
      reportedType: 'post',
      reportedId: 'bfm-post-1',
      reporter: REPORTER,
      categories: ['spam', 'harassment'],
      // Neither axis present — the shape of a report written before
      // `localStatus` existed, which is what `absentAs` on both audits promises
      // the audit will not report.
    });
    await copy('reports');

    const [row] = await getDb().select().from(reports).where(eq(reports.id, id.toHexString()));

    expect(row?.categories).toStrictEqual(['spam', 'harassment']);
    expect(row?.status).toBe('pending');
    // "Stored locally, never delivered" — which is exactly what such a report is.
    expect(row?.localStatus).toBe('received');
    // TRI-STATE: absent means "never merged", which is a different claim from
    // `false` ("CrowdSource told us it opened a new case").
    expect(row?.crowdSourceMerged).toBeNull();
  });

  it('REFUSES a report with no categories rather than inventing one', async () => {
    await mongo.collection('reports').insertOne({
      _id: new ObjectId(),
      reportedType: 'post',
      reportedId: 'bfm-post-2',
      reporter: REPORTER,
      categories: [],
    });

    // Asserting WHICH refusal: a plan can fail for a required field or a missing
    // table, and "it threw" would pass on either.
    await expect(copy('reports')).rejects.toThrow(/reports_categories_check/);
    await expect(copy('reports')).rejects.toThrow(/db\.reports\.countDocuments/);
  });

  it('AUDITS an illegal category, because the set is read through the array column', async () => {
    await mongo.collection('reports').insertOne({
      _id: new ObjectId(),
      reportedType: 'post',
      reportedId: 'bfm-post-3',
      reporter: REPORTER,
      // Mongoose's enum never ran (`runValidators` is set nowhere), so this is
      // storable there and rejected by `reports_categories_check` here.
      categories: ['spam', 'bfm-not-a-category'],
    });

    const findings = await auditEnums(source, planFor('reports'));
    const detail = findings.map((finding) => finding.detail).join('\n');
    expect(detail).toContain('bfm-not-a-category');
    // The legal one alongside it must NOT be reported — an audit that flagged
    // every element of a mixed array would be reporting healthy data.
    expect(detail).not.toContain("'spam'");
  });
});

describe('the moderation outbox', () => {
  it('copies a claimed lease VERBATIM, expired or not', async () => {
    const leaseUntil = new Date('2020-01-01T00:00:00.000Z');
    await mongo.collection('moderation_outbox').insertOne({
      _id: OUTBOX_ID,
      kind: 'decision.apply',
      payload: {
        eventId: EVENT_ID,
        caseId: 'bfm-case-1',
        // LOOSE by contract: an extra key a newer CrowdSource added must survive.
        decision: { outcome: 'violation', bfmUnknownField: [1, 2, 3] },
      },
      status: 'processing',
      attempts: 3,
      leaseOwner: 'bfm-worker-a',
      leaseUntil,
      lastError: 'bfm boom',
      expiresAt: EXPIRES_AT,
    });
    await copy('moderation_outbox');

    const [row] = await getDb()
      .select()
      .from(moderationOutbox)
      .where(eq(moderationOutbox.id, OUTBOX_ID));

    // Long expired, and still copied: an expired lease is reclaimable BY DESIGN,
    // and clearing it would erase which worker had the row.
    expect(row?.leaseOwner).toBe('bfm-worker-a');
    expect(row?.leaseUntil).toStrictEqual(leaseUntil);
    expect(row?.status).toBe('processing');
    expect(row?.attempts).toBe(3);
    expect(row?.lastError).toBe('bfm boom');
    // The unknown field is the point — a projection into columns would drop it.
    expect(row?.payloadDecision).toStrictEqual({
      outcome: 'violation',
      bfmUnknownField: [1, 2, 3],
    });
    // A `decision.apply` row references no report.
    expect(row?.payloadReportId).toBeNull();
  });

  it('keeps a dead_letter row dead, rather than resetting it to pending', async () => {
    // The report has to exist: `payload_report_id` is a REAL foreign key that
    // Mongo never had, so a `report.submit` event is only copyable alongside the
    // report it names. See the orphan case below for what happens when it is not.
    const reportId = new ObjectId();
    await mongo.collection('reports').insertOne({
      _id: reportId,
      reportedType: 'post',
      reportedId: 'bfm-post-6',
      reporter: REPORTER,
      categories: ['spam'],
    });
    await mongo.collection('moderation_outbox').insertOne({
      _id: OUTBOX_ID,
      kind: 'report.submit',
      payload: { reportId: reportId.toHexString() },
      status: 'dead_letter',
      attempts: 9,
      lastError: 'bfm 409 payload conflict',
      expiresAt: EXPIRES_AT,
    });
    await copy('reports');
    await copy('moderation_outbox');

    const [row] = await getDb()
      .select()
      .from(moderationOutbox)
      .where(eq(moderationOutbox.id, OUTBOX_ID));

    // A migration that reset this would silently retire an open defect: the
    // sweep counts dead-lettered rows and must never re-queue one.
    expect(row?.status).toBe('dead_letter');
    expect(row?.attempts).toBe(9);
  });

  it('REPORTS an event whose report is gone, instead of crashing the copy', async () => {
    // `payload.reportId` is a plain String in Mongo with nothing enforcing that
    // the report still exists, and it is a real foreign key here. That gap is
    // exactly what the referential audit is for: it runs BEFORE any insert, so
    // an orphan is a counted finding rather than a `23503` partway through a run
    // — which is the difference between an operator deciding what to do and a
    // half-copied database.
    await mongo.collection('moderation_outbox').insertOne({
      _id: OUTBOX_ID,
      kind: 'report.submit',
      payload: { reportId: new ObjectId().toHexString() },
      status: 'pending',
      expiresAt: EXPIRES_AT,
    });

    const report = await auditReferentialIntegrity(
      getDb(),
      source,
      // Both plans, because a relation is only exercised when its TARGET table is
      // fed by the run — `reports` has no documents here, which is what makes the
      // reference an orphan.
      [
        { plan: planFor('reports'), documents: 0 },
        { plan: planFor('moderation_outbox'), documents: 1 },
      ],
      createResolutionContext(await planResolutions(source), new ResolutionLog())
    );

    const detail = report.findings.map((finding) => finding.detail).join('\n');
    expect(detail).toContain('moderation_outbox_payload_report_id_reports_id_fk');
  });

  it('REFUSES a row with no retention deadline rather than inventing now()', async () => {
    await mongo.collection('moderation_outbox').insertOne({
      _id: OUTBOX_ID,
      kind: 'report.submit',
      payload: {},
      status: 'pending',
      // No `expiresAt`. NOT NULL with no default: an invented one would sweep
      // the row on an unknowable schedule.
    });
    await expect(copy('moderation_outbox')).rejects.toThrow(/expiresAt/);
  });
});

describe('moderation events', () => {
  it('preserves the CrowdSource event id verbatim, which IS the dedupe', async () => {
    await mongo.collection('moderation_events').insertOne({
      _id: EVENT_ID,
      type: 'bfm.decision.published',
      caseId: 'bfm-case-2',
      payload: { revision: 2 },
      state: 'queued',
      receivedAt: new Date('2025-06-01T00:00:00.000Z'),
      expiresAt: EXPIRES_AT,
    });
    await copy('moderation_events');

    const [row] = await getDb()
      .select()
      .from(moderationEvents)
      .where(eq(moderationEvents.id, EVENT_ID));

    // A webhook redelivered AFTER the cutover has to collide with the row copied
    // from before it. A regenerated id would make every historical event
    // re-appliable exactly once more.
    expect(row?.id).toBe(EVENT_ID);
    expect(row?.state).toBe('queued');
    expect(row?.receivedAt).toStrictEqual(new Date('2025-06-01T00:00:00.000Z'));
  });

  it('accepts a payload that is not an object, because the column does', async () => {
    await mongo.collection('moderation_events').insertOne({
      _id: EVENT_ID,
      type: 'bfm.unknown.type',
      // `jsonb` holds an array as readily as an object, and §10.6 keeps the
      // event type OPEN. A transform that demanded an object would abort the
      // whole run over a row the target stores perfectly well.
      payload: ['bfm', 'loose'],
      expiresAt: EXPIRES_AT,
    });
    await copy('moderation_events');

    const [row] = await getDb()
      .select()
      .from(moderationEvents)
      .where(eq(moderationEvents.id, EVENT_ID));

    expect(row?.payload).toStrictEqual(['bfm', 'loose']);
    expect(row?.state).toBe('claimed');
  });
});

describe('enforcements', () => {
  it('keeps previousState NULL when the action changed no state', async () => {
    const changed = new ObjectId();
    const recorded = new ObjectId();
    await mongo.collection('moderation_enforcements').insertMany([
      {
        _id: changed,
        decisionId: DECISION_ID,
        decisionRevision: 1,
        action: 'restrict',
        caseId: 'bfm-case-3',
        subjectType: 'post',
        subjectId: 'bfm-post-4',
        outcome: 'violation',
        reason: 'bfm reason',
        mode: 'automatic',
        applied: true,
        previousState: { postStatus: 'published', metadataIsSensitive: false },
      },
      {
        _id: recorded,
        decisionId: DECISION_ID,
        decisionRevision: 1,
        action: 'manual_review',
        caseId: 'bfm-case-3',
        subjectType: 'post',
        subjectId: 'bfm-post-4',
        outcome: 'violation',
        reason: 'bfm recorded only',
        mode: 'observe',
        // No `applied`, no `previousState` — `observe` records the plan and
        // removes nothing.
      },
    ]);
    await copy('moderation_enforcements');

    const rows = await getDb()
      .select()
      .from(moderationEnforcements)
      .where(eq(moderationEnforcements.decisionId, DECISION_ID));
    const byAction = new Map(rows.map((row) => [row.action, row]));

    expect(byAction.get('restrict')?.previousStatePostStatus).toBe('published');
    expect(byAction.get('restrict')?.previousStateMetadataIsSensitive).toBe(false);
    expect(byAction.get('restrict')?.applied).toBe(true);

    // The one that matters: a guessed previous state would let a later restore
    // lift an author's OWN content warning that no moderation action ever set.
    expect(byAction.get('manual_review')?.previousStatePostStatus).toBeNull();
    expect(byAction.get('manual_review')?.previousStateMetadataIsSensitive).toBeNull();
    expect(byAction.get('manual_review')?.applied).toBe(false);

    // Two actions on ONE decision revision coexist — `action` is in the
    // idempotency key precisely so they can.
    expect(rows).toHaveLength(2);
  });
});

describe('labelers', () => {
  it('dedupes label definitions on SLUG before assigning positions', async () => {
    const id = new ObjectId();
    await mongo.collection('labelers').insertOne({
      _id: id,
      name: 'bfm labeler',
      creatorId: CREATOR,
      labelDefinitions: [
        { slug: 'bfm-a', name: 'A', severity: 'low', defaultAction: 'warn' },
        { slug: 'bfm-b', name: 'B', severity: 'high', defaultAction: 'blur' },
        // The duplicate is in the MIDDLE on purpose: with it last, `ON CONFLICT
        // DO NOTHING` drops the highest-positioned row and leaves no gap, so the
        // case would pass over a transform that deduped after positioning.
        { slug: 'bfm-a', name: 'A again', severity: 'critical', defaultAction: 'hide' },
        { slug: 'bfm-c', name: 'C', severity: 'medium', defaultAction: 'show' },
      ],
    });
    await copy('labelers');

    const rows = await getDb()
      .select()
      .from(labelerLabelDefinitions)
      .where(eq(labelerLabelDefinitions.labelerId, id.toHexString()))
      .orderBy(labelerLabelDefinitions.position);

    expect(rows.map((row) => row.slug)).toStrictEqual(['bfm-a', 'bfm-b', 'bfm-c']);
    expect(rows.map((row) => row.position)).toStrictEqual([0, 1, 2]);
    // FIRST occurrence wins — the later one is the duplicate, not a correction.
    expect(rows[0]?.name).toBe('A');
    expect(rows[0]?.severity).toBe('low');
  });

  it('carries a content label to its labeler by real foreign key', async () => {
    const labelerId = new ObjectId();
    const labelId = new ObjectId();
    await mongo.collection('labelers').insertOne({
      _id: labelerId,
      name: 'bfm labeler',
      creatorId: CREATOR,
      labelDefinitions: [{ slug: 'bfm-a', name: 'A', severity: 'low', defaultAction: 'warn' }],
    });
    await mongo.collection('contentlabels').insertOne({
      _id: labelId,
      labelerId,
      targetType: 'post',
      targetId: 'bfm-post-5',
      labelSlug: 'bfm-a',
      createdBy: CREATOR,
    });
    await copy('labelers');
    await copy('contentlabels');

    const [row] = await getDb()
      .select()
      .from(contentLabels)
      .where(eq(contentLabels.id, labelId.toHexString()));

    // The ObjectId reference has to survive as the same 24-char hex the labeler
    // row is keyed by, or the foreign key rejects the insert.
    expect(row?.labelerId).toBe(labelerId.toHexString());
    expect(row?.labelSlug).toBe('bfm-a');
  });
});
