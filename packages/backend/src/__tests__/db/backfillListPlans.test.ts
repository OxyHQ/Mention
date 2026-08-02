/**
 * The list plans — `accountlists` and `starterpacks`, two collections with the
 * same `memberOxyUserIds` shape and one genuinely different problem each.
 *
 * Three properties carry the weight, and none is visible column by column:
 *
 * - **A member junction has two unique keys that fail differently.** Deduping
 *   AFTER assigning positions leaves a GAP wherever a duplicate was removed, and
 *   `ON CONFLICT DO NOTHING` hides it. Same rule as `custom_feed_members`,
 *   tested again here because it is a property of THIS transform, not one it
 *   inherits.
 * - **`starter_pack_uses.created_at` is invented.** Mongo never recorded when a
 *   viewer used a pack, and the column is `NOT NULL DEFAULT now()`, so there is
 *   no "unknown" to write. Letting the default apply stamps the migration's
 *   clock on every historical use — which makes the whole imported set look
 *   brand new to the first recency-ordered surface anyone writes, and is not
 *   reproducible between two attempts of the same run.
 * - **A PARTIAL `source` is refused, not normalized.** Dropping the fragment
 *   makes an upstream-owned pack locally editable and lets the next atproto sync
 *   create a duplicate; inventing the missing field asserts a provenance the
 *   source never recorded. Both are damage, so the transform throws.
 *
 * Fixtures are `bfl-` prefixed and every cleanup is SCOPED to them. Nothing here
 * writes a row a global query selects on.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import {
  accountListMembers,
  accountLists,
  starterPackMembers,
  starterPackUses,
  starterPacks,
} from '../../db/schema/lists';
import { mongoSourceFromDb, type MongoSource } from '../../db/backfill/mongoSource';
import { copyCollection } from '../../db/backfill/runner';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import { auditUniqueness } from '../../db/backfill/audit';
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
const OWNER = 'bfl-owner';

const planFor = (collection: string) => {
  const plan = COLLECTION_PLANS.find((entry) => entry.collection === collection);
  if (!plan) throw new Error(`no plan for ${collection}`);
  return plan;
};

async function resolutions() {
  return createResolutionContext(await planResolutions(source), new ResolutionLog());
}

async function copy(collection: string) {
  return copyCollection(planFor(collection), {
    db: getDb(),
    source,
    resolutions: await resolutions(),
    parents: parentKeysFrom(new Map()),
  });
}

beforeAll(async () => {
  await connectPostgres();
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  mongo = client.db('backfill_lists_test');
  source = mongoSourceFromDb(mongo, async () => {
    await client.close();
  });
}, 120_000);

afterEach(async () => {
  const db = getDb();
  // Both junctions CASCADE from their parent, so the owner scope is enough.
  await db.delete(accountLists).where(eq(accountLists.ownerOxyUserId, OWNER));
  await db.delete(starterPacks).where(eq(starterPacks.ownerOxyUserId, OWNER));
  for (const name of await mongo.listCollections({}, { nameOnly: true }).toArray()) {
    await mongo.collection(name.name).deleteMany({});
  }
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
  await closePostgres();
});

describe('account lists', () => {
  it('copies the parent and defaults the two fields Mongo defaulted', async () => {
    const id = new ObjectId();
    const createdAt = new Date('2024-03-01T00:00:00.000Z');
    await mongo.collection('accountlists').insertOne({
      _id: id,
      ownerOxyUserId: OWNER,
      title: 'bfl list',
      // No `isPublic`, no `subscriberCount`, no `description` — the shape of a
      // document written before those fields, which is what `absentAs` on the
      // numeric audit promises the audit will not report.
      createdAt,
      updatedAt: createdAt,
    });
    await copy('accountlists');

    const [row] = await getDb()
      .select()
      .from(accountLists)
      .where(eq(accountLists.id, id.toHexString()));

    expect(row?.title).toBe('bfl list');
    expect(row?.description).toBeNull();
    // Mongo's default is `true`, and a list that silently became private would
    // disappear from the marketplace with no error.
    expect(row?.isPublic).toBe(true);
    expect(row?.subscriberCount).toBe(0);
    expect(row?.createdAt).toStrictEqual(createdAt);
  });

  it('dedupes members BEFORE assigning positions, so the positions stay dense', async () => {
    const id = new ObjectId();
    await mongo.collection('accountlists').insertOne({
      _id: id,
      ownerOxyUserId: OWNER,
      title: 'bfl list',
      // `bfl-a` twice. Legal in Mongo; it violates BOTH unique keys here if the
      // transform emits it twice.
      memberOxyUserIds: ['bfl-a', 'bfl-b', 'bfl-a', 'bfl-c'],
    });
    await copy('accountlists');

    const rows = await getDb()
      .select()
      .from(accountListMembers)
      .where(eq(accountListMembers.listId, id.toHexString()))
      .orderBy(accountListMembers.position);

    expect(rows.map((row) => row.oxyUserId)).toStrictEqual(['bfl-a', 'bfl-b', 'bfl-c']);
    // Deduping after positioning would leave 0, 1, 3 — a gap nothing errors on
    // and nothing later can tell from a deliberately sparse ordering.
    expect(rows.map((row) => row.position)).toStrictEqual([0, 1, 2]);
  });
});

describe('starter packs', () => {
  it('flattens a complete source and leaves a native pack all-NULL', async () => {
    const sourced = new ObjectId();
    const native = new ObjectId();
    const syncedAt = new Date('2024-05-05T00:00:00.000Z');
    await mongo.collection('starterpacks').insertMany([
      {
        _id: sourced,
        ownerOxyUserId: OWNER,
        name: 'bfl mirrored',
        source: {
          network: 'atproto',
          uri: 'at://bfl.example/app.bsky.graph.starterpack/one',
          syncedAt,
        },
      },
      { _id: native, ownerOxyUserId: OWNER, name: 'bfl native' },
    ]);
    await copy('starterpacks');

    const [mirrored] = await getDb()
      .select()
      .from(starterPacks)
      .where(eq(starterPacks.id, sourced.toHexString()));
    expect(mirrored?.sourceNetwork).toBe('atproto');
    expect(mirrored?.sourceUri).toBe('at://bfl.example/app.bsky.graph.starterpack/one');
    expect(mirrored?.sourceSyncedAt).toStrictEqual(syncedAt);

    const [local] = await getDb()
      .select()
      .from(starterPacks)
      .where(eq(starterPacks.id, native.toHexString()));
    // All three NULL is the other half of the all-or-nothing CHECK, and it is
    // the majority case — a native pack must not acquire a provenance.
    expect(local?.sourceNetwork).toBeNull();
    expect(local?.sourceUri).toBeNull();
    expect(local?.sourceSyncedAt).toBeNull();
  });

  it('REFUSES a partial source rather than dropping or inventing a field', async () => {
    const id = new ObjectId();
    await mongo.collection('starterpacks').insertOne({
      _id: id,
      ownerOxyUserId: OWNER,
      name: 'bfl half-mirrored',
      // A hand-run `$set` on one dotted path is the only way this arises — the
      // mapper writes the whole subdocument at once.
      source: { network: 'atproto', uri: 'at://bfl.example/app.bsky.graph.starterpack/two' },
    });

    // Asserting WHICH refusal, not merely that it refused: a plan can fail for
    // a required field, a missing table or a constraint, and "it threw" would
    // pass on any of them.
    await expect(copy('starterpacks')).rejects.toThrow(
      /starter_packs_source_complete_check/
    );
    // The count query is what makes a first-instance abort actionable — without
    // it an operator fixes one document and re-runs to find the next.
    await expect(copy('starterpacks')).rejects.toThrow(/db\.starterpacks\.countDocuments/);
  });

  it('dedupes uses and dates them from the PACK, not from the migration clock', async () => {
    const id = new ObjectId();
    const createdAt = new Date('2023-11-11T00:00:00.000Z');
    const startedAt = new Date();
    await mongo.collection('starterpacks').insertOne({
      _id: id,
      ownerOxyUserId: OWNER,
      name: 'bfl used',
      usedByOxyUserIds: ['bfl-u1', 'bfl-u2', 'bfl-u1'],
      useCount: 2,
      createdAt,
      updatedAt: createdAt,
    });
    await copy('starterpacks');

    const rows = await getDb()
      .select()
      .from(starterPackUses)
      .where(eq(starterPackUses.packId, id.toHexString()))
      .orderBy(starterPackUses.oxyUserId);

    expect(rows.map((row) => row.oxyUserId)).toStrictEqual(['bfl-u1', 'bfl-u2']);
    // The whole point: a `now()` default would put these AFTER `startedAt` and
    // rank every migrated use above every genuine one on any recency surface.
    for (const row of rows) {
      expect(row.createdAt).toStrictEqual(createdAt);
      expect(row.createdAt.getTime()).toBeLessThan(startedAt.getTime());
    }
    // `use_count` is copied, never recomputed from the rows — Mongo incremented
    // the counter and pushed onto the array as separate operations, so the two
    // can genuinely disagree and the migration must not repair that on the way
    // past. Here the source says 2 and the deduped rows also number 2; the
    // assertion that matters is that the counter came from the DOCUMENT.
    const [pack] = await getDb()
      .select()
      .from(starterPacks)
      .where(eq(starterPacks.id, id.toHexString()));
    expect(pack?.useCount).toBe(2);
  });

  it('lets the default apply for a pack with no createdAt of its own', async () => {
    const id = new ObjectId();
    const before = new Date();
    await mongo.collection('starterpacks').insertOne({
      _id: id,
      ownerOxyUserId: OWNER,
      name: 'bfl undated',
      usedByOxyUserIds: ['bfl-u3'],
    });
    await copy('starterpacks');

    const [row] = await getDb()
      .select()
      .from(starterPackUses)
      .where(eq(starterPackUses.packId, id.toHexString()));

    // There is nothing better to reach for than the clock here, and the point
    // of the case is that this branch EXISTS: writing `new Date()` at the call
    // site instead would take this path for every pack whose `createdAt` the
    // transform failed to read, silently.
    expect(row?.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  it('dedupes members BEFORE assigning positions, like the list junction', async () => {
    const id = new ObjectId();
    await mongo.collection('starterpacks').insertOne({
      _id: id,
      ownerOxyUserId: OWNER,
      name: 'bfl members',
      // The duplicate must be in the MIDDLE, and that is not a stylistic
      // choice: with it LAST, removing the dedup still yields dense positions
      // (the conflicting row is the highest one, so `ON CONFLICT DO NOTHING`
      // drops it and leaves no gap) and the case passes over the bug. Measured
      // — the first draft of this fixture read `['bfl-m1','bfl-m2','bfl-m1']`
      // and survived the mutation that deleted the dedup.
      memberOxyUserIds: ['bfl-m1', 'bfl-m2', 'bfl-m1', 'bfl-m3'],
    });
    await copy('starterpacks');

    const rows = await getDb()
      .select()
      .from(starterPackMembers)
      .where(eq(starterPackMembers.packId, id.toHexString()))
      .orderBy(starterPackMembers.position);

    expect(rows.map((row) => row.oxyUserId)).toStrictEqual(['bfl-m1', 'bfl-m2', 'bfl-m3']);
    expect(rows.map((row) => row.position)).toStrictEqual([0, 1, 2]);
  });
});

describe('the sparse source-uri uniqueness audit', () => {
  it('reports two packs mirroring one remote pack', async () => {
    const uri = 'at://bfl.example/app.bsky.graph.starterpack/dup';
    await mongo.collection('starterpacks').insertMany([
      {
        _id: new ObjectId(),
        ownerOxyUserId: OWNER,
        name: 'bfl dup a',
        source: { network: 'atproto', uri, syncedAt: new Date() },
      },
      {
        _id: new ObjectId(),
        ownerOxyUserId: OWNER,
        name: 'bfl dup b',
        source: { network: 'atproto', uri, syncedAt: new Date() },
      },
    ]);

    const findings = await auditUniqueness(
      source,
      planFor('starterpacks'),
      await resolutions()
    );
    expect(findings.map((finding) => finding.detail).join('\n')).toContain(
      'starter_packs_source_uri_key'
    );
  });

  it('does NOT report the packs that carry no source at all', async () => {
    // The index is PARTIAL and Postgres is NULLS DISTINCT, so any number of
    // native packs coexist. An audit that coalesced the absent uri to `''`
    // would group all of them and block a run over data Postgres accepts —
    // which is the false positive that gets a gate deleted by whoever hits it.
    //
    // What this case does NOT prove: the plan's `where` predicate is doing the
    // work. Two mechanisms exclude these rows and either alone suffices —
    // measured, deleting `where` leaves this green and so does deleting
    // `auditUniqueness`'s presence filter; only deleting both turns it red. The
    // property is guarded; the particular declaration is not.
    await mongo.collection('starterpacks').insertMany([
      { _id: new ObjectId(), ownerOxyUserId: OWNER, name: 'bfl native a' },
      { _id: new ObjectId(), ownerOxyUserId: OWNER, name: 'bfl native b' },
      { _id: new ObjectId(), ownerOxyUserId: OWNER, name: 'bfl native c' },
    ]);

    const findings = await auditUniqueness(
      source,
      planFor('starterpacks'),
      await resolutions()
    );
    expect(findings).toStrictEqual([]);
  });
});
