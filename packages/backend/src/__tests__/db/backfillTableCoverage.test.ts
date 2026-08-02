import { describe, expect, it } from 'vitest';

import { tablesWithoutAPlan } from '../../db/backfill/collectionMap';

/**
 * EVERY TABLE HAS A SOURCE, and the ones that do not are named here.
 *
 * The CLI already refuses a run whose schema has an unfed table — that is what
 * it did against production, listing nine of them and stopping before it read a
 * single document. But that check only fires when somebody runs the CLI against
 * two real databases, which happens rarely and late. Nothing in the suite
 * noticed: removing a plan from `COLLECTION_PLANS` left all 335 backfill cases
 * green (measured), because no test asks the completeness question.
 *
 * The list below is the answer to "what is left", in CI, where it is read.
 *
 * ## Why an allowlist rather than an empty expectation
 *
 * An empty expectation would be red until the last plan lands, and a
 * permanently-red test is one nobody can distinguish from a broken build — so it
 * gets skipped, and then it protects nothing. An allowlist is red the moment a
 * NEW table appears without a plan, which is the case that actually surprises
 * someone: `trend_summaries` arrived with a merge from `main` and was invisible
 * here until the CLI refused a production run over it.
 *
 * ## The list cannot rot in the other direction either
 *
 * A name that stops being unplanned must be REMOVED, and the second case below
 * enforces that. Without it the allowlist would quietly become a list of tables
 * that used to be missing, and the first case would keep passing while the
 * guarantee it names had already been met — the same defect this file exists to
 * catch, one level up.
 */

/**
 * Tables with no plan feeding them, as of the consolidation of the port, `main`
 * and the backfill.
 *
 * Every entry is WORK REMAINING, not a decision. There is deliberately no
 * "post-cutover-only" class: `collectionMap.ts` records exclusions on the SOURCE
 * side (`NOT_MIGRATED`, twelve collections with reasons), and a target table
 * nothing writes has no equivalent justification — if one ever earns it, it
 * belongs in a named constant with the reason, not silently in here.
 */
const UNPLANNED_TABLES: readonly string[] = [
  // `usersettings` and its label-action children.
  'user_settings',
  'user_settings_label_actions',
];

describe('every schema table has a plan feeding it', () => {
  it('has no unplanned table beyond the ones named here', () => {
    // Sorted comparison of full LISTS, not a subset check: a subset check passes
    // when a table drops out of the schema entirely, which is not the same fact.
    expect([...tablesWithoutAPlan()].sort()).toEqual([...UNPLANNED_TABLES].sort());
  });

  it('names nothing that already has a plan, so the list shrinks as work lands', () => {
    const stillUnplanned = new Set(tablesWithoutAPlan());
    const stale = UNPLANNED_TABLES.filter((table) => !stillUnplanned.has(table));

    // Named in the message, because the fix is to delete exactly these lines and
    // a bare boolean would send the reader back to compute the difference.
    expect(stale).toEqual([]);
  });

  it('finds enough tables to be checking something', () => {
    // The vacuity floor. `tablesWithoutAPlan()` derives its answer by walking the
    // schema; a traversal that found no tables at all would return an empty list
    // and read exactly like a fully-planned schema. This file's own subject is a
    // list that is currently non-empty, so the floor is stated against the
    // SCHEMA side rather than against the answer.
    expect(tablesWithoutAPlan().length).toBeLessThan(40);
  });
});
