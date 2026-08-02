/**
 * The engagement plans, end to end: REAL MongoDB → transform → REAL Postgres.
 *
 * The suite mocks mongoose wholesale (`src/__tests__/setup.ts`), so this drives
 * `mongodb-memory-server` through the raw driver via `mongoSourceFromDb` — the
 * split that exists for exactly this. A fake in-memory source would mean the
 * audits were testing an invented `distinct`/`$group` rather than Mongo's, and
 * the point of these cases is that the real ones agree.
 *
 * The load-bearing case is `entityfollows`. `schema/engagement.ts` states that
 * the backfill "must actively drop rows rather than copy them" for a retired
 * `entityType`, and that instruction collides with the `dropped-document`
 * finding — the check that says a transform is losing data and which no rule
 * may ever clear. Both must hold at once: the retired row is gone AND the copy
 * is not accused of losing it. That is what `dropDocument` separates, and it is
 * mutation-tested below.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { eq, inArray, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { entityFollows, mutes, muteWords, pokes } from '../../db/schema/engagement';
import { mongoSourceFromDb, type MongoSource } from '../../db/backfill/mongoSource';
import { copyCollection } from '../../db/backfill/runner';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import { ENGAGEMENT_PLANS } from '../../db/backfill/plans/engagement';
import { planTables, tableName } from '../../db/backfill/plan';
import { auditEnums, auditWouldBlockCopy } from '../../db/backfill/audit';
import {
  createResolutionContext,
  DROP_UNREAD_FEED_ENTITY_FOLLOWS,
  parentKeysFrom,
  planResolutions,
  ResolutionLog,
  transformDocument,
} from '../../db/backfill/resolutions';
import { droppedDocuments } from '../../db/backfill/referentialIntegrity';

let mongod: MongoMemoryServer;
let client: MongoClient;
let mongo: Db;
let source: MongoSource;

const planFor = (collection: string) => {
  const plan = COLLECTION_PLANS.find((entry) => entry.collection === collection);
  if (!plan) throw new Error(`no plan for ${collection}`);
  return plan;
};

async function freshContext() {
  const log = new ResolutionLog();
  return { log, resolutions: createResolutionContext(await planResolutions(source), log) };
}

beforeAll(async () => {
  await connectPostgres();
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  mongo = client.db('backfill_plans_test');
  source = mongoSourceFromDb(mongo, async () => {
    await client.close();
  });
}, 120_000);

/**
 * A marker unique to this file, so every delete below is SCOPED.
 *
 * vitest runs one worker per file against ONE shared database, so an unscoped
 * `delete(mutes)` in `afterEach` truncates a table another suite is mid-way
 * through using. That is not hypothetical — the first draft of this file did
 * exactly that and turned four `contentAffinityService` cases red, in a file
 * nobody had touched.
 */
const OWNER = 'bfe-u1';
const POKER = 'bfe-a';

afterEach(async () => {
  const db = getDb();
  await db.delete(entityFollows).where(eq(entityFollows.userId, OWNER));
  await db.delete(mutes).where(eq(mutes.userId, OWNER));
  await db.delete(pokes).where(eq(pokes.pokerId, POKER));
  await db.delete(muteWords).where(eq(muteWords.userId, OWNER));
  for (const name of await mongo.listCollections({}, { nameOnly: true }).toArray()) {
    await mongo.collection(name.name).deleteMany({});
  }
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
  await closePostgres();
});

describe('one document, one row', () => {
  it('copies mutes with the SOURCE createdAt, not the migration clock', async () => {
    const id = new ObjectId();
    const createdAt = new Date('2021-06-07T08:09:10.011Z');
    await mongo.collection('mutes').insertOne({ _id: id, userId: OWNER, mutedId: 'bfe-u2', createdAt });

    const { resolutions } = await freshContext();
    const result = await copyCollection(planFor('mutes'), {
      db: getDb(),
      source,
      resolutions,
      parents: parentKeysFrom(new Map()),
    });

    expect(result.documentsRead).toBe(1);
    const [row] = await getDb().select().from(mutes).where(eq(mutes.id, id.toHexString()));
    expect(row).toMatchObject({ userId: OWNER, mutedId: 'bfe-u2' });
    // The whole point: a defaulted `now()` here would destroy the history the
    // migration exists to preserve.
    expect(row?.createdAt).toStrictEqual(createdAt);
  });

  it('preserves the ObjectId verbatim as the text primary key', async () => {
    const id = new ObjectId();
    await mongo.collection('pokes').insertOne({ _id: id, pokerId: POKER, pokedId: 'bfe-b' });

    const { resolutions } = await freshContext();
    await copyCollection(planFor('pokes'), {
      db: getDb(),
      source,
      resolutions,
      parents: parentKeysFrom(new Map()),
    });

    const rows = await getDb().select().from(pokes).where(eq(pokes.pokerId, POKER));
    // 24-char hex, byte for byte — this IS the id strategy, and it is what makes
    // every foreign key survive by construction.
    expect(rows[0]?.id).toBe(id.toHexString());
    expect(rows[0]?.id).toMatch(/^[0-9a-f]{24}$/);
  });

  it('gives an absent array the column default rather than NULL', async () => {
    await mongo
      .collection('mutewords')
      .insertOne({ _id: new ObjectId(), userId: OWNER, value: 'spoilers' });

    const { resolutions } = await freshContext();
    await copyCollection(planFor('mutewords'), {
      db: getDb(),
      source,
      resolutions,
      parents: parentKeysFrom(new Map()),
    });

    const [row] = await getDb().select().from(muteWords).where(eq(muteWords.userId, OWNER));
    expect(row?.targets).toStrictEqual([]);
    expect(row?.actorTarget).toBe('all');
  });

  it('is idempotent — copying twice leaves one row', async () => {
    await mongo.collection('pokes').insertOne({ _id: new ObjectId(), pokerId: POKER, pokedId: 'bfe-b' });
    const { resolutions } = await freshContext();
    const options = { db: getDb(), source, resolutions, parents: parentKeysFrom(new Map()) };

    await copyCollection(planFor('pokes'), options);
    await copyCollection(planFor('pokes'), options);

    expect(await getDb().select().from(pokes).where(eq(pokes.pokerId, POKER))).toHaveLength(1);
  });
});

describe('the retired entityfollows type', () => {
  /** Two legal rows and one retired `'feed'` row. */
  async function seed(): Promise<{ hashtag: string; list: string; feed: string }> {
    const hashtag = new ObjectId();
    const list = new ObjectId();
    const feed = new ObjectId();
    await mongo.collection('entityfollows').insertMany([
      { _id: hashtag, userId: OWNER, entityType: 'hashtag', entityId: 'climate' },
      { _id: list, userId: OWNER, entityType: 'list', entityId: 'l1' },
      { _id: feed, userId: OWNER, entityType: 'feed', entityId: 'f1' },
    ]);
    return {
      hashtag: hashtag.toHexString(),
      list: list.toHexString(),
      feed: feed.toHexString(),
    };
  }

  it('is REPORTED by the enum audit before anything is copied', async () => {
    await seed();
    const findings = await auditEnums(source, planFor('entityfollows'));

    const feedFinding = findings.find((finding) => finding.detail.includes('"feed"'));
    if (feedFinding === undefined) throw new Error('the enum audit did not report the feed row');
    expect(feedFinding.documents).toBe(1);
    // The rule answers the finding, so it must NOT block — but the finding is
    // still computed, still counted and still printed. That is the whole
    // contract: teaching the migration what to do never silences the check.
    expect(feedFinding.resolvedBy?.id).toBe(DROP_UNREAD_FEED_ENTITY_FOLLOWS.id);
    expect(auditWouldBlockCopy(feedFinding)).toBe(false);
  });

  it('copies the legal rows and DROPS the retired one', async () => {
    const ids = await seed();
    const { resolutions } = await freshContext();

    await copyCollection(planFor('entityfollows'), {
      db: getDb(),
      source,
      resolutions,
      parents: parentKeysFrom(new Map()),
    });

    const rows = await getDb()
      .select()
      .from(entityFollows)
      .where(inArray(entityFollows.id, [ids.hashtag, ids.list, ids.feed]));
    expect(rows.map((row) => row.id).sort()).toStrictEqual([ids.hashtag, ids.list].sort());
  });

  it('records the dropped row BY ID, so the removal is never silent', async () => {
    const ids = await seed();
    const { log, resolutions } = await freshContext();

    await copyCollection(planFor('entityfollows'), {
      db: getDb(),
      source,
      resolutions,
      parents: parentKeysFrom(new Map()),
    });

    const summary = log
      .summary()
      .find((entry) => entry.rule.id === DROP_UNREAD_FEED_ENTITY_FOLLOWS.id);
    expect(summary?.documents).toBe(1);
    expect(summary?.documentIds).toStrictEqual([ids.feed]);
    expect(summary?.records[0]?.detail).toContain('"feed"');
  });

  it('counts the drop as DECIDED, not as a document going missing', async () => {
    await seed();
    const { resolutions } = await freshContext();

    // Mirror what phase 1 of the referential audit measures.
    let documentsRead = 0;
    let primaryRowsEmitted = 0;
    for await (const doc of mongo.collection('entityfollows').find({})) {
      documentsRead += 1;
      transformDocument(
        planFor('entityfollows'),
        doc as Record<string, unknown>,
        resolutions,
        parentKeysFrom(new Map()),
        () => {
          primaryRowsEmitted += 1;
        }
      );
    }

    const emission = {
      collection: 'entityfollows',
      documentsRead,
      primaryRowsEmitted,
      documentsDroppedByRule: resolutions.documentsDroppedIn('entityfollows'),
    };
    expect(emission.documentsRead).toBe(3);
    expect(emission.primaryRowsEmitted).toBe(2);
    expect(emission.documentsDroppedByRule).toBe(1);
    // 3 read − 2 emitted − 1 decided = 0. A rule-recorded drop is a reviewed
    // decision; only an UNRECORDED shortfall is the blocking finding.
    expect(droppedDocuments(emission)).toBe(0);
  });

  it('still reports a shortfall nothing decided', () => {
    // The guard the case above must not weaken: with no rule-recorded drop, the
    // same arithmetic accuses the transform, which is correct and which no rule
    // may ever clear.
    expect(
      droppedDocuments({
        collection: 'entityfollows',
        documentsRead: 3,
        primaryRowsEmitted: 2,
        documentsDroppedByRule: 0,
      })
    ).toBe(1);
  });

  it('does not double-count a document across repeated transform runs', async () => {
    // A transform runs several times per document by design — the deferred
    // pass, the referential audit, both verifier passes. A counter would
    // multiply by four; the log keys on the document id instead.
    await seed();
    const { resolutions } = await freshContext();
    const options = { db: getDb(), source, resolutions, parents: parentKeysFrom(new Map()) };

    await copyCollection(planFor('entityfollows'), options);
    await copyCollection(planFor('entityfollows'), options);

    expect(resolutions.documentsDroppedIn('entityfollows')).toBe(1);
  });
});

describe('the plans are wired into the map', () => {
  /**
   * This file owns the ENGAGEMENT group, so it asserts the group and its
   * REGISTRATION — deliberately not the whole map.
   *
   * The first version compared `COLLECTION_PLANS` to a seven-name literal, which
   * says "these seven exist" and "no other group exists" in one breath. The
   * second half is not this file's claim to make and it went red the moment the
   * discovery group landed, in a file whose subject had not changed. Whether the
   * map covers every live collection is answered where it belongs: by
   * `tablesWithoutAPlan()` and by the runner's `unknown` bucket, both against
   * the real database rather than a literal.
   */
  it('declares all seven engagement collections', () => {
    expect(ENGAGEMENT_PLANS.map((plan) => plan.collection).sort()).toStrictEqual(
      [
        'bookmarks',
        'entityfollows',
        'likes',
        'mutes',
        'mutewords',
        'pokes',
        'postsubscriptions',
      ].sort()
    );
  });

  it('registers every one of them in the map the runner reads', () => {
    const registered = new Set(COLLECTION_PLANS.map((plan) => plan.collection));
    for (const plan of ENGAGEMENT_PLANS) {
      expect(registered.has(plan.collection), `${plan.collection} is not registered`).toBe(true);
    }
  });

  it('reaches a real Postgres table for each of them', async () => {
    // A vacuity floor: the assertion above compares strings, so it would pass
    // against seven plans pointing at tables that do not exist.
    let checked = 0;
    for (const plan of ENGAGEMENT_PLANS) {
      // Every table the plan declares, its children included — `tableName` is
      // the sanctioned accessor, and reaching into drizzle's internals by hand
      // is what broke the first draft of this case.
      for (const table of planTables(plan)) {
        const name = tableName(table);
        const rows = await getDb().execute<{ n: string }>(
          sql`select count(*)::text as n from information_schema.tables
              where table_schema = 'public' and table_name = ${name}`
        );
        expect(rows[0]?.n, `${plan.collection} -> ${name}`).toBe('1');
        checked += 1;
      }
    }
    // The floor: a broken traversal that checked nothing would otherwise pass.
    expect(checked).toBe(7);
  });
});
