/**
 * The derived insert order, and the self-reference set it defers.
 *
 * This file exists because a COMMENT got the self-reference set wrong. The code
 * was never wrong — `selfReferencingColumns` reads the foreign keys — but two
 * docblocks and two status reports said `posts.parent_post_id` was the only
 * self-reference in the schema, when `posts` in fact carries four. A claim
 * nothing checks stays wrong indefinitely, so the claim is checked here.
 *
 * These cases deliberately assert against the LIVE schema rather than a frozen
 * fixture: the point is to notice when the schema changes, not to agree with a
 * copy of it.
 */

import { describe, expect, it } from 'vitest';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { is } from 'drizzle-orm';
import * as schema from '../../db/schema';
import { posts } from '../../db/schema/posts';
import { planLevels, selfReferences, selfReferencingColumns } from '../../db/backfill/order';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import { planTables, tableName } from '../../db/backfill/plan';

/** Every table in the schema barrel. */
function allTables(): PgTable[] {
  const tables: PgTable[] = [];
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) tables.push(value);
  }
  return tables;
}

describe('self-references', () => {
  it('finds all FOUR columns on posts, not just parent_post_id', () => {
    // The exact claim two docblocks got wrong. `threadId` is the sharpest of
    // them: a thread's root is frequently NOT the lowest `_id` among its
    // members once federated replies are interleaved.
    expect(selfReferencingColumns(posts)).toStrictEqual([
      'boostOf',
      'parentPostId',
      'quoteOf',
      'threadId',
    ]);
  });

  it('finds no OTHER self-referencing table in the schema', () => {
    const selfReferencing = allTables()
      .filter((table) => selfReferencingColumns(table).length > 0)
      .map((table) => getTableConfig(table).name)
      .sort();
    expect(selfReferencing).toStrictEqual(['posts']);
  });

  it('scans a non-trivial number of tables, so a broken traversal cannot pass', () => {
    // The vacuity floor for the case above: `[] === ['posts']` would fail, but
    // a traversal that found only `posts` and nothing else would pass it while
    // having inspected almost nothing.
    expect(allTables().length).toBeGreaterThanOrEqual(73);
  });
});

describe('planLevels', () => {
  it('puts a plan strictly after every plan it depends on', () => {
    const levels = planLevels(COLLECTION_PLANS);
    const levelOf = new Map<string, number>();
    for (const [index, level] of levels.entries()) {
      for (const plan of level) {
        for (const table of planTables(plan)) levelOf.set(tableName(table), index);
      }
    }

    let checked = 0;
    const unplannedParents: string[] = [];
    for (const plan of COLLECTION_PLANS) {
      const own = new Set(planTables(plan).map(tableName));
      for (const table of planTables(plan)) {
        for (const foreignKey of getTableConfig(table).foreignKeys) {
          const target = foreignKey.reference().foreignTable;
          if (!is(target, PgTable)) continue;
          const targetName = getTableConfig(target).name;
          // A plan's own tables and a self-reference are handled by the
          // per-plan ordering and the deferred pass respectively, not by levels.
          if (own.has(targetName)) continue;
          const parent = levelOf.get(targetName);
          const child = levelOf.get(tableName(table));
          if (parent === undefined || child === undefined) {
            // The parent table has no plan in this run. Recorded rather than
            // skipped silently — it is the difference between "nothing to
            // order" and "the traversal is broken", which the floor below
            // cannot tell apart on its own.
            unplannedParents.push(`${tableName(table)} -> ${targetName}`);
            continue;
          }
          expect(parent, `${targetName} must precede ${tableName(table)}`).toBeLessThan(child);
          checked += 1;
        }
      }
    }
    // The floor, in the only form that is honest TODAY: every cross-plan edge
    // must either have been ORDERED, or name a parent table no plan feeds yet.
    // A traversal that silently found neither would leave both counts at zero,
    // which this refuses.
    //
    // Right now `checked` is 0 and the whole set is unplanned — `likes.post_id`
    // and `bookmarks.post_id` point at `posts`, whose plan is not written. When
    // the `posts` plan lands, those edges move into `checked` and this becomes
    // a real ordering assertion without being edited.
    expect(checked + unplannedParents.length).toBeGreaterThan(0);
    expect(unplannedParents.every((edge) => edge.endsWith('-> posts'))).toBe(true);
  });

  it('places every selected plan exactly once', () => {
    const levels = planLevels(COLLECTION_PLANS);
    const placed = levels.flat();
    expect(placed).toHaveLength(COLLECTION_PLANS.length);
    expect(new Set(placed).size).toBe(COLLECTION_PLANS.length);
  });
});

describe('selfReferences over the live plans', () => {
  it('reports each self-referencing table once, with its columns', () => {
    const found = selfReferences(COLLECTION_PLANS);
    // No engagement plan writes `posts`, so today this is empty — and that is
    // the honest answer rather than a stub. It becomes non-empty the moment the
    // `posts` plan lands, which is what makes this case worth keeping.
    for (const entry of found) {
      expect(entry.columns.length).toBeGreaterThan(0);
    }
    expect(new Set(found.map((entry) => tableName(entry.table))).size).toBe(found.length);
  });
});
