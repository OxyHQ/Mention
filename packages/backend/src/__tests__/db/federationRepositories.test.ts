/**
 * The four federation predicates that a LITERAL Mongo→SQL translation gets
 * wrong, against real rows.
 *
 * Each of these has the same shape: the Mongo original was correct, the obvious
 * SQL is also syntactically valid, and the difference is a population that
 * silently disappears. None of them raises an error, and none is visible in a
 * code review that does not already know the trap. So each is pinned by the
 * POPULATION it must select, not by the SQL it emits.
 *
 * TWO of the three are load-bearing TODAY and mutation-tested: reverting
 * `IS DISTINCT FROM` to `<>` strands a finished actor whose recorded backfill URL
 * is missing, and reverting `ASC NULLS FIRST` to a bare `ASC` starves the
 * never-backfilled actors. The third (`IS NOT TRUE` on the BullMQ drain) is NOT:
 * its column is `NOT NULL`, so both spellings behave identically and no test can
 * distinguish them. That is recorded at the test rather than left to look like an
 * untested guarantee.
 *
 * A fifth case — the actor-type narrowing — is not a translation trap but a
 * deliberate behaviour change, and is pinned for the opposite reason: so that
 * removing it fails loudly rather than taking federation with a whole instance
 * down the first time a remote sends an unrecognized `type`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { closePostgres, connectPostgres } from '../../db/postgres';
import {
  findOutboxBackfillCandidates,
  upsertActor,
} from '../../db/federation/actorRepository';
import {
  findUnmigratedDeliveries,
  insertDelivery,
  markDeliveriesMigrated,
} from '../../db/federation/deliveryQueueRepository';
import { clearFederationScope, federationScope, readActor, seedActor } from '../helpers/federationFixtures';
import { getDb } from '../../db/postgres';
import { federationDeliveryQueue } from '../../db/schema/federation';
import { eq, like } from 'drizzle-orm';

const scope = federationScope('federation-repositories');

/** Far enough in the past that nothing else in the run can hold the lease. */
const PAST = new Date('2020-01-01T00:00:00.000Z');

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await clearFederationScope(scope);
  await getDb()
    .delete(federationDeliveryQueue)
    .where(like(federationDeliveryQueue.targetInbox, `${scope.origin}%`));
});

afterAll(async () => {
  await closePostgres();
});

/** Only the candidates this suite seeded — the query itself is instance-wide. */
async function ownCandidates(now: Date): Promise<string[]> {
  const rows = await findOutboxBackfillCandidates(now, 500);
  return rows.filter((row) => row.uri.startsWith(scope.origin)).map((row) => row.uri);
}

describe('findOutboxBackfillCandidates — the never-backfilled actor', () => {
  it('selects an actor whose backfill has NEVER run (via the null-status branch)', async () => {
    // Selected by `outbox_backfill_status IS NULL`, NOT by the URL comparison —
    // stated because the obvious reading of the `IS DISTINCT FROM` fix is that it
    // is what rescues this population, and it is not. Pinned so a later
    // simplification of the null-status branch is caught too.
    await seedActor(scope, {
      username: 'never',
      oxyUserId: 'oxy-never',
      outboxUrl: `${scope.origin}/users/never/outbox`,
    });

    expect(await ownCandidates(new Date())).toEqual([`${scope.origin}/users/never`]);
  });

  it('selects a FINISHED actor whose recorded backfill URL is missing', async () => {
    // THE row `IS DISTINCT FROM` exists for, and the only shape that
    // discriminates: a terminal status (so neither the null-status branch nor the
    // pending/failed branch fires) with a NULL `outbox_backfill_outbox_url`.
    //
    // The Mongo original was `{$expr: {$ne: ['$outboxBackfill.outboxUrl', '$outboxUrl']}}`,
    // where a MISSING left side compares as null and is therefore `$ne` the
    // outbox URL — true, selected. `<>` in SQL yields NULL for that same row and
    // `WHERE` discards it, so the literal translation strands the actor: it is
    // marked complete against an outbox it has no record of ever reading.
    await seedActor(scope, {
      username: 'halfrecorded',
      oxyUserId: 'oxy-halfrecorded',
      outboxUrl: `${scope.origin}/users/halfrecorded/outbox`,
      outboxBackfillStatus: 'complete',
      outboxBackfillOutboxUrl: null,
    });

    expect(await ownCandidates(new Date())).toEqual([
      `${scope.origin}/users/halfrecorded`,
    ]);
  });

  it('selects an actor whose remote MOVED its outbox, and skips a finished one', async () => {
    await seedActor(scope, {
      username: 'moved',
      oxyUserId: 'oxy-moved',
      outboxUrl: `${scope.origin}/users/moved/outbox-v2`,
      outboxBackfillStatus: 'complete',
      outboxBackfillOutboxUrl: `${scope.origin}/users/moved/outbox-v1`,
    });
    await seedActor(scope, {
      username: 'done',
      oxyUserId: 'oxy-done',
      outboxUrl: `${scope.origin}/users/done/outbox`,
      outboxBackfillStatus: 'complete',
      outboxBackfillOutboxUrl: `${scope.origin}/users/done/outbox`,
    });

    expect(await ownCandidates(new Date())).toEqual([`${scope.origin}/users/moved`]);
  });

  it('serves a NEVER-run actor before one that has already had a pass', async () => {
    // Mongo sorts a missing value FIRST on an ascending sort; Postgres sorts
    // NULLs LAST. Without `NULLS FIRST` the actors that most need a first pass
    // sort behind every actor that has had one, and on any instance with more
    // resolved actors than one batch they are never reached at all.
    await seedActor(scope, {
      username: 'ran',
      oxyUserId: 'oxy-ran',
      outboxUrl: `${scope.origin}/users/ran/outbox`,
      outboxBackfillStatus: 'pending',
      outboxBackfillLastRunAt: PAST,
    });
    await seedActor(scope, {
      username: 'fresh',
      oxyUserId: 'oxy-fresh',
      outboxUrl: `${scope.origin}/users/fresh/outbox`,
    });

    expect(await ownCandidates(new Date())).toEqual([
      `${scope.origin}/users/fresh`,
      `${scope.origin}/users/ran`,
    ]);
  });

  it('skips an actor whose lease is still held', async () => {
    const now = new Date();
    await seedActor(scope, {
      username: 'locked',
      oxyUserId: 'oxy-locked',
      outboxUrl: `${scope.origin}/users/locked/outbox`,
      outboxBackfillLockedUntil: new Date(now.getTime() + 60_000),
    });

    expect(await ownCandidates(now)).toEqual([]);
  });
});

describe('findUnmigratedDeliveries — the row that predates the column', () => {
  it('drains a pending delivery that has never been handed to BullMQ', async () => {
    // This pins the DRAIN, not the operator — and the distinction is worth
    // stating, because mutating `IS NOT TRUE` to `<> true` here does NOT turn
    // this red. `migrated_to_bullmq` is `NOT NULL DEFAULT false`, so there is no
    // NULL for `<>` to swallow and both spellings select the same rows today.
    //
    // `IS NOT TRUE` is kept anyway because the Mongo original's population WAS
    // the absent field (`$ne: true` matches a document that has none), and the
    // total form is the one that survives the column being made nullable. So it
    // is defence against a future schema change, not against a live bug, and the
    // suite says so rather than implying a guarantee it cannot demonstrate.
    await insertDelivery({
      activityJson: { type: 'Create' },
      targetInbox: `${scope.origin}/inbox`,
      senderOxyUserId: scope.localUserId,
      nextAttemptAt: PAST,
    });

    const rows = await findUnmigratedDeliveries(100);
    expect(rows.filter((row) => row.targetInbox.startsWith(scope.origin))).toHaveLength(1);
  });

  it('stops draining a row once it has been handed over', async () => {
    await insertDelivery({
      activityJson: { type: 'Create' },
      targetInbox: `${scope.origin}/inbox`,
      senderOxyUserId: scope.localUserId,
      nextAttemptAt: PAST,
    });
    const [row] = await getDb()
      .select({ id: federationDeliveryQueue.id })
      .from(federationDeliveryQueue)
      .where(eq(federationDeliveryQueue.targetInbox, `${scope.origin}/inbox`));

    await markDeliveriesMigrated([row.id]);

    const rows = await findUnmigratedDeliveries(100);
    expect(rows.filter((r) => r.targetInbox.startsWith(scope.origin))).toHaveLength(0);
  });
});

describe('upsertActor — the actor type Postgres will not store', () => {
  it('narrows an unrecognized remote type to Person instead of failing the insert', async () => {
    // `federated_actors_type_check` admits five values. Mongoose declared the
    // same enum but `findOneAndUpdate` skips validators, so the upsert stored
    // whatever the remote sent. A rejected upsert here fails `fetchRemoteActor`,
    // which means the actor never resolves, no inbound activity from that
    // instance can be attributed, and the only symptom is federation quietly not
    // working with that server. Losing the exact type is the cheaper failure.
    const uri = `${scope.origin}/users/hubzilla`;

    await upsertActor(
      uri,
      {
        protocol: 'activitypub',
        username: 'hubzilla',
        domain: scope.domain,
        acct: `hubzilla@${scope.domain}`,
        summary: '',
        type: 'Hubzilla',
        manuallyApprovesFollowers: false,
        discoverable: true,
        memorial: false,
        suspended: false,
        followersCount: 0,
        followingCount: 0,
        postsCount: 0,
        lastFetchedAt: new Date(),
      },
      [],
    );

    expect((await readActor(uri))?.type).toBe('Person');
  });

  it('preserves a type the schema does admit', async () => {
    const uri = `${scope.origin}/users/lemmy`;

    await upsertActor(
      uri,
      {
        protocol: 'activitypub',
        username: 'lemmy',
        domain: scope.domain,
        acct: `lemmy@${scope.domain}`,
        summary: '',
        type: 'Group',
        manuallyApprovesFollowers: false,
        discoverable: true,
        memorial: false,
        suspended: false,
        followersCount: 0,
        followingCount: 0,
        postsCount: 0,
        lastFetchedAt: new Date(),
      },
      [],
    );

    expect((await readActor(uri))?.type).toBe('Group');
  });
});
