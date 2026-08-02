/**
 * The blocklist-intelligence and domain-purge plans.
 *
 * These are copied rather than regenerated for one reason: a sweep can recompute
 * corroboration, and cannot recompute a PERSON having said no. 751
 * `blocklistproposals` rows exist in production, and
 * `blocklist_proposals.decision_reason` is the only record anywhere of why a
 * corroborated domain is NOT blocked. Lose it and the next sweep re-proposes
 * every declined domain — a report that re-lists what a person already rejected,
 * which is exactly the rot the collection exists to prevent.
 *
 * Three properties carry the weight:
 *
 * - **A declined proposal keeps its author, timestamp and reason**, and NULL on
 *   those three means "no person has decided" — a different state from any
 *   string a default could supply.
 * - **`measured` on a purge row is ABSENT-OR-COMPLETE.** Mongo's subdocument was
 *   `default: undefined`, and zero is a real measurement (a purge that would
 *   remove nothing), so eight zeros for a domain never measured would claim a
 *   dry run that never happened.
 * - **`ok: false` on a run must survive.** It is the flag that says an empty
 *   result meant "we could not look" rather than "there is nothing to block" —
 *   the two read identically and nothing else distinguishes them.
 *
 * Fixtures are `bfb-` prefixed and every cleanup is SCOPED.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import {
  blockedDomainPurgeRuns,
  blockedDomainPurges,
  blocklistProposalObservations,
  blocklistProposalRunSources,
  blocklistProposalRuns,
  blocklistProposals,
} from '../../db/schema/blocklist';
import { mongoSourceFromDb, type MongoSource } from '../../db/backfill/mongoSource';
import { copyCollection } from '../../db/backfill/runner';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
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
const DOMAIN = 'bfb-example.test';
const RUN_ID = 'bfb-run-1';

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

/** The eight-leaf counts subdocument, all zeros. */
const NO_COUNTS = {
  posts: 0,
  actors: 0,
  boosts: 0,
  likes: 0,
  notifications: 0,
  mediaCacheRows: 0,
  localContentKept: 0,
  localFollowsRemoved: 0,
};

beforeAll(async () => {
  await connectPostgres();
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  mongo = client.db('backfill_blocklist_test');
  source = mongoSourceFromDb(mongo, async () => {
    await client.close();
  });
}, 120_000);

afterEach(async () => {
  const db = getDb();
  // Observations and run sources CASCADE from their parents.
  await db.delete(blocklistProposals).where(eq(blocklistProposals.domain, DOMAIN));
  await db.delete(blocklistProposalRuns).where(eq(blocklistProposalRuns.runId, RUN_ID));
  await db.delete(blockedDomainPurges).where(eq(blockedDomainPurges.domain, DOMAIN));
  await db.delete(blockedDomainPurgeRuns).where(eq(blockedDomainPurgeRuns.domain, DOMAIN));
  for (const name of await mongo.listCollections({}, { nameOnly: true }).toArray()) {
    await mongo.collection(name.name).deleteMany({});
  }
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
  await closePostgres();
});

describe('blocklist proposals', () => {
  it("keeps a declined proposal's author, time and reason", async () => {
    const id = new ObjectId();
    const decidedAt = new Date('2025-04-04T00:00:00.000Z');
    await mongo.collection('blocklistproposals').insertOne({
      _id: id,
      domain: DOMAIN,
      status: 'declined',
      firstProposedAt: new Date('2025-01-01T00:00:00.000Z'),
      lastSeenAt: new Date('2025-04-01T00:00:00.000Z'),
      operatorCount: 3,
      corroboratingSources: ['bfb-a.test', 'bfb-b.test', 'bfb-c.test'],
      footprint: {
        actors: 4,
        posts: 40,
        localUsersFollowing: 1,
        remoteActorsFollowed: 2,
        localUsersFollowed: 0,
      },
      decidedAt,
      decidedBy: 'bfb-moderator',
      decisionReason: 'The corroboration is real but the evidence does not meet our bar.',
    });
    await copy('blocklistproposals');

    const [row] = await getDb()
      .select()
      .from(blocklistProposals)
      .where(eq(blocklistProposals.id, id.toHexString()));

    // The only record anywhere of why a corroborated domain is NOT blocked.
    expect(row?.decisionReason).toBe(
      'The corroboration is real but the evidence does not meet our bar.'
    );
    expect(row?.decidedBy).toBe('bfb-moderator');
    expect(row?.decidedAt).toStrictEqual(decidedAt);
    expect(row?.status).toBe('declined');
    // Transcribed WHOLE by a person into a policy entry, so the ORDER survives.
    expect(row?.corroboratingSources).toStrictEqual([
      'bfb-a.test',
      'bfb-b.test',
      'bfb-c.test',
    ]);
  });

  it('leaves the decision fields NULL when no person has decided', async () => {
    const id = new ObjectId();
    await mongo.collection('blocklistproposals').insertOne({
      _id: id,
      domain: DOMAIN,
      firstProposedAt: new Date('2025-01-01T00:00:00.000Z'),
      lastSeenAt: new Date('2025-04-01T00:00:00.000Z'),
      operatorCount: 2,
      footprint: {
        actors: 0,
        posts: 0,
        localUsersFollowing: 0,
        remoteActorsFollowed: 0,
        localUsersFollowed: 0,
      },
    });
    await copy('blocklistproposals');

    const [row] = await getDb()
      .select()
      .from(blocklistProposals)
      .where(eq(blocklistProposals.id, id.toHexString()));

    // NULL is "nobody has decided", which is what makes the row appear in the
    // review queue at all. A default here would silently answer for a person.
    expect(row?.decidedAt).toBeNull();
    expect(row?.decidedBy).toBeNull();
    expect(row?.decisionReason).toBeNull();
    expect(row?.status).toBe('open');
  });

  it('keeps every operator verdict, INCLUDING the ones arguing against acting', async () => {
    const id = new ObjectId();
    await mongo.collection('blocklistproposals').insertOne({
      _id: id,
      domain: DOMAIN,
      firstProposedAt: new Date('2025-01-01T00:00:00.000Z'),
      lastSeenAt: new Date('2025-04-01T00:00:00.000Z'),
      operatorCount: 2,
      footprint: {
        actors: 0,
        posts: 0,
        localUsersFollowing: 0,
        remoteActorsFollowed: 0,
        localUsersFollowed: 0,
      },
      observations: [
        { instance: 'bfb-a.test', operator: 'a', severity: 'suspend', resolvedFromDigest: false },
        // `silence` is a DIFFERENT decision and `noop` corroborates nothing.
        // Keeping only the suspends would destroy the evidence `operatorCount`
        // was computed from.
        { instance: 'bfb-b.test', operator: 'b', severity: 'silence', resolvedFromDigest: false },
        { instance: 'bfb-c.test', operator: 'c', severity: 'noop', resolvedFromDigest: true },
      ],
    });
    await copy('blocklistproposals');

    const rows = await getDb()
      .select()
      .from(blocklistProposalObservations)
      .where(eq(blocklistProposalObservations.proposalId, id.toHexString()))
      .orderBy(blocklistProposalObservations.position);

    expect(rows.map((row) => row.severity)).toStrictEqual(['suspend', 'silence', 'noop']);
    // The masked one: the domain came from a digest, not a published name.
    expect(rows[2]?.resolvedFromDigest).toBe(true);
    expect(rows[0]?.resolvedFromDigest).toBe(false);
  });

  it('REFUSES an observation with no resolvedFromDigest rather than guessing', async () => {
    await mongo.collection('blocklistproposals').insertOne({
      _id: new ObjectId(),
      domain: DOMAIN,
      firstProposedAt: new Date('2025-01-01T00:00:00.000Z'),
      lastSeenAt: new Date('2025-04-01T00:00:00.000Z'),
      operatorCount: 1,
      footprint: {
        actors: 0,
        posts: 0,
        localUsersFollowing: 0,
        remoteActorsFollowed: 0,
        localUsersFollowed: 0,
      },
      observations: [{ instance: 'bfb-a.test', operator: 'a', severity: 'suspend' }],
    });

    // A defaulted `false` would credit an operator with publishing a domain name
    // it actually masked — a claim about what a third party did in public.
    await expect(copy('blocklistproposals')).rejects.toThrow(/resolvedFromDigest/);
  });
});

describe('blocklist proposal runs', () => {
  it('keeps ok:false, which is what distinguishes "could not look" from "nothing to block"', async () => {
    const id = new ObjectId();
    await mongo.collection('blocklistproposalruns').insertOne({
      _id: id,
      runId: RUN_ID,
      trigger: 'scheduled',
      startedAt: new Date('2025-05-05T00:00:00.000Z'),
      finishedAt: new Date('2025-05-05T00:01:00.000Z'),
      minOperators: 3,
      sources: [
        { instance: 'bfb-a.test', operator: 'a', outcome: 'unavailable', entries: 0, detail: '502' },
      ],
      counts: {
        domainsObserved: 0,
        clearedOperatorThreshold: 0,
        opened: 0,
        pending: 0,
        suppressedDeclined: 0,
        suppressedBlocked: 0,
        lapsed: 0,
        adopted: 0,
      },
      ok: false,
      failureReason: 'only one source published',
    });
    await copy('blocklistproposalruns');

    const [row] = await getDb()
      .select()
      .from(blocklistProposalRuns)
      .where(eq(blocklistProposalRuns.runId, RUN_ID));

    // Every count is zero on this run, and that reads identically to a healthy
    // sweep that found nothing. `ok` is the ONLY thing that tells them apart.
    expect(row?.ok).toBe(false);
    expect(row?.failureReason).toBe('only one source published');
    expect(row?.countsDomainsObserved).toBe(0);

    const [sourceRow] = await getDb()
      .select()
      .from(blocklistProposalRunSources)
      .where(eq(blocklistProposalRunSources.runRowId, id.toHexString()));
    expect(sourceRow?.outcome).toBe('unavailable');
    expect(sourceRow?.detail).toBe('502');
  });

  it('REFUSES a run with no ok flag rather than assuming it succeeded', async () => {
    // The case the fixture above cannot reach: with `ok` PRESENT, a
    // `bool(...) ?? true` default reads the stored value and looks correct.
    // Only an ABSENT flag exposes it — and defaulting to `true` there turns a
    // run that could not look into one that reports nothing to block, which is
    // the exact confusion `ok` exists to prevent.
    await mongo.collection('blocklistproposalruns').insertOne({
      _id: new ObjectId(),
      runId: RUN_ID,
      trigger: 'scheduled',
      startedAt: new Date('2025-05-05T00:00:00.000Z'),
      finishedAt: new Date('2025-05-05T00:01:00.000Z'),
      minOperators: 3,
      counts: {
        domainsObserved: 0,
        clearedOperatorThreshold: 0,
        opened: 0,
        pending: 0,
        suppressedDeclined: 0,
        suppressedBlocked: 0,
        lapsed: 0,
        adopted: 0,
      },
    });

    await expect(copy('blocklistproposalruns')).rejects.toThrow(/ok/);
  });
});

describe('blocked domain purges', () => {
  it('keeps measured ABSENT for a domain never dry-run', async () => {
    const id = new ObjectId();
    await mongo.collection('blockeddomainpurges').insertOne({
      _id: id,
      domain: DOMAIN,
      state: 'pending',
      firstObservedAt: new Date('2025-06-06T00:00:00.000Z'),
      lastObservedAt: new Date('2025-06-06T00:00:00.000Z'),
    });
    await copy('blockeddomainpurges');

    const [row] = await getDb()
      .select()
      .from(blockedDomainPurges)
      .where(eq(blockedDomainPurges.domain, DOMAIN));

    // Eight zeros would claim a dry run that never happened — and zero is a
    // REAL measurement here (a purge that would remove nothing), so the two
    // states are not interchangeable.
    // Every one of the eight, because a mutation that emitted a COMPLETE
    // zeroed subdocument would satisfy a check on one column alone.
    expect([
      row?.measuredPosts,
      row?.measuredActors,
      row?.measuredBoosts,
      row?.measuredLikes,
      row?.measuredNotifications,
      row?.measuredMediaCacheRows,
      row?.measuredLocalContentKept,
      row?.measuredLocalFollowsRemoved,
    ]).toStrictEqual([null, null, null, null, null, null, null, null]);
  });

  it('keeps a held domain with its reason and its live claim', async () => {
    const id = new ObjectId();
    const claimedAt = new Date('2025-06-07T00:00:00.000Z');
    await mongo.collection('blockeddomainpurges').insertOne({
      _id: id,
      domain: DOMAIN,
      state: 'held',
      firstObservedAt: new Date('2025-06-06T00:00:00.000Z'),
      lastObservedAt: new Date('2025-06-07T00:00:00.000Z'),
      claimedAt,
      runId: RUN_ID,
      heldReason: 'circuit breaker: would remove 40% of stored posts',
      measured: { ...NO_COUNTS, posts: 4000, actors: 12 },
    });
    await copy('blockeddomainpurges');

    const [row] = await getDb()
      .select()
      .from(blockedDomainPurges)
      .where(eq(blockedDomainPurges.domain, DOMAIN));

    // Losing this turns a deliberate HOLD into an unexplained one, and the next
    // operator cannot tell it from a failure.
    expect(row?.heldReason).toBe('circuit breaker: would remove 40% of stored posts');
    expect(row?.state).toBe('held');
    // The claim is carried VERBATIM, same rule as the outbox leases: clearing it
    // would let a second run claim a domain the first may still be purging.
    expect(row?.claimedAt).toStrictEqual(claimedAt);
    expect(row?.runId).toBe(RUN_ID);
    // Measured is present here, so all eight land.
    expect(row?.measuredPosts).toBe(4000);
    expect(row?.measuredActors).toBe(12);
    expect(row?.measuredBoosts).toBe(0);
  });
});

describe('blocked domain purge runs', () => {
  it("keeps the policy's reason AS IT READ THEN", async () => {
    const id = new ObjectId();
    await mongo.collection('blockeddomainpurgeruns').insertOne({
      _id: id,
      domain: DOMAIN,
      runId: RUN_ID,
      runAt: new Date('2025-07-07T00:00:00.000Z'),
      trigger: 'policy_added',
      removed: { ...NO_COUNTS, posts: 120, actors: 3 },
      reason: 'the reason as it read in July',
      category: 'harassment',
      corroboratingSources: ['bfb-a.test'],
    });
    await copy('blockeddomainpurgeruns');

    const [row] = await getDb()
      .select()
      .from(blockedDomainPurgeRuns)
      .where(eq(blockedDomainPurgeRuns.domain, DOMAIN));

    // One says why the domain is blocked NOW, the other why content was deleted
    // THEN. The divergence is the record, and re-reading the live policy to
    // "repair" it would rewrite history.
    expect(row?.reason).toBe('the reason as it read in July');
    expect(row?.removedPosts).toBe(120);
    expect(row?.removedLocalFollowsRemoved).toBe(0);
    expect(row?.corroboratingSources).toStrictEqual(['bfb-a.test']);
  });

  it('keeps corroboratingSources NULL when the run recorded none', async () => {
    const id = new ObjectId();
    await mongo.collection('blockeddomainpurgeruns').insertOne({
      _id: id,
      domain: DOMAIN,
      runId: RUN_ID,
      runAt: new Date('2025-07-07T00:00:00.000Z'),
      trigger: 'manual',
      removed: NO_COUNTS,
    });
    await copy('blockeddomainpurgeruns');

    const [row] = await getDb()
      .select()
      .from(blockedDomainPurgeRuns)
      .where(eq(blockedDomainPurgeRuns.domain, DOMAIN));

    // `default: undefined` in Mongo, so absent rather than `[]`. NULL preserves
    // "not recorded"; `[]` would claim the run found NO corroborating sources,
    // which is a different statement about a manual block.
    expect(row?.corroboratingSources).toBeNull();
  });
});
