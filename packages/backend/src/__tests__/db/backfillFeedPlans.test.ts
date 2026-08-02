/**
 * The feed plans — the last wide fan-out: one `customfeeds` document into five
 * tables, from four different Mongo shapes.
 *
 * Two properties carry the weight here and neither is visible column by column:
 *
 * - **`custom_feed_members` has TWO unique keys that fail differently.**
 *   `(feed_id, oxy_user_id)` says a member appears once; `(feed_id, position)`
 *   says the order is a bijection. Mongo's `memberOxyUserIds` satisfies neither
 *   — a duplicate id is legal there — so deduping AFTER assigning positions
 *   would leave a GAP wherever one was removed, and `ON CONFLICT DO NOTHING`
 *   would hide it. Dedup happens first, so the surviving positions stay dense.
 * - **`definitionMode` NULL is meaningful.** A feed with no stored definition
 *   predates the composable phase and the request-time fallback derives one
 *   from the legacy filter fields. Defaulting it would silently switch those
 *   feeds off the fallback and onto an empty module list — no error, an empty
 *   feed.
 *
 * Fixtures are `bfg-` prefixed and every cleanup is SCOPED. Nothing here writes
 * a row a global query selects on.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import {
  customFeedDefinitionModules,
  customFeedMembers,
  customFeedTopics,
  customFeeds,
  feedGenerators,
  userFeedPreferences,
  userSavedFeeds,
} from '../../db/schema/feeds';
import { mongoSourceFromDb, type MongoSource } from '../../db/backfill/mongoSource';
import { copyCollection } from '../../db/backfill/runner';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import { auditNumerics, auditWouldBlockCopy } from '../../db/backfill/audit';
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
const OWNER = 'bfg-owner';
const GENERATOR_URI = 'at://bfg.example/app.bsky.feed.generator/one';

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
  mongo = client.db('backfill_feeds_test');
  source = mongoSourceFromDb(mongo, async () => {
    await client.close();
  });
}, 120_000);

afterEach(async () => {
  const db = getDb();
  // Every child table CASCADEs from its parent.
  await db.delete(customFeeds).where(eq(customFeeds.ownerOxyUserId, OWNER));
  await db.delete(feedGenerators).where(eq(feedGenerators.uri, GENERATOR_URI));
  await db.delete(userFeedPreferences).where(eq(userFeedPreferences.oxyUserId, OWNER));
  for (const name of await mongo.listCollections({}, { nameOnly: true }).toArray()) {
    await mongo.collection(name.name).deleteMany({});
  }
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
  await closePostgres();
});

describe('the member list', () => {
  it('dedupes BEFORE assigning positions, so the positions stay dense', async () => {
    const id = new ObjectId();
    await mongo.collection('customfeeds').insertOne({
      _id: id,
      ownerOxyUserId: OWNER,
      title: 'bfg feed',
      // `bfg-a` twice. Legal in Mongo, and it violates BOTH unique keys here if
      // the transform emits it twice.
      memberOxyUserIds: ['bfg-a', 'bfg-b', 'bfg-a', 'bfg-c'],
    });
    await copy('customfeeds');

    const rows = await getDb()
      .select()
      .from(customFeedMembers)
      .where(eq(customFeedMembers.feedId, id.toHexString()))
      .orderBy(customFeedMembers.position);

    expect(rows.map((row) => row.oxyUserId)).toStrictEqual(['bfg-a', 'bfg-b', 'bfg-c']);
    // The part that would be wrong if dedup ran after positions: `ON CONFLICT
    // DO NOTHING` would swallow the duplicate row and leave positions
    // 0, 1, 3 — a gap nothing errors on and nothing later can distinguish from
    // a deliberately sparse ordering.
    expect(rows.map((row) => row.position)).toStrictEqual([0, 1, 2]);
  });
});

describe('the stored definition', () => {
  it('splits the three module arrays into one table, numbered per kind', async () => {
    const id = new ObjectId();
    await mongo.collection('customfeeds').insertOne({
      _id: id,
      ownerOxyUserId: OWNER,
      title: 'bfg feed',
      definition: {
        mode: 'ranked',
        sources: [
          { module: 'bfg.source.a', enabled: true, params: { k: 1 } },
          { module: 'bfg.source.b', enabled: false },
        ],
        signals: [{ module: 'bfg.signal.a', enabled: true, weight: 0.5 }],
        filters: [{ module: 'bfg.filter.a', enabled: true }],
      },
    });
    await copy('customfeeds');

    const rows = await getDb()
      .select()
      .from(customFeedDefinitionModules)
      .where(eq(customFeedDefinitionModules.feedId, id.toHexString()));

    const byKind = (kind: string) =>
      rows.filter((row) => row.kind === kind).sort((a, b) => a.position - b.position);

    // `position` restarts per KIND — the unique key is (feed, kind, position)
    // and the three lists are independently ordered.
    expect(byKind('source').map((row) => row.position)).toStrictEqual([0, 1]);
    expect(byKind('signal').map((row) => row.position)).toStrictEqual([0]);
    expect(byKind('filter').map((row) => row.position)).toStrictEqual([0]);

    expect(byKind('source')[0]?.module).toBe('bfg.source.a');
    // The ONE genuinely shape-less value in the schema.
    expect(byKind('source')[0]?.params).toStrictEqual({ k: 1 });
    // An explicitly disabled module must stay disabled.
    expect(byKind('source')[1]?.enabled).toBe(false);
    expect(byKind('source')[1]?.params).toBeNull();
    expect(byKind('signal')[0]?.weight).toBe(0.5);
  });

  it('keeps definitionMode NULL for a feed that predates the composable phase', async () => {
    const id = new ObjectId();
    await mongo.collection('customfeeds').insertOne({
      _id: id,
      ownerOxyUserId: OWNER,
      title: 'bfg legacy',
      keywords: ['bfg'],
      includeReplies: false,
    });
    await copy('customfeeds');

    const [row] = await getDb()
      .select()
      .from(customFeeds)
      .where(eq(customFeeds.id, id.toHexString()));
    // Defaulting this would switch the feed off the request-time fallback and
    // onto an empty module list — an empty feed, with no error anywhere.
    expect(row?.definitionMode).toBeNull();
    // …and the legacy fields the fallback reads are copied alongside.
    expect(row?.keywords).toStrictEqual(['bfg']);
    expect(row?.includeReplies).toBe(false);
    expect(row?.includeBoosts).toBe(true);
  });

  it('REFUSES a module with no `enabled`, rather than guessing', async () => {
    const id = new ObjectId();
    await mongo.collection('customfeeds').insertOne({
      _id: id,
      ownerOxyUserId: OWNER,
      title: 'bfg feed',
      definition: { mode: 'ranked', sources: [{ module: 'bfg.source.a' }] },
    });

    // `required: true` in Mongo, NOT NULL here, and the two possible guesses
    // are opposite failures: `true` switches a disabled module on, `false`
    // switches an enabled one off.
    await expect(copy('customfeeds')).rejects.toThrow(/enabled/);
  });
});

describe('the denormalized counters', () => {
  it('copies them verbatim rather than recomputing from the rows', async () => {
    const id = new ObjectId();
    await mongo.collection('customfeeds').insertOne({
      _id: id,
      ownerOxyUserId: OWNER,
      title: 'bfg feed',
      subscriberCount: 12,
      averageRating: 4.5,
      ratingsCount: 4,
    });
    await copy('customfeeds');

    const [row] = await getDb()
      .select()
      .from(customFeeds)
      .where(eq(customFeeds.id, id.toHexString()));
    // A migration that recomputed these would repair data on the way past,
    // which hides whether they had drifted — a fact worth knowing after the
    // cutover, not silently erasing during it.
    expect(row?.subscriberCount).toBe(12);
    expect(row?.averageRating).toBe(4.5);
    expect(row?.ratingsCount).toBe(4);
  });

  it('reports a negative counter before anything is copied', async () => {
    await mongo.collection('customfeeds').insertOne({
      _id: new ObjectId(),
      ownerOxyUserId: OWNER,
      title: 'bfg feed',
      subscriberCount: -1,
    });

    const findings = await auditNumerics(source, planFor('customfeeds'));
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('custom_feeds_counts_check');
    expect(auditWouldBlockCopy(findings[0])).toBe(true);
  });

  it('accepts an unrated feed averaging ZERO, which the review floor forbids', async () => {
    // `custom_feeds.average_rating` is `between 0 and 5`; `feed_reviews.rating`
    // is `between 1 and 5`. Auditing the feed against the review's floor would
    // report every unrated feed as blocking.
    await mongo.collection('customfeeds').insertOne({
      _id: new ObjectId(),
      ownerOxyUserId: OWNER,
      title: 'bfg feed',
      averageRating: 0,
      ratingsCount: 0,
    });
    expect(await auditNumerics(source, planFor('customfeeds'))).toEqual([]);
  });
});

describe('the other feed collections', () => {
  it('flattens the generator source subdocument', async () => {
    const syncedAt = new Date('2025-03-04T05:06:07.008Z');
    await mongo.collection('feedgenerators').insertOne({
      _id: new ObjectId(),
      uri: GENERATOR_URI,
      name: 'bfg generator',
      algorithm: 'bfg.algo',
      createdBy: OWNER,
      source: { network: 'atproto', serviceDid: 'did:web:bfg.example', syncedAt },
    });
    await copy('feedgenerators');

    const [row] = await getDb()
      .select()
      .from(feedGenerators)
      .where(eq(feedGenerators.uri, GENERATOR_URI));
    expect(row?.sourceNetwork).toBe('atproto');
    expect(row?.sourceServiceDid).toBe('did:web:bfg.example');
    expect(row?.sourceSyncedAt).toStrictEqual(syncedAt);
  });

  it('leaves a NATIVE generator with no source triple at all', async () => {
    await mongo.collection('feedgenerators').insertOne({
      _id: new ObjectId(),
      uri: GENERATOR_URI,
      name: 'bfg native',
      algorithm: 'bfg.algo',
      createdBy: OWNER,
    });
    await copy('feedgenerators');

    const [row] = await getDb()
      .select()
      .from(feedGenerators)
      .where(eq(feedGenerators.uri, GENERATOR_URI));
    // All three absent together is what "native, not synced from Bluesky"
    // looks like — inventing a `network` would assert a provenance the source
    // never recorded.
    expect(row?.sourceNetwork).toBeNull();
    expect(row?.sourceServiceDid).toBeNull();
    expect(row?.sourceSyncedAt).toBeNull();
  });

  it('keeps the saved-feed layout, including the DISPLAY order', async () => {
    const id = new ObjectId();
    await mongo.collection('userfeedpreferences').insertOne({
      _id: id,
      oxyUserId: OWNER,
      savedFeeds: [
        { key: 'bfg-k1', descriptor: 'for_you', pinned: true, order: 2 },
        { key: 'bfg-k2', descriptor: 'following', order: 0 },
      ],
    });
    await copy('userfeedpreferences');

    const rows = await getDb()
      .select()
      .from(userSavedFeeds)
      .where(eq(userSavedFeeds.preferenceId, id.toHexString()));

    expect(rows).toHaveLength(2);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    // `order` is the arrangement the USER made, which is a different thing from
    // the array ordinal — a reordered layout rewrites it without moving array
    // elements, so reading the ordinal instead would silently reorder the tabs.
    expect(byKey.get('bfg-k1')?.order).toBe(2);
    expect(byKey.get('bfg-k2')?.order).toBe(0);
    expect(byKey.get('bfg-k1')?.pinned).toBe(true);
    expect(byKey.get('bfg-k2')?.pinned).toBe(false);
  });

  it('emits one topic row per DISTINCT topic id', async () => {
    const id = new ObjectId();
    await mongo.collection('customfeeds').insertOne({
      _id: id,
      ownerOxyUserId: OWNER,
      title: 'bfg feed',
      topicIds: ['bfg-t1', 'bfg-t2', 'bfg-t1'],
    });
    await copy('customfeeds');

    const rows = await getDb()
      .select()
      .from(customFeedTopics)
      .where(eq(customFeedTopics.feedId, id.toHexString()));
    expect(rows.map((row) => row.topicId).sort()).toStrictEqual(['bfg-t1', 'bfg-t2']);
  });
});
