/**
 * `findStaleActorsForRefresh` against a real server, because the bug it pins
 * cannot be seen anywhere else.
 *
 * The query compared `last_fetched_at` through a raw `sql` template with the
 * threshold interpolated as a bind parameter. A raw template has no column
 * behind its parameters, so drizzle has no encoder to apply and the `Date` goes
 * to `postgres.js` as-is — which wants a string and throws `The "string"
 * argument must be of type string or an instance of Buffer or ArrayBuffer.
 * Received an instance of Date`. Every tick of the federation-periodic refresh
 * failed on it from the Postgres port (2026-08-02) until this was found in
 * production nearly seven weeks later.
 *
 * `tsc` cannot see it: the template is `SQL`, the threshold is a `Date`, and
 * both are true. A unit test with a mocked driver cannot see it either, because
 * the mock accepts whatever it is handed. Only a real bind raises it — so this
 * suite asserts the POPULATION the query must return, and gets the crash for
 * free on the way.
 *
 * The three rows are the three branches: below the threshold, never fetched
 * (NULL, which `<` alone would discard — the most stale row excluded by the
 * comparison that exists to find it), and above the threshold.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { closePostgres, connectPostgres } from '../../db/postgres';
import { findStaleActorsForRefresh } from '../../db/federation/actorRepository';
import { clearFederationScope, federationScope, seedActor } from '../helpers/federationFixtures';

const scope = federationScope('federation-stale-refresh');

const THRESHOLD = new Date('2026-06-01T00:00:00.000Z');
const BEFORE = new Date('2026-05-01T00:00:00.000Z');
const AFTER = new Date('2026-07-01T00:00:00.000Z');

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await clearFederationScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

/** Only the rows this suite seeded — the query itself is instance-wide. */
async function ownStale(): Promise<string[]> {
  const rows = await findStaleActorsForRefresh(THRESHOLD, [], 500);
  return rows
    .map((row) => row.uri)
    .filter((uri) => uri.startsWith(scope.origin))
    .sort();
}

describe('findStaleActorsForRefresh', () => {
  it('selects the stale and the never-fetched, and skips the fresh', async () => {
    // `oxyUserId` is what makes each row REACHABLE — the query's second
    // predicate — so the staleness comparison is the only thing under test.
    await seedActor(scope, { username: 'stale', oxyUserId: 'oxy-stale', lastFetchedAt: BEFORE });
    await seedActor(scope, { username: 'never', oxyUserId: 'oxy-never', lastFetchedAt: null });
    await seedActor(scope, { username: 'fresh', oxyUserId: 'oxy-fresh', lastFetchedAt: AFTER });

    expect(await ownStale()).toEqual([
      `${scope.origin}/users/never`,
      `${scope.origin}/users/stale`,
    ]);
  });

  it('binds the threshold rather than asserting over it', async () => {
    // The narrowest possible statement of the defect: one row, one comparison,
    // and a call that either binds a `Date` the driver can encode or throws
    // before it ever reaches the planner. Kept separate from the population
    // test so a future change that breaks the BIND is not reported as a change
    // in which rows are selected.
    await seedActor(scope, { username: 'bind', oxyUserId: 'oxy-bind', lastFetchedAt: BEFORE });

    await expect(findStaleActorsForRefresh(THRESHOLD, [], 1)).resolves.toBeInstanceOf(Array);
  });
});
