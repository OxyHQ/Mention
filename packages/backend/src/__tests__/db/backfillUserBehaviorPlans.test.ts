/**
 * `userbehaviors` → four tables, copied by the REAL runner.
 *
 * The subject is the feed's model of what a person likes, and its failure mode
 * is silence: a dropped affinity row or a corrupted weight changes which posts
 * someone sees, nothing errors, and the model decays back to correct over weeks
 * so nobody reports it. The cases below therefore assert VALUES, not just row
 * counts — a count check passes against a transform that writes every weight as
 * zero.
 *
 * Three properties are load-bearing and each has a case that fails alone:
 *
 * - the five `interactionTypes` counters flatten into columns without being
 *   transposed (a swap of `saves` and `shares` is invisible to any count);
 * - a within-array duplicate does not abort the run on the natural unique key
 *   Mongo never had, and the entry kept is the one with the newest
 *   `lastInteractionAt` rather than the last in the array;
 * - an out-of-range weight is COPIED, not clamped, so the numeric audit reports
 *   it. Clamping 7.5 to 1 would be the most damaging legal value there is.
 *
 * Fixtures are prefixed `bfu-` and cleanup is scoped to them: vitest runs test
 * files in parallel against ONE Postgres database.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { asc, eq, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import {
  userBehaviorAuthors,
  userBehaviorRegions,
  userBehaviorTopics,
  userBehaviors,
} from '../../db/schema/userProfile';
import { mongoSourceFromDb, type MongoSource } from '../../db/backfill/mongoSource';
import { copyCollection } from '../../db/backfill/runner';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import { auditNumerics } from '../../db/backfill/audit';
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
const OWNER = 'bfu-owner';

function plan() {
  const found = COLLECTION_PLANS.find((entry) => entry.collection === 'userbehaviors');
  if (!found) throw new Error('no plan for userbehaviors');
  return found;
}

async function copy() {
  const log = new ResolutionLog();
  return copyCollection(plan(), {
    db: getDb(),
    source,
    resolutions: createResolutionContext(await planResolutions(source), log),
    parents: parentKeysFrom(new Map()),
  });
}

async function seed(doc: Record<string, unknown>): Promise<string> {
  const id = new ObjectId();
  await mongo.collection('userbehaviors').insertOne({
    _id: id,
    oxyUserId: OWNER,
    createdAt: new Date('2024-06-07T08:09:10.011Z'),
    updatedAt: new Date('2024-06-07T08:09:10.011Z'),
    ...doc,
  });
  return id.toHexString();
}

beforeAll(async () => {
  await connectPostgres();
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  mongo = client.db('backfill_user_behavior_test');
  source = mongoSourceFromDb(mongo, async () => {
    await client.close();
  });
}, 120_000);

afterEach(async () => {
  // The three child tables all CASCADE from `user_behaviors`.
  await getDb().delete(userBehaviors).where(eq(userBehaviors.oxyUserId, OWNER));
  for (const name of await mongo.listCollections({}, { nameOnly: true }).toArray()) {
    await mongo.collection(name.name).deleteMany({});
  }
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
  await closePostgres();
});

describe('the parent row', () => {
  it('copies the four post-type buckets and the rate columns', async () => {
    const id = await seed({
      preferredPostTypes: { text: 7, image: 3, video: 11, poll: 1 },
      activeHours: [9, 10, 22],
      preferredLanguages: ['en', 'es'],
      averageEngagementTime: 12.5,
      skipRate: 0.25,
      completionRate: 0.75,
      hiddenTopics: ['bfu-hidden'],
      lastUpdated: new Date('2024-06-01T00:00:00.000Z'),
    });

    await copy();

    const [row] = await getDb().select().from(userBehaviors).where(eq(userBehaviors.id, id));
    // Each bucket a DIFFERENT value, so a transposition of two of them fails.
    expect(row?.preferredPostTypeText).toBe(7);
    expect(row?.preferredPostTypeImage).toBe(3);
    expect(row?.preferredPostTypeVideo).toBe(11);
    expect(row?.preferredPostTypePoll).toBe(1);
    expect(row?.activeHours).toEqual([9, 10, 22]);
    expect(row?.preferredLanguages).toEqual(['en', 'es']);
    expect(row?.skipRate).toBe(0.25);
    expect(row?.completionRate).toBe(0.75);
    expect(row?.lastUpdated?.toISOString()).toBe('2024-06-01T00:00:00.000Z');
  });

  it('keeps an absent array NULL rather than making it empty', async () => {
    // "Never learned an active hour" and "learned that none applies" are
    // different facts, and only the source can say which.
    const id = await seed({});

    await copy();

    const [row] = await getDb().select().from(userBehaviors).where(eq(userBehaviors.id, id));
    expect(row?.activeHours).toBeNull();
    expect(row?.hiddenAuthors).toBeNull();
    // The scalar defaults still land explicitly rather than via the column.
    expect(row?.skipRate).toBe(0);
    expect(row?.preferredPostTypeText).toBe(0);
  });
});

describe('preferred authors', () => {
  it('flattens interactionTypes into columns without transposing them', async () => {
    // Five DIFFERENT values: any pairwise swap changes a column and fails.
    const id = await seed({
      preferredAuthors: [
        {
          authorId: 'bfu-author-a',
          interactionCount: 9,
          lastInteractionAt: new Date('2024-05-01T00:00:00.000Z'),
          interactionTypes: { likes: 1, boosts: 2, comments: 3, saves: 4, shares: 5 },
          weight: 0.5,
        },
      ],
    });

    await copy();

    const [row] = await getDb()
      .select()
      .from(userBehaviorAuthors)
      .where(eq(userBehaviorAuthors.behaviorId, id));
    expect(row?.authorId).toBe('bfu-author-a');
    expect(row?.interactionCount).toBe(9);
    expect(row?.likes).toBe(1);
    expect(row?.boosts).toBe(2);
    expect(row?.comments).toBe(3);
    expect(row?.saves).toBe(4);
    expect(row?.shares).toBe(5);
    expect(row?.weight).toBe(0.5);
  });

  it('survives one author listed twice, keeping the newest interaction', async () => {
    // Without the dedupe this aborts on
    // `user_behavior_authors_behavior_id_author_id_key`, which Mongo never had.
    // The NEWEST entry is deliberately FIRST in the array, so an implementation
    // that took the last one would pass a naive version of this case and fail
    // here.
    const id = await seed({
      preferredAuthors: [
        {
          authorId: 'bfu-twice',
          interactionCount: 50,
          lastInteractionAt: new Date('2024-05-09T00:00:00.000Z'),
          weight: 0.9,
        },
        {
          authorId: 'bfu-twice',
          interactionCount: 2,
          lastInteractionAt: new Date('2024-05-01T00:00:00.000Z'),
          weight: 0.1,
        },
      ],
    });

    await copy();

    const rows = await getDb()
      .select()
      .from(userBehaviorAuthors)
      .where(eq(userBehaviorAuthors.behaviorId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.interactionCount).toBe(50);
    expect(rows[0]?.weight).toBe(0.9);
  });

  it('copies an out-of-range weight rather than clamping it', async () => {
    // The audit's job, not the transform's. A clamp would turn corruption into
    // the most damaging legal value — a 1.0 pins that author to the top of every
    // session — while reporting nothing.
    const id = await seed({
      preferredAuthors: [
        { authorId: 'bfu-corrupt', lastInteractionAt: new Date('2024-05-01T00:00:00.000Z'), weight: 7.5 },
      ],
    });

    // The finding names the constraint in its `detail`, which is what an
    // operator reads; `kind` alone would not distinguish this from the rate
    // audits on the parent row.
    const findings = await auditNumerics(source, plan());
    const weightFinding = findings.find((finding) =>
      finding.kind === 'numeric'
      && finding.detail.includes('user_behavior_authors_weight_check'));
    expect(weightFinding).toBeDefined();
    expect(weightFinding?.sampleIds).toContain(id);

    // And the transform does not quietly repair what the audit just reported:
    // the CHECK refuses the row, so the copy fails loudly rather than storing a
    // clamped 1.0 that nothing would ever flag again.
    await expect(copy()).rejects.toThrow();
  });
});

describe('preferred topics and regions', () => {
  it('copies a topic with its Oxy registry id as a hex string', async () => {
    const topicId = new ObjectId();
    const id = await seed({
      preferredTopics: [
        {
          topic: 'bfu-topic',
          topicId,
          interactionCount: 4,
          lastInteractionAt: new Date('2024-05-02T00:00:00.000Z'),
          weight: 0.4,
        },
      ],
    });

    await copy();

    const [row] = await getDb()
      .select()
      .from(userBehaviorTopics)
      .where(eq(userBehaviorTopics.behaviorId, id));
    expect(row?.topic).toBe('bfu-topic');
    // Stored as hex, not as the BSON value's string coercion.
    expect(row?.topicId).toBe(topicId.toHexString());
    expect(row?.weight).toBe(0.4);
  });

  it('reads a region count as a float, because it is a weight and not a tally', async () => {
    const id = await seed({
      preferredRegions: [
        { region: 'DE', count: 2.5, lastInteractionAt: new Date('2024-05-03T00:00:00.000Z') },
      ],
    });

    await copy();

    const [row] = await getDb()
      .select()
      .from(userBehaviorRegions)
      .where(eq(userBehaviorRegions.behaviorId, id));
    // `int` would silently truncate this to 2 and no constraint would notice.
    expect(row?.count).toBe(2.5);
  });

  it('is idempotent across all four tables', async () => {
    const id = await seed({
      preferredAuthors: [
        { authorId: 'bfu-a', lastInteractionAt: new Date('2024-05-01T00:00:00.000Z'), weight: 0.2 },
      ],
      preferredTopics: [
        { topic: 'bfu-t', lastInteractionAt: new Date('2024-05-01T00:00:00.000Z'), weight: 0.3 },
      ],
      preferredRegions: [
        { region: 'US', count: 1, lastInteractionAt: new Date('2024-05-01T00:00:00.000Z') },
      ],
    });

    await copy();
    await copy();

    for (const table of [userBehaviorAuthors, userBehaviorTopics, userBehaviorRegions] as const) {
      const rows = await getDb().select().from(table).where(eq(table.behaviorId, id));
      expect(rows).toHaveLength(1);
    }
    expect(
      await getDb().select().from(userBehaviors).where(inArray(userBehaviors.id, [id]))
    ).toHaveLength(1);
  });
});
