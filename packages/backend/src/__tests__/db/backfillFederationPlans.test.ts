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
import { eq } from 'drizzle-orm';
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
import { auditEnums, auditWouldBlockCopy } from '../../db/backfill/audit';
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
const OWNER = 'bff-owner';
const ACTOR_URI = 'https://bff.example/users/remote';
const ACTOR_ACCT = 'remote@bff.example';
const REMOTE_MEDIA = 'https://bff.example/media/1.png';
const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nbff-secret-material\n-----END PRIVATE KEY-----';
const LAST_SYNC = new Date('2025-01-02T03:04:05.006Z');
const LOCKED_UNTIL = new Date('2025-01-02T03:14:05.006Z');

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
