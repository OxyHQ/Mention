/**
 * The two `federated_actors` reads that used to sweep the whole table
 * (`drizzle/0141_federated_actors_sweep_indexes.sql`) answer exactly what they
 * answered before, and their predicates are the ones the partial indexes carry.
 *
 * Each reference below is the replaced query, verbatim. Both sides run inside
 * ONE repeatable-read transaction, so a parallel suite's inserts cannot land
 * between them: the comparison is over the same snapshot of the shared table,
 * which also holds rows other suites seeded — more variety, not less.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import {
  closePostgres,
  connectPostgres,
  getDb,
  type DatabaseOrTransaction,
} from '../../db/postgres';
import {
  findAtprotoHistoryBackfillCandidates,
  findKnownBlueskyAccounts,
} from '../../db/federation/actorRepository';
import {
  ATPROTO_CHEAP_HISTORY_POSTS,
  federatedActors,
  federatedFollows,
} from '../../db/schema/federation';
import { BRIDGY_FED_BSKY_HOST } from '../../connectors/shared/bridgyActor';
import {
  clearFederationScope,
  federationScope,
  seedActor,
  seedFollow,
} from '../helpers/federationFixtures';

const scope = federationScope('actor-sweep-indexes');

/** `findKnownBlueskyAccounts` before 0141, verbatim. */
async function knownBlueskyReference(bridgyDomain: string, db: DatabaseOrTransaction) {
  const rows = await db
    .select({ uri: federatedActors.uri, oxyUserId: federatedActors.oxyUserId })
    .from(federatedActors)
    .where(
      and(
        or(eq(federatedActors.protocol, 'atproto'), eq(federatedActors.domain, bridgyDomain)),
        isNotNull(federatedActors.oxyUserId),
        eq(federatedActors.suspended, false),
      ),
    );
  return rows.flatMap((row) => (row.oxyUserId ? [{ uri: row.uri, oxyUserId: row.oxyUserId }] : []));
}

function followedLocallyReference() {
  return sql`exists (
    select 1 from ${federatedFollows}
    where ${federatedFollows.remoteActorUri} = ${federatedActors.uri}
      and ${federatedFollows.direction} = 'outbound'
      and ${federatedFollows.status} = 'accepted'
  )`;
}

/** `findAtprotoHistoryBackfillCandidates` before 0141, verbatim (ids only). */
async function historyReference(
  now: Date,
  cheapPostsCount: number,
  limit: number,
  db: DatabaseOrTransaction,
): Promise<string[]> {
  const rows = await db
    .select({ id: federatedActors.id })
    .from(federatedActors)
    .where(
      and(
        eq(federatedActors.protocol, 'atproto'),
        isNotNull(federatedActors.oxyUserId),
        eq(federatedActors.suspended, false),
        or(
          isNull(federatedActors.outboxBackfillStatus),
          inArray(federatedActors.outboxBackfillStatus, ['pending', 'failed']),
        ),
        or(
          isNull(federatedActors.outboxBackfillLockedUntil),
          lte(federatedActors.outboxBackfillLockedUntil, now),
        ),
        or(
          followedLocallyReference(),
          and(
            isNotNull(federatedActors.lastOutboxSyncAt),
            gt(federatedActors.postsCount, 0),
            lte(federatedActors.postsCount, cheapPostsCount),
          ),
        ),
      ),
    )
    .orderBy(
      sql`${federatedActors.outboxBackfillLastRunAt} asc nulls first`,
      asc(federatedActors.id),
    )
    .limit(limit);
  return rows.map((row) => row.id);
}

function inSnapshot<T>(work: (tx: DatabaseOrTransaction) => Promise<T>): Promise<T> {
  return getDb().transaction(work, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

const NOW = new Date('2026-11-28T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

/**
 * Every state either predicate distinguishes, crossed: backfill status, lock,
 * sync, size around the cheap bound, followed or not, suspended, unlinked, and
 * last-run ties (so the `id` tie-break decides).
 */
async function seedVariety(): Promise<void> {
  const statuses = [null, 'pending', 'failed', 'complete'] as const;
  const locks = [null, new Date(NOW.getTime() - HOUR), new Date(NOW.getTime() + HOUR)];
  const sizes = [0, 1, ATPROTO_CHEAP_HISTORY_POSTS, ATPROTO_CHEAP_HISTORY_POSTS + 1];
  const lastRuns = [null, new Date(NOW.getTime() - 3 * HOUR), new Date(NOW.getTime() - 3 * HOUR)];
  let n = 0;
  for (let round = 0; round < 3; round++)
    for (const status of statuses) {
      for (const lockedUntil of locks) {
        for (const postsCount of sizes) {
          const index = n++;
          const followed = index % 3 === 0;
          const did = `did:plc:sweep${scope.domain.replace(/\W/g, '')}${index}`;
          const actor = await seedActor(scope, {
            protocol: 'atproto',
            uri: did,
            username: `sweep${index}`,
            domain: 'bsky.social',
            acct: `sweep${index}.${scope.domain}`,
            inboxUrl: null,
            outboxUrl: null,
            oxyUserId: index % 11 === 5 ? null : scope.user(`sweep-${index}`),
            suspended: index % 13 === 7,
            outboxBackfillStatus: status,
            outboxBackfillLockedUntil: lockedUntil,
            lastOutboxSyncAt: index % 4 === 1 ? null : new Date(NOW.getTime() - 2 * HOUR),
            postsCount,
            outboxBackfillLastRunAt: lastRuns[index % lastRuns.length],
          });
          if (followed) {
            await seedFollow(scope, {
              localUserId: scope.localUserId,
              remoteActorUri: actor.uri,
              direction: 'outbound',
              status: index % 2 === 0 ? 'accepted' : 'pending',
              network: 'atproto',
            });
          }
        }
      }
    }
  // Two bridged Bluesky accounts, one linked and one not.
  for (const [index, linked] of [true, false].entries()) {
    await seedActor(scope, {
      uri: `https://${BRIDGY_FED_BSKY_HOST}/ap/did:plc:bridged${index}${scope.domain.replace(/\W/g, '')}`,
      username: `bridged${index}`,
      domain: BRIDGY_FED_BSKY_HOST,
      acct: `bridged${index}-${scope.domain}@${BRIDGY_FED_BSKY_HOST}`,
      oxyUserId: linked ? scope.user(`bridged-${index}`) : null,
    });
  }
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await clearFederationScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('findAtprotoHistoryBackfillCandidates', () => {
  it('returns the same candidates in the same order as the single-filter query', async () => {
    await seedVariety();
    for (const limit of [1, 3, 10, 500]) {
      const [expected, actual] = await inSnapshot(async (tx) => [
        await historyReference(NOW, ATPROTO_CHEAP_HISTORY_POSTS, limit, tx),
        (
          await findAtprotoHistoryBackfillCandidates(NOW, ATPROTO_CHEAP_HISTORY_POSTS, limit, tx)
        ).map((candidate) => candidate.id),
      ]);
      expect(actual).toEqual(expected);
      if (limit === 500) expect(actual.length).toBeGreaterThan(10);
    }
  });

  it('keeps the single filter for any other cheap bound, with the same answer', async () => {
    await seedVariety();
    const [expected, actual] = await inSnapshot(async (tx) => [
      await historyReference(NOW, 1, 500, tx),
      (await findAtprotoHistoryBackfillCandidates(NOW, 1, 500, tx)).map(
        (candidate) => candidate.id,
      ),
    ]);
    expect(actual).toEqual(expected);
  });
});

describe('findKnownBlueskyAccounts', () => {
  it('returns the same accounts as the parameterised query', async () => {
    await seedVariety();
    const byUri = (rows: { uri: string; oxyUserId: string }[]) =>
      [...rows].sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
    const [expected, actual] = await inSnapshot(async (tx) => [
      await knownBlueskyReference(BRIDGY_FED_BSKY_HOST, tx),
      await findKnownBlueskyAccounts(tx),
    ]);
    expect(byUri(actual)).toEqual(byUri(expected));
    expect(actual.some((row) => row.uri.includes(BRIDGY_FED_BSKY_HOST))).toBe(true);
  });
});

describe('the 0141 indexes', () => {
  it('exist with the predicates the queries render', async () => {
    const rows = await getDb().execute<{ indexname: string; indexdef: string }>(sql`
      select indexname, indexdef from pg_indexes
      where tablename = 'federated_actors'
        and indexname in ('federated_actors_known_bluesky_idx', 'federated_actors_atproto_cheap_history_idx')
      order by indexname`);
    expect(rows.map((row) => row.indexname)).toEqual([
      'federated_actors_atproto_cheap_history_idx',
      'federated_actors_known_bluesky_idx',
    ]);
    const known = rows.find((row) => row.indexname === 'federated_actors_known_bluesky_idx');
    expect(known?.indexdef).toContain('(uri, oxy_user_id)');
    expect(known?.indexdef).toContain("'bsky.brid.gy'::text");
    const cheap = rows.find(
      (row) => row.indexname === 'federated_actors_atproto_cheap_history_idx',
    );
    expect(cheap?.indexdef).toContain('(outbox_backfill_last_run_at NULLS FIRST, id)');
    expect(cheap?.indexdef).toContain(`posts_count <= ${ATPROTO_CHEAP_HISTORY_POSTS}`);
  });
  // The plans themselves are not asserted: a plan over a table every parallel
  // file writes moves with its statistics (see `hotPathIndexes.test.ts`). The
  // production-sized plans are in the PR that added these indexes.
});
