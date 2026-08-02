/**
 * The federation plans: identity, follows, media cache, delivery queue.
 *
 * Three properties here are load-bearing in a way a column-by-column check
 * would not express, and each has a case:
 *
 * - **`privateKeyPem` is copied verbatim.** It signs every outbound HTTP
 *   signature and there is no regeneration path — a changed key makes every
 *   previously federated post unverifiable and every remote instance reject the
 *   actor until it re-fetches.
 * - **`lastOutboxSyncAt` and the backfill LEASE are carried, not reset.**
 *   `AGENTS.md` records that a stale `lastOutboxSyncAt` makes an empty first
 *   sync PERMANENT, because the cooldown never lets it retry. Resetting it here
 *   would silently re-crawl every remote actor on the first post-cutover sweep;
 *   dropping the cursor would strand every partial crawl mid-way.
 * - **`migratedToBullmq` survives.** Outbound delivery moved to BullMQ and that
 *   flag is the only thing stopping a restart enqueueing the same activity
 *   twice. Losing it duplicates deliveries; inverting it drops them.
 *
 * Fixtures are prefixed `bff-` and every cleanup is SCOPED — vitest runs one
 * worker per file against ONE database. Nothing here writes a row any global
 * query selects on.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { eq, like } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import {
  actorKeyPairs,
  federatedActorFields,
  federatedActors,
  federatedFollows,
  federatedMediaCache,
  federationDeliveryQueue,
} from '../../db/schema/federation';
import { mongoSourceFromDb, type MongoSource } from '../../db/backfill/mongoSource';
import { copyCollection } from '../../db/backfill/runner';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import { auditEnums, auditUniqueness, auditWouldBlockCopy } from '../../db/backfill/audit';
import {
  createResolutionContext,
  federatedActorDuplicatesToDrop,
  KEEP_FRESHEST_FEDERATED_ACTOR,
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

/** Scoped to this file — see the header. */
const OWNER = 'bff-owner';
const ACTOR_URI = 'https://bff.example/users/remote';
const ACTOR_ACCT = 'remote@bff.example';
const REMOTE_MEDIA = 'https://bff.example/media/1.png';
const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nbff-secret-material\n-----END PRIVATE KEY-----';
const LAST_SYNC = new Date('2025-01-02T03:04:05.006Z');
const LOCKED_UNTIL = new Date('2025-01-02T03:14:05.006Z');
/** The colliding-actor cases below; cleaned by prefix, never by exact uri. */
const DUP_URI_PREFIX = 'https://bff-dup.example/users/';

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
  mongo = client.db('backfill_federation_test');
  source = mongoSourceFromDb(mongo, async () => {
    await client.close();
  });
}, 120_000);

afterEach(async () => {
  const db = getDb();
  // `federated_actor_fields` CASCADEs from `federated_actors`.
  await db.delete(actorKeyPairs).where(eq(actorKeyPairs.oxyUserId, OWNER));
  await db.delete(federatedActors).where(eq(federatedActors.uri, ACTOR_URI));
  await db.delete(federatedActors).where(like(federatedActors.uri, `${DUP_URI_PREFIX}%`));
  await db.delete(federatedFollows).where(eq(federatedFollows.localUserId, OWNER));
  await db.delete(federatedMediaCache).where(eq(federatedMediaCache.remoteUrl, REMOTE_MEDIA));
  await db
    .delete(federationDeliveryQueue)
    .where(eq(federationDeliveryQueue.senderOxyUserId, OWNER));
  for (const name of await mongo.listCollections({}, { nameOnly: true }).toArray()) {
    await mongo.collection(name.name).deleteMany({});
  }
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
  await closePostgres();
});

describe('the signing key', () => {
  it('copies the private key byte for byte', async () => {
    const id = new ObjectId();
    await mongo.collection('actorkeypairs').insertOne({
      _id: id,
      oxyUserId: OWNER,
      publicKeyPem: 'bff-public',
      privateKeyPem: PRIVATE_KEY,
      keyId: `${ACTOR_URI}#main-key`,
    });
    await copy('actorkeypairs');

    const [row] = await getDb()
      .select()
      .from(actorKeyPairs)
      .where(eq(actorKeyPairs.oxyUserId, OWNER));
    // Not normalised, not re-wrapped, not re-encoded. A single changed byte
    // invalidates every signature this actor has ever produced.
    expect(row?.privateKeyPem).toBe(PRIVATE_KEY);
    expect(row?.keyId).toBe(`${ACTOR_URI}#main-key`);
  });
});

describe('the federated actor', () => {
  async function seedActor(id: ObjectId, extra: Record<string, unknown> = {}) {
    await mongo.collection('federatedactors').insertOne({
      _id: id,
      uri: ACTOR_URI,
      username: 'remote',
      domain: 'bff.example',
      acct: ACTOR_ACCT,
      ...extra,
    });
  }

  it('carries the sticky sync stamp and the backfill lease rather than resetting them', async () => {
    const id = new ObjectId();
    await seedActor(id, {
      lastOutboxSyncAt: LAST_SYNC,
      outboxBackfill: {
        status: 'pending',
        outboxUrl: 'https://bff.example/users/remote/outbox',
        cursorUrl: 'https://bff.example/users/remote/outbox?page=3',
        cursorItemOffset: 7,
        processedCount: 42,
        importedCount: 40,
        existingCount: 2,
        pageCount: 3,
        lockedUntil: LOCKED_UNTIL,
      },
    });
    await copy('federatedactors');

    const [row] = await getDb()
      .select()
      .from(federatedActors)
      .where(eq(federatedActors.uri, ACTOR_URI));

    // Resetting this would re-crawl every remote actor on the first
    // post-cutover sweep; it is also the value an operator clears BY HAND to
    // recover from the sticky-empty-sync outage, so it has to arrive intact.
    expect(row?.lastOutboxSyncAt).toStrictEqual(LAST_SYNC);
    // The cursor is what makes a partial crawl resumable.
    expect(row?.outboxBackfillCursorUrl).toBe(
      'https://bff.example/users/remote/outbox?page=3'
    );
    expect(row?.outboxBackfillCursorItemOffset).toBe(7);
    expect(row?.outboxBackfillProcessedCount).toBe(42);
    // A LEASE, expired or not — clearing it would let a second worker claim a
    // crawl the first may still be running.
    expect(row?.outboxBackfillLockedUntil).toStrictEqual(LOCKED_UNTIL);
  });

  it('leaves an unadvertised outbox URL NULL rather than guessing it', async () => {
    const id = new ObjectId();
    await seedActor(id);
    await copy('federatedactors');

    const [row] = await getDb()
      .select()
      .from(federatedActors)
      .where(eq(federatedActors.uri, ACTOR_URI));
    // `actorUri + '/outbox'` breaks PeerTube, Lemmy and some Pleroma. The
    // fallback belongs to the sync path, which knows it is guessing.
    expect(row?.outboxUrl).toBeNull();
    // And the defaults the model applies on write are re-applied here.
    expect(row?.protocol).toBe('activitypub');
    expect(row?.type).toBe('Person');
    expect(row?.discoverable).toBe(true);
    expect(row?.suspended).toBe(false);
  });

  it('turns the profile fields into ordered child rows', async () => {
    const id = new ObjectId();
    const verifiedAt = new Date('2024-11-12T13:14:15.016Z');
    await seedActor(id, {
      fields: [
        { name: 'Website', value: 'https://bff.example', verifiedAt },
        { name: 'Pronouns', value: 'they/them' },
      ],
    });
    await copy('federatedactors');

    const rows = await getDb()
      .select()
      .from(federatedActorFields)
      .where(eq(federatedActorFields.actorId, id.toHexString()))
      .orderBy(federatedActorFields.position);

    expect(rows.map((row) => row.name)).toStrictEqual(['Website', 'Pronouns']);
    expect(rows.map((row) => row.position)).toStrictEqual([0, 1]);
    expect(rows[0]?.verifiedAt).toStrictEqual(verifiedAt);
    expect(rows[1]?.verifiedAt).toBeNull();
  });

  it('reports an actor type the CHECK would refuse', async () => {
    await mongo.collection('federatedactors').insertOne({
      _id: new ObjectId(),
      uri: ACTOR_URI,
      username: 'remote',
      domain: 'bff.example',
      acct: ACTOR_ACCT,
      type: 'Bot',
    });

    const findings = await auditEnums(source, planFor('federatedactors'));
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('Bot');
    expect(auditWouldBlockCopy(findings[0])).toBe(true);
  });
});

describe('the delivery queue', () => {
  it('copies the activity document and the migration flag verbatim', async () => {
    const id = new ObjectId();
    const activity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      type: 'Create',
      object: { type: 'Note', content: 'bff body' },
    };
    await mongo.collection('federationdeliveryqueues').insertOne({
      _id: id,
      activityJson: activity,
      targetInbox: 'https://bff.example/inbox',
      senderOxyUserId: OWNER,
      nextAttemptAt: new Date('2025-02-03T04:05:06.007Z'),
      migratedToBullmq: true,
    });
    await copy('federationdeliveryqueues');

    const [row] = await getDb()
      .select()
      .from(federationDeliveryQueue)
      .where(eq(federationDeliveryQueue.senderOxyUserId, OWNER));

    expect(row?.activityJson).toStrictEqual(activity);
    // The only thing stopping a restart enqueueing the same delivery twice.
    expect(row?.migratedToBullmq).toBe(true);
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(0);
  });

  it('defaults an absent migration flag to false, matching every reader', async () => {
    await mongo.collection('federationdeliveryqueues').insertOne({
      _id: new ObjectId(),
      activityJson: { type: 'Delete' },
      targetInbox: 'https://bff.example/inbox',
      senderOxyUserId: OWNER,
      nextAttemptAt: new Date(),
    });
    await copy('federationdeliveryqueues');

    const [row] = await getDb()
      .select()
      .from(federationDeliveryQueue)
      .where(eq(federationDeliveryQueue.senderOxyUserId, OWNER));
    // Mongo stored ABSENT or a boolean and every reader tests truthiness.
    // Getting this backwards re-enqueues an already-migrated delivery.
    expect(row?.migratedToBullmq).toBe(false);
  });

  it('REFUSES a row with no next-attempt time rather than inventing one', async () => {
    await mongo.collection('federationdeliveryqueues').insertOne({
      _id: new ObjectId(),
      activityJson: { type: 'Create' },
      targetInbox: 'https://bff.example/inbox',
      senderOxyUserId: OWNER,
    });

    // `NOT NULL` with no default, and it is the backoff gate the drain query
    // orders on — substituting a value would change when this delivery runs.
    await expect(copy('federationdeliveryqueues')).rejects.toThrow(/nextAttemptAt/);
  });
});

describe('follows and the media cache', () => {
  it('copies a follow with its direction and activity id', async () => {
    await mongo.collection('federatedfollows').insertOne({
      _id: new ObjectId(),
      localUserId: OWNER,
      remoteActorUri: ACTOR_URI,
      direction: 'inbound',
      status: 'accepted',
      activityId: 'https://bff.example/activities/follow/1',
    });
    await copy('federatedfollows');

    const [row] = await getDb()
      .select()
      .from(federatedFollows)
      .where(eq(federatedFollows.localUserId, OWNER));
    expect(row).toMatchObject({ direction: 'inbound', status: 'accepted' });
    // The AP activity id the Undo path needs.
    expect(row?.activityId).toBe('https://bff.example/activities/follow/1');
    expect(row?.network).toBe('activitypub');
  });

  it('leaves an uncached media row NULL rather than empty-stringing the file ids', async () => {
    await mongo.collection('federatedmediacaches').insertOne({
      _id: new ObjectId(),
      remoteUrl: REMOTE_MEDIA,
      state: 'pending',
      failCount: 2,
    });
    await copy('federatedmediacaches');

    const [row] = await getDb()
      .select()
      .from(federatedMediaCache)
      .where(eq(federatedMediaCache.remoteUrl, REMOTE_MEDIA));
    // NULL is "not cached", which `decideProxyServe` tests for; `''` would be a
    // file id that resolves to nothing.
    expect(row?.oxyFileId).toBeNull();
    expect(row?.posterFileId).toBeNull();
    expect(row?.failCount).toBe(2);
    expect(row?.state).toBe('pending');
  });
});

/**
 * The duplicate-actor collisions, and the rule that answers them at COPY TIME.
 *
 * Production holds 569 groups of `federatedactors` documents sharing one `uri`,
 * because the upsert that writes them filters on a column MongoDB has no unique
 * index for (`autoIndex` is off and no migration ever created the three the
 * schema declares), so two concurrent resolutions of a first-seen actor both
 * miss the read and both insert. The count is still GROWING, which is the whole
 * reason this is a resolution rule rather than a script: a dedup run tonight is
 * stale by morning, while a copy-time rule is correct however many groups exist
 * at the moment the copy runs.
 *
 * Sizes matter here and a PAIR is the case that cannot see the bug. Two rows
 * cannot distinguish "sorted by freshest" from "reversed", and cannot show a
 * survivor that is neither the lowest nor the highest `_id`. Every case below
 * therefore uses a three-way group, a twenty-one-way group, or both.
 */
describe('duplicate federated actors', () => {
  /** `_id`s that sort ASCENDING in insertion order, so the tie-break is observable. */
  const oid = (n: number) => new ObjectId(`6a3b060e272930c46a78${String(n).padStart(4, '0')}`);

  async function seedGroup(
    uri: string,
    rows: ReadonlyArray<{ id: ObjectId; lastFetchedAt?: Date; postsCount?: number }>
  ) {
    await mongo.collection('federatedactors').insertMany(
      rows.map((row) => ({
        _id: row.id,
        uri,
        username: 'dup',
        domain: 'bff-dup.example',
        acct: `dup@bff-dup.example`,
        ...(row.lastFetchedAt === undefined ? {} : { lastFetchedAt: row.lastFetchedAt }),
        ...(row.postsCount === undefined ? {} : { postsCount: row.postsCount }),
      }))
    );
  }

  /**
   * What phase 1 of the referential audit measures, for one group.
   *
   * Assembled from a real `transformDocument` walk rather than read off the
   * copy: `documentsDroppedByRule` is the number that separates "a rule decided
   * to remove this" from "the transform lost it", and only the resolution log
   * knows it.
   */
  async function walkEmission(uri: string) {
    const log = new ResolutionLog();
    const resolutions = createResolutionContext(await planResolutions(source), log);
    let documentsRead = 0;
    let primaryRowsEmitted = 0;
    for await (const doc of mongo.collection('federatedactors').find({ uri })) {
      documentsRead += 1;
      transformDocument(
        planFor('federatedactors'),
        doc as Record<string, unknown>,
        resolutions,
        parentKeysFrom(new Map()),
        (row) => {
          if (row.table === federatedActors) primaryRowsEmitted += 1;
        }
      );
    }
    return {
      collection: 'federatedactors',
      documentsRead,
      primaryRowsEmitted,
      documentsDroppedByRule: resolutions.documentsDroppedIn('federatedactors'),
    };
  }

  describe('the survivor choice', () => {
    // A pure test of the ORDER, because the order IS the rule. Driven directly
    // so the twenty-one-way case is exercised without seeding 21 documents to
    // observe one comparison.
    it('keeps the freshest of a THREE-way group, even when it is neither the first nor the last id', () => {
      const rows = [
        { id: '00000000000000000000000a', lastFetchedAt: new Date('2026-06-01T00:00:00Z') },
        // The middle id, and the freshest — the case a pair cannot express.
        { id: '00000000000000000000000b', lastFetchedAt: new Date('2026-07-01T00:00:00Z') },
        { id: '00000000000000000000000c', lastFetchedAt: new Date('2026-05-01T00:00:00Z') },
      ];
      expect(federatedActorDuplicatesToDrop(rows).sort()).toEqual([
        '00000000000000000000000a',
        '00000000000000000000000c',
      ]);
    });

    it('keeps exactly one of a TWENTY-ONE-way group and drops the other twenty', () => {
      const rows = Array.from({ length: 21 }, (_, index) => ({
        id: `0000000000000000000000${String(index).padStart(2, '0')}`,
        // Freshest in the MIDDLE of the group, so neither "first wins" nor
        // "last wins" can pass by accident.
        lastFetchedAt: new Date(2026, 0, index === 10 ? 31 : 1 + index),
      }));
      const dropped = federatedActorDuplicatesToDrop(rows);
      expect(dropped).toHaveLength(20);
      expect(dropped).not.toContain('000000000000000000000010');
    });

    it('sorts a row that was NEVER re-fetched last, whatever its id', () => {
      const rows = [
        { id: '00000000000000000000000f', lastFetchedAt: undefined },
        { id: '00000000000000000000000a', lastFetchedAt: new Date('2020-01-01T00:00:00Z') },
      ];
      // NULLS LAST: a row with no `lastFetchedAt` was never refreshed after its
      // insert, so it is the frozen copy — even against a survivor last fetched
      // in 2020, and even though its id sorts higher.
      expect(federatedActorDuplicatesToDrop(rows)).toEqual(['00000000000000000000000f']);
    });

    it('breaks an exact tie on id DESCENDING, so two phases of one run cannot disagree', () => {
      const at = new Date('2026-07-01T00:00:00Z');
      const rows = [
        { id: '00000000000000000000000a', lastFetchedAt: at },
        { id: '00000000000000000000000c', lastFetchedAt: at },
        { id: '00000000000000000000000b', lastFetchedAt: at },
      ];
      // The same tie-break `findActorByOxyUserId` applies (`last_fetched_at desc
      // nulls last, id desc`), so the migration and the live reader choose the
      // same row by construction.
      expect(federatedActorDuplicatesToDrop(rows).sort()).toEqual([
        '00000000000000000000000a',
        '00000000000000000000000b',
      ]);
    });

    it('leaves a group of one alone', () => {
      expect(federatedActorDuplicatesToDrop([{ id: 'x', lastFetchedAt: new Date() }])).toEqual([]);
    });
  });

  it('copies ONE row for a three-way collision — the maintained one, with its own column values', async () => {
    const uri = `${DUP_URI_PREFIX}three`;
    await seedGroup(uri, [
      { id: oid(1), lastFetchedAt: new Date('2026-06-23T23:47:25.940Z'), postsCount: 11 },
      { id: oid(2), lastFetchedAt: new Date('2026-07-15T04:47:42.330Z'), postsCount: 99 },
      { id: oid(3), postsCount: 7 },
    ]);

    await copy('federatedactors');

    const rows = await getDb().select().from(federatedActors).where(eq(federatedActors.uri, uri));
    expect(rows).toHaveLength(1);
    // Not merely "a row survived": the SURVIVOR's own values. `postsCount` is
    // read from the maintained row, which is the one the resolver kept current
    // — a merge would have taken the max and this asserts it did not.
    expect(rows[0]?.id).toBe(oid(2).toHexString());
    expect(rows[0]?.postsCount).toBe(99);

    // The two removals are a DECISION, not data loss, and the migration says so
    // with the same numbers: three documents read, one row emitted, two dropped
    // BY RULE. `droppedDocuments` is what accuses a transform of losing data,
    // and it must stay at zero.
    const emission = await walkEmission(uri);
    expect(emission.documentsRead).toBe(3);
    expect(emission.primaryRowsEmitted).toBe(1);
    expect(emission.documentsDroppedByRule).toBe(2);
    expect(droppedDocuments(emission)).toBe(0);
  });

  it('copies ONE row for a TWENTY-ONE-way collision', async () => {
    const uri = `${DUP_URI_PREFIX}twentyone`;
    await seedGroup(
      uri,
      Array.from({ length: 21 }, (_, index) => ({
        id: oid(100 + index),
        lastFetchedAt: new Date(2026, 0, index === 13 ? 28 : 1 + index),
      }))
    );

    await copy('federatedactors');

    const rows = await getDb().select().from(federatedActors).where(eq(federatedActors.uri, uri));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(oid(113).toHexString());

    const emission = await walkEmission(uri);
    expect(emission.documentsRead).toBe(21);
    expect(emission.primaryRowsEmitted).toBe(1);
    expect(emission.documentsDroppedByRule).toBe(20);
    expect(droppedDocuments(emission)).toBe(0);
  });

  it('reports every dropped document BY ID under the rule', async () => {
    const uri = `${DUP_URI_PREFIX}reported`;
    await seedGroup(uri, [
      { id: oid(21), lastFetchedAt: new Date('2026-01-01T00:00:00Z') },
      { id: oid(22), lastFetchedAt: new Date('2026-02-01T00:00:00Z') },
      { id: oid(23), lastFetchedAt: new Date('2026-03-01T00:00:00Z') },
    ]);

    const log = new ResolutionLog();
    await copyCollection(planFor('federatedactors'), {
      db: getDb(),
      source,
      resolutions: createResolutionContext(await planResolutions(source), log),
      parents: parentKeysFrom(new Map()),
    });

    const summary = log
      .summary()
      .find((entry) => entry.rule.id === KEEP_FRESHEST_FEDERATED_ACTOR.id);
    // BY ID — a rule that acted on rows it cannot name has not reported
    // anything an operator can check against the audit.
    expect(summary?.documentIds).toEqual([oid(21).toHexString(), oid(22).toHexString()]);
  });

  it('stops the uniqueness finding BLOCKING, without silencing it', async () => {
    const uri = `${DUP_URI_PREFIX}audited`;
    await seedGroup(uri, [
      { id: oid(31), lastFetchedAt: new Date('2026-01-01T00:00:00Z') },
      { id: oid(32), lastFetchedAt: new Date('2026-02-01T00:00:00Z') },
      { id: oid(33), lastFetchedAt: new Date('2026-03-01T00:00:00Z') },
    ]);

    const resolutions = createResolutionContext(await planResolutions(source), new ResolutionLog());
    const findings = await auditUniqueness(source, planFor('federatedactors'), resolutions);
    const uriFinding = findings.find((entry) => entry.detail.includes('federated_actors_uri_key'));

    // Still COMPUTED, still COUNTED, still PRINTED with its ids — carrying the
    // rule that answers it. A resolution that made the finding disappear would
    // be a silenced check.
    expect(uriFinding).toBeDefined();
    expect(uriFinding?.documents).toBe(3);
    expect(uriFinding?.sampleIds).toHaveLength(3);
    expect(uriFinding?.resolvedBy?.id).toBe(KEEP_FRESHEST_FEDERATED_ACTOR.id);
    expect(auditWouldBlockCopy(uriFinding as NonNullable<typeof uriFinding>)).toBe(false);
  });

  it('still BLOCKS an acct collision across DIFFERENT uris — the rule fails closed', async () => {
    // The `handle.invalid` shape: distinct actors that a derivation bug gave one
    // identity. The rule groups on `uri` alone, so it does not touch these — and
    // `resolvesUniquenessGroup` requires all-but-one acted on, so the finding
    // keeps blocking rather than being cleared by a rule written for something
    // else. Dropping 20 of these would delete 20 real Bluesky accounts.
    await mongo.collection('federatedactors').insertMany(
      Array.from({ length: 3 }, (_, index) => ({
        _id: oid(41 + index),
        uri: `${DUP_URI_PREFIX}sentinel-${index}`,
        username: 'handle.invalid',
        domain: 'bsky.social',
        acct: 'handle.invalid',
        lastFetchedAt: new Date(2026, 0, 1 + index),
      }))
    );

    const resolutions = createResolutionContext(await planResolutions(source), new ResolutionLog());
    const findings = await auditUniqueness(source, planFor('federatedactors'), resolutions);
    const acctFinding = findings.find((entry) =>
      entry.detail.includes('federated_actors_acct_key')
    );

    expect(acctFinding).toBeDefined();
    expect(acctFinding?.resolvedBy).toBeUndefined();
    expect(auditWouldBlockCopy(acctFinding as NonNullable<typeof acctFinding>)).toBe(true);
  });
});
