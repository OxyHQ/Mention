/**
 * The discovery plans, end to end: REAL MongoDB → transform → REAL Postgres.
 *
 * Same split as `backfillEngagementPlans.test.ts` and for the same reason — the
 * suite mocks mongoose wholesale (`src/__tests__/setup.ts`), so this drives
 * `mongodb-memory-server` through the raw driver. A fake in-memory source would
 * mean the audits were testing an invented `distinct`/`$group` rather than
 * Mongo's own, and the point is that the real ones agree.
 *
 * What these seven collections are actually FOR, in test terms, is the numeric
 * audit: six of them carry a `>= 0` CHECK on a denormalized counter, and
 * Mongoose's `min:` never ran, so the source can legally hold a negative one.
 * The cases below insert exactly that and assert it is reported BEFORE anything
 * is written — which is the difference between a decision an operator makes and
 * a `23514` at hour three.
 *
 * Every fixture id is prefixed `bfd-`, and every cleanup is SCOPED to it: vitest
 * runs one worker per file against ONE shared database, so an unscoped
 * `delete(trending)` truncates a table another suite is mid-way through.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import {
  authorFollowerSnapshots,
  gifs,
  notifications,
  pushTokens,
  topicStats,
  trending,
} from '../../db/schema/discovery';
import { mongoSourceFromDb, type MongoSource } from '../../db/backfill/mongoSource';
import { copyCollection } from '../../db/backfill/runner';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import { auditEnums, auditNumerics, auditWouldBlockCopy, type AuditFinding } from '../../db/backfill/audit';
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
const OWNER = 'bfd-u1';
const TREND_NAME = 'bfd-trend';
const KLIPY_ID = 'bfd-klipy-1';
const TOPIC_ID = 'bfd-topic-1';
const TOKEN = 'bfd-token-1';

const planFor = (collection: string) => {
  const plan = COLLECTION_PLANS.find((entry) => entry.collection === collection);
  if (!plan) throw new Error(`no plan for ${collection}`);
  return plan;
};

async function freshContext() {
  const log = new ResolutionLog();
  return { log, resolutions: createResolutionContext(await planResolutions(source), log) };
}

async function copy(collection: string) {
  const { resolutions } = await freshContext();
  return copyCollection(planFor(collection), {
    db: getDb(),
    source,
    resolutions,
    parents: parentKeysFrom(new Map()),
  });
}

beforeAll(async () => {
  await connectPostgres();
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  mongo = client.db('backfill_discovery_test');
  source = mongoSourceFromDb(mongo, async () => {
    await client.close();
  });
}, 120_000);

afterEach(async () => {
  const db = getDb();
  await db.delete(trending).where(eq(trending.name, TREND_NAME));
  await db.delete(topicStats).where(eq(topicStats.topicId, TOPIC_ID));
  await db
    .delete(authorFollowerSnapshots)
    .where(eq(authorFollowerSnapshots.oxyUserId, OWNER));
  await db.delete(gifs).where(eq(gifs.klipyId, KLIPY_ID));
  await db.delete(notifications).where(eq(notifications.recipientId, OWNER));
  await db.delete(pushTokens).where(eq(pushTokens.token, TOKEN));
  for (const name of await mongo.listCollections({}, { nameOnly: true }).toArray()) {
    await mongo.collection(name.name).deleteMany({});
  }
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
  await closePostgres();
});

describe('the numeric audit against real Mongo', () => {
  it('reports a negative counter before anything is copied', async () => {
    // The shape this exists for: a decrement race drove the count below zero,
    // Mongoose's `min: 0` never ran because `runValidators` is set nowhere, and
    // the row is legal in the source and refused by the target.
    await mongo.collection('topicstats').insertOne({
      _id: new ObjectId(),
      topicId: TOPIC_ID,
      popularity: 1,
      postCount: -3,
    });

    const findings = await auditNumerics(source, planFor('topicstats'));
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('numeric');
    expect(findings[0].detail).toContain('topic_stats_post_count_check');
    expect(findings[0].documents).toBe(1);
    expect(auditWouldBlockCopy(findings[0])).toBe(true);
  });

  it('says nothing about a healthy counter', async () => {
    await mongo
      .collection('topicstats')
      .insertOne({ _id: new ObjectId(), topicId: TOPIC_ID, postCount: 0 });
    expect(await auditNumerics(source, planFor('topicstats'))).toEqual([]);
  });

  it('does not report an absent counter the transform defaults', async () => {
    // `postCount` is `NOT NULL DEFAULT 0` and the transform re-applies the
    // Mongoose default, so a document predating the field is not a finding —
    // this is the false positive that would fire on every legacy row.
    await mongo.collection('topicstats').insertOne({ _id: new ObjectId(), topicId: TOPIC_ID });
    expect(await auditNumerics(source, planFor('topicstats'))).toEqual([]);
  });

  it('DOES report an absent count that nothing defaults', async () => {
    // The mirror case, and the reason `absentAs` is per-audit rather than
    // implied: `author_follower_snapshots.follower_count` is NOT NULL with no
    // default and the transform supplies none, so an absent one is a `23502`.
    // A snapshot with no count is not a snapshot of zero followers.
    await mongo
      .collection('authorfollowersnapshots')
      .insertOne({ _id: new ObjectId(), oxyUserId: OWNER, at: new Date() });

    const findings = await auditNumerics(source, planFor('authorfollowersnapshots'));
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('NOT NULL');
  });
});

describe('the enum audit against real Mongo', () => {
  it('reports a trending type the CHECK would refuse', async () => {
    await mongo.collection('trendings').insertOne({
      _id: new ObjectId(),
      type: 'person',
      name: TREND_NAME,
      score: 1,
      rank: 1,
      calculatedAt: new Date(),
    });

    const findings = await auditEnums(source, planFor('trendings'));
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('person');
    expect(auditWouldBlockCopy(findings[0])).toBe(true);
  });

  it('does not report an absent enum the transform defaults', async () => {
    // `pushtokens.type`/`platform` are `NOT NULL DEFAULT 'unknown'` and the
    // transform re-applies it. Every token registered before those fields
    // existed would otherwise block the whole migration.
    await mongo
      .collection('pushtokens')
      .insertOne({ _id: new ObjectId(), userId: OWNER, token: TOKEN });
    expect(await auditEnums(source, planFor('pushtokens'))).toEqual([]);
  });

  it('reports the legacy android spelling IN FULL, and does not block on it', async () => {
    // Production holds exactly one (`6a2ff5aaf24acd91fb263a88`). A resolved
    // finding is still computed, counted and printed — the rule is what stops
    // it blocking, not silence.
    await mongo
      .collection('pushtokens')
      .insertOne({ _id: new ObjectId(), userId: OWNER, token: TOKEN, type: 'android' });

    const findings = await auditEnums(source, planFor('pushtokens'));
    const type = findings.find((finding) => finding.detail.includes('"android"'));

    expect(type).toBeDefined();
    expect(type?.documents).toBe(1);
    expect(auditWouldBlockCopy(type as AuditFinding)).toBe(false);
    expect(type?.resolvedBy?.id).toBe('map-legacy-push-token-type');
  });
});

describe('the legacy push-token transport spelling', () => {
  /** The copy, plus the rule log it produced — the record is half the point. */
  async function copyPushTokens() {
    const { log, resolutions } = await freshContext();
    await copyCollection(planFor('pushtokens'), {
      db: getDb(),
      source,
      resolutions,
      parents: parentKeysFrom(new Map()),
    });
    return log.summary();
  }

  it('rewrites android to fcm and REPORTS the row it rewrote', async () => {
    await mongo
      .collection('pushtokens')
      .insertOne({ _id: new ObjectId(), userId: OWNER, token: TOKEN, type: 'android', platform: 'android' });

    const summaries = await copyPushTokens();
    const rows = await getDb().select().from(pushTokens).where(eq(pushTokens.token, TOKEN));

    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('fcm');
    // `platform` is untouched: the rule is about the TRANSPORT spelling, and
    // 'android' is a legal platform.
    expect(rows[0].platform).toBe('android');

    // A value that stops existing has to leave a trace, or the migration
    // silently rewrote production data.
    const summary = summaries.find((entry) => entry.rule.id === 'map-legacy-push-token-type');
    expect(summary?.documents).toBe(1);
    expect(summary?.records[0].detail).toContain('"android"');
    expect(summary?.records[0].evidence).toStrictEqual({
      'push_tokens.type (source)': 'android',
      'push_tokens.type (written)': 'fcm',
    });
  });

  it('sends any OTHER unaccepted value to unknown rather than guessing a transport', async () => {
    // NARROW BY CONSTRUCTION. `android` earned `fcm` on evidence; a value
    // nobody has examined gets the vocabulary's own escape hatch, because
    // mapping it onto a real transport would be inventing a fact.
    await mongo
      .collection('pushtokens')
      .insertOne({ _id: new ObjectId(), userId: OWNER, token: TOKEN, type: 'carrier-pigeon' });

    const summaries = await copyPushTokens();
    const rows = await getDb().select().from(pushTokens).where(eq(pushTokens.token, TOKEN));

    expect(rows[0].type).toBe('unknown');
    const summary = summaries.find((entry) => entry.rule.id === 'map-legacy-push-token-type');
    expect(summary?.documents).toBe(1);
    expect(summary?.records[0].evidence?.['push_tokens.type (written)']).toBe('unknown');
  });

  it('leaves an ACCEPTED value alone, and records nothing', async () => {
    // The accepted set is read off the column, so a value the schema admits
    // must pass through untouched — otherwise the rule would rewrite rows it
    // was never written for, which is `resolution-overreach`.
    await mongo
      .collection('pushtokens')
      .insertOne({ _id: new ObjectId(), userId: OWNER, token: TOKEN, type: 'apns' });

    const summaries = await copyPushTokens();
    const rows = await getDb().select().from(pushTokens).where(eq(pushTokens.token, TOKEN));

    expect(rows[0].type).toBe('apns');
    const summary = summaries.find((entry) => entry.rule.id === 'map-legacy-push-token-type');
    expect(summary?.documents ?? 0).toBe(0);
  });
});

describe('one document, one row', () => {
  it('copies trending with the SOURCE calculatedAt and no invented createdAt', async () => {
    const id = new ObjectId();
    const calculatedAt = new Date('2022-03-04T05:06:07.008Z');
    const updatedAt = new Date('2022-03-04T05:10:00.000Z');
    await mongo.collection('trendings').insertOne({
      _id: id,
      type: 'hashtag',
      name: TREND_NAME,
      score: 12.5,
      rank: 3,
      calculatedAt,
      updatedAt,
    });

    const result = await copy('trendings');
    expect(result.documentsRead).toBe(1);

    const [row] = await getDb().select().from(trending).where(eq(trending.id, id.toHexString()));
    expect(row).toMatchObject({ type: 'hashtag', name: TREND_NAME, rank: 3 });
    expect(row?.calculatedAt).toStrictEqual(calculatedAt);
    expect(row?.updatedAt).toStrictEqual(updatedAt);
    // The model defaults these on write; the transform re-applies them here
    // rather than letting a NOT NULL column take a null.
    expect(row?.description).toBe('');
    expect(row?.volume).toBe(0);
    expect(row?.momentum).toBe(0);
    // `trending` has no `createdAt` on EITHER side. Reading one off the document
    // would invent a timestamp the model never wrote.
    expect(Object.keys(row ?? {})).not.toContain('createdAt');
  });

  it('preserves an ObjectId topicId verbatim as text', async () => {
    const id = new ObjectId();
    const topicId = new ObjectId();
    await mongo.collection('trendings').insertOne({
      _id: id,
      type: 'topic',
      name: TREND_NAME,
      score: 1,
      rank: 1,
      topicId,
      calculatedAt: new Date(),
    });

    await copy('trendings');
    const [row] = await getDb().select().from(trending).where(eq(trending.id, id.toHexString()));
    expect(row?.topicId).toBe(topicId.toHexString());
  });

  it('leaves an absent nullable id NULL rather than empty string', async () => {
    const id = new ObjectId();
    await mongo.collection('trendings').insertOne({
      _id: id,
      type: 'hashtag',
      name: TREND_NAME,
      score: 1,
      rank: 1,
      calculatedAt: new Date(),
    });

    await copy('trendings');
    const [row] = await getDb().select().from(trending).where(eq(trending.id, id.toHexString()));
    // `''` would be a VALUE — a topic literally named "" — and would be matched
    // by a lookup for it.
    expect(row?.topicId).toBeNull();
  });

  it('never writes the generated search vector, and Postgres derives it', async () => {
    const id = new ObjectId();
    await mongo.collection('gifs').insertOne({
      _id: id,
      klipyId: KLIPY_ID,
      slug: 'a-slug',
      title: 'Dancing Cat',
      searchTerms: ['cat', 'dance'],
      width: 320,
      height: 240,
      mp4FileId: 'bfd-file-mp4',
      previewFileId: 'bfd-file-preview',
    });

    await copy('gifs');
    const [row] = await getDb().select().from(gifs).where(eq(gifs.klipyId, KLIPY_ID));
    expect(row?.searchTerms).toStrictEqual(['cat', 'dance']);
    // GENERATED ALWAYS: naming it in the transform would throw in `buildRow`,
    // and Postgres fills it from the two source columns.
    expect(row?.searchVector).toContain('cat');
    expect(row?.searchVector).toContain('dancing');
  });

  it('copies a notification entityId verbatim whichever kind it names', async () => {
    // POLYMORPHIC by `entityType`: a `posts.id` for post/reply, an Oxy account
    // id for profile. The model declares ObjectId for all three, which only
    // works because an Oxy account id is 24 hex characters and casts.
    const postEntity = new ObjectId();
    await mongo.collection('notifications').insertMany([
      {
        _id: new ObjectId(),
        recipientId: OWNER,
        actorId: 'bfd-actor',
        type: 'like',
        entityId: postEntity,
        entityType: 'post',
      },
      {
        _id: new ObjectId(),
        recipientId: OWNER,
        actorId: 'bfd-actor-2',
        type: 'follow',
        entityId: new ObjectId('0123456789abcdef01234567'),
        entityType: 'profile',
      },
    ]);

    await copy('notifications');
    const rows = await getDb()
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, OWNER));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.entityId).sort()).toStrictEqual(
      [postEntity.toHexString(), '0123456789abcdef01234567'].sort()
    );
    // No foreign key on `entity_id`, precisely because half its values name a
    // row in another service.
    expect(rows.every((row) => row.read === false)).toBe(true);
  });
});
