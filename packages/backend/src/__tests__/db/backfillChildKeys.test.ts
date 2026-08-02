/**
 * Every child table must have a NATURAL unique key — the invariant that makes
 * an interrupted copy converge.
 *
 * `copyCollection` loads one table at a time and deliberately does not wrap a
 * batch in a transaction, so a crash midway leaves a parent with some of its
 * children on disk. The resume re-reads the whole interrupted batch (the
 * checkpoint was never advanced) and re-emits every row, relying on the
 * loader's `INSERT … ON CONFLICT DO NOTHING` to make the ones that already
 * landed no-ops.
 *
 * That `ON CONFLICT` names **no target**, so it fires on any unique constraint.
 * Which one actually catches the duplicate is the part that is easy to get
 * wrong, and I did: the plausible answer is "the derived primary key, because
 * `childRowId` is a pure function of the source", and it is not. Measured —
 * making `childRowId` non-deterministic leaves the convergence test GREEN,
 * because the natural keys catch the duplicates first.
 *
 * So the natural key is load-bearing and the derived id is the backstop. This
 * file asserts the load-bearing half, because it is the half that a new child
 * table can silently lack: add one keyed only by its derived id, and a partial
 * batch becomes a DUPLICATED batch on resume, with `ON CONFLICT DO NOTHING`
 * reporting success either way and no test anywhere going red.
 *
 * Nothing here touches the database — it reads drizzle metadata only.
 */

import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import { tableName } from '../../db/backfill/plan';

/** Unique constraints plus unique indexes — both make `ON CONFLICT` fire. */
function naturalUniqueKeys(table: Parameters<typeof getTableConfig>[0]): string[] {
  const config = getTableConfig(table);
  return [
    ...config.uniqueConstraints.map((constraint) => constraint.name),
    ...config.indexes.filter((index) => index.config.unique).map((index) => index.config.name),
  ];
}

describe('child tables', () => {
  it('every one has a natural unique key, not just a derived primary key', () => {
    const offenders: string[] = [];
    let checked = 0;

    for (const plan of COLLECTION_PLANS) {
      for (const child of plan.childTables ?? []) {
        checked += 1;
        if (naturalUniqueKeys(child).length === 0) {
          offenders.push(`${tableName(child)} (fed by ${plan.collection})`);
        }
      }
    }

    // The message is the point: an offender here is not a style problem, it is
    // a table where a resumed copy can double its rows.
    expect(offenders, 'child tables whose only unique key is the derived id').toEqual([]);

    // The vacuity floor. A traversal that found no child tables at all would
    // satisfy the assertion above while checking nothing. Nine is the number
    // `posts` alone contributes (18 across all plans when this was written) —
    // a floor rather than an equality, so landing a new plan does not churn it,
    // and one that cannot silently drift upward past what is really checked.
    expect(checked).toBeGreaterThanOrEqual(9);
  });

  it('names a real constraint for a child table known to have one', () => {
    // Guards the ACCESSOR rather than the schema: if `naturalUniqueKeys` read
    // the wrong drizzle field it would return `[]` everywhere and the case
    // above would fail loudly — but if it returned something truthy for every
    // table it would pass vacuously. This pins one known answer.
    const authorships = COLLECTION_PLANS.flatMap((plan) => plan.childTables ?? []).find(
      (table) => tableName(table) === 'post_authorships'
    );
    if (authorships === undefined) {
      throw new Error('post_authorships is not a declared child table of any plan');
    }
    expect(naturalUniqueKeys(authorships)).toContain('post_authorships_post_id_oxy_user_id_key');
  });
});
