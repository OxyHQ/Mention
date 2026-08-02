/**
 * `COLLECTION_PLANS` must name each collection exactly ONCE.
 *
 * This is not tidiness. `COLLECTION_PLANS` is iterated directly by the copy, by
 * the verifier and by every audit, while `classifyCollection` looks a collection
 * up through a `Map` built from the same array — and a `Map` silently keeps the
 * LAST entry for a duplicated key. So a collection listed twice is:
 *
 * - **copied twice**, which the idempotent loader absorbs (so nothing errors),
 * - **counted twice by the verifier**, which re-runs the transforms to compute
 *   how many rows each table should hold — so the expectation doubles while the
 *   actual does not, and a healthy run fails its own check,
 * - **audited under whichever plan the `Map` happened to keep**, which may not
 *   be the one the copy used.
 *
 * It happened. Two agents wrote plans for `articles` and `post_recent_repliers`
 * independently; a merge took both, and `COLLECTION_PLANS` carried 50 entries
 * for 48 collections with nothing anywhere going red — every plan test passed,
 * because each plan was individually correct. The registry is the only place the
 * defect exists, so it is the only place a check can see it.
 *
 * Nothing here touches a database.
 */

import { describe, expect, it } from 'vitest';
import { COLLECTION_PLANS, NOT_MIGRATED } from '../../db/backfill/collectionMap';
import { planTables, tableName } from '../../db/backfill/plan';

describe('the plan registry', () => {
  it('names each collection exactly once', () => {
    const counts = new Map<string, number>();
    for (const plan of COLLECTION_PLANS) {
      counts.set(plan.collection, (counts.get(plan.collection) ?? 0) + 1);
    }

    const duplicated = [...counts]
      .filter(([, count]) => count > 1)
      .map(([collection, count]) => `${collection} (${count} plans)`)
      .sort();

    // The message says what a duplicate DOES, because "duplicate entry" reads
    // like a lint and the consequence is a failed verification on healthy data.
    expect(
      duplicated,
      'collections with more than one plan — copied twice, counted twice by the verifier'
    ).toStrictEqual([]);

    // Vacuity floor: an empty registry would satisfy the assertion above.
    expect(COLLECTION_PLANS.length).toBeGreaterThan(40);
  });

  it('never both maps AND excludes the same collection', () => {
    // The other way to say two contradictory things about one collection. It
    // would not duplicate a copy — `classifyCollection` checks the plan map
    // first — but it WOULD mean the exclusion list carries a written reason
    // that is false, which is worse than a missing one: the next reader trusts
    // it.
    const planned = new Set(COLLECTION_PLANS.map((plan) => plan.collection));
    const both = NOT_MIGRATED.map((entry) => entry.collection)
      .filter((collection) => planned.has(collection))
      .sort();

    expect(both, 'collections that are both mapped and excluded').toStrictEqual([]);
    expect(NOT_MIGRATED.length).toBeGreaterThan(5);
  });

  it('never writes one table from two different collections', () => {
    // A weaker invariant than the first and worth stating separately, because
    // it is the shape a duplicate takes when the two plans have DIFFERENT
    // collection names — a table fed twice, from two sources, with no name in
    // common for the first case to catch.
    //
    // `posts` is the deliberate exception: `post_recent_repliers` and
    // `articles` both reference it, but only the `posts` plan WRITES it, so
    // ownership is what this counts rather than reference.
    const owners = new Map<string, string[]>();
    for (const plan of COLLECTION_PLANS) {
      for (const table of planTables(plan)) {
        const name = tableName(table);
        const existing = owners.get(name);
        if (existing) existing.push(plan.collection);
        else owners.set(name, [plan.collection]);
      }
    }

    const shared = [...owners]
      .filter(([, collections]) => collections.length > 1)
      .map(([table, collections]) => `${table} <- ${collections.sort().join(', ')}`)
      .sort();

    expect(shared, 'tables written by more than one plan').toStrictEqual([]);
    expect(owners.size).toBeGreaterThan(60);
  });
});
