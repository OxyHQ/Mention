/**
 * A migration the apply rule can never reach must stop the run, not be reported
 * as a clean one.
 *
 * ## Why this file touches no database, and `migrationReadiness.test.ts` does
 *
 * The boot gate compares a file on disk against rows in Postgres, so mocking
 * either half would only prove the comparison agrees with itself. This is the
 * opposite shape: the whole question is what the RULE does with a given pair of
 * inputs, and the input that matters — a ledger holding a high-water mark with a
 * hole below it — cannot be staged in the shared test database at all.
 * `drizzle.__drizzle_migrations` is shared by every file in a parallel run, so a
 * file that deleted a row from it to make a hole would break the other 405
 * rather than test this one.
 *
 * So `unreachableEntries` / `planMigrationRun` take the applied timestamps as an
 * ARGUMENT. That is what makes the defect expressible: the hole is a fixture
 * here, and could only be an outage there.
 *
 * ## The fixtures are deliberately not tidy
 *
 * Every case below sits on a side of the distinction the check exists to make.
 * A journal whose entries are all in ascending order cannot tell a high-water
 * filter from a set difference — they agree on every such input — so the
 * out-of-order entry, the equal-to-high-water entry and the never-applied newest
 * entry are each present as their own case.
 */

import { describe, expect, it } from 'vitest';
import {
  UnreachableMigrationError,
  highWaterMillis,
  planLedgerRun as planMigrationRun,
  unreachableEntries,
  type JournalEntry,
} from '@oxyhq/db/migrate';
import { readJournal } from '../../db/migrationsFolder';

/** A journal in the shape a merge of two long-lived branches produces. */
const ENTRIES: JournalEntry[] = [
  { tag: '0000_first', when: 1000 },
  { tag: '0001_second', when: 2000 },
  // Generated on a branch cut before `0001` landed, merged after it. This is
  // the entry the whole file is about.
  { tag: '0002_late_merge', when: 1500 },
  { tag: '0003_after', when: 3000 },
];

describe('highWaterMillis', () => {
  it('is null for an empty ledger rather than -Infinity', () => {
    // `Math.max()` of nothing is -Infinity, which compares as "older than every
    // migration" and would make a fresh database look fully reachable by
    // accident rather than by rule.
    expect(highWaterMillis([])).toBeNull();
  });

  it('takes the maximum, not the last element', () => {
    // The ledger is read without an ORDER BY, so row order is not a guarantee
    // Postgres makes. A rule that trusted position would be right only until a
    // vacuum moved a row.
    expect(highWaterMillis([3000, 1000, 2000])).toBe(3000);
  });
});

describe('unreachableEntries', () => {
  it('finds nothing on a database no migration has touched', () => {
    // drizzle reads the ledger ONCE before its loop, so `!lastDbMigration` holds
    // for every entry of a from-empty run and the out-of-order entry applies
    // like any other. This is why the same journal is safe to create a database
    // with and unsafe to migrate an existing one with.
    expect(unreachableEntries(ENTRIES, [])).toEqual([]);
  });

  it('finds nothing when the ledger has recorded every entry', () => {
    expect(unreachableEntries(ENTRIES, [1000, 2000, 1500, 3000])).toEqual([]);
  });

  it('names the entry that sits BELOW the high-water without a ledger row', () => {
    // The ledger stopped at `0001`. `0002` will never be applied: its `when` is
    // not strictly newer than 2000, so the apply rule steps over it forever.
    expect(unreachableEntries(ENTRIES, [1000, 2000])).toEqual([
      { tag: '0002_late_merge', when: 1500 },
    ]);
  });

  it('treats a timestamp the ledger has recorded as reachable wherever it sits', () => {
    /**
     * This is the set-membership half, and it is what the `<=`/`<` boundary in
     * the implementation is NOT.
     *
     * An earlier version of this test claimed to pin that boundary. It could
     * not: `highWater` is `Math.max(appliedMillis)`, so it is always itself an
     * applied value, and an entry equal to it is therefore always recorded.
     * Mutating `<=` to `<` leaves this whole file green, and 200,000 random
     * inputs produce zero disagreements between the two — an equivalent
     * mutation, recorded here so the next person to mutate it does not read the
     * survivor as an untested boundary.
     *
     * What DOES discriminate is `applied.has`: drop it and every entry below the
     * high-water is reported unreachable, including the ones that ran.
     */
    const entries: JournalEntry[] = [
      { tag: '0000_a', when: 1000 },
      { tag: '0001_b', when: 2000 },
      { tag: '0002_c', when: 3000 },
    ];
    expect(unreachableEntries(entries, [1000, 2000, 3000])).toEqual([]);
    // Same ledger minus the middle row: only the unrecorded one is named.
    expect(unreachableEntries(entries, [1000, 3000])).toEqual([{ tag: '0001_b', when: 2000 }]);
  });

  it('does NOT flag an entry newer than the high-water — that one is merely pending', () => {
    // The distinction the whole change rests on. `0003` is absent from the
    // ledger too, but it WILL apply on the next run, so calling it unreachable
    // would refuse a deploy that is working exactly as intended.
    expect(unreachableEntries(ENTRIES, [1000, 2000, 1500])).toEqual([]);
  });
});

describe('planMigrationRun', () => {
  it('returns the pending entries when every skipped one is genuinely newer', () => {
    expect(planMigrationRun(ENTRIES, [1000, 2000, 1500])).toEqual([
      { tag: '0003_after', when: 3000 },
    ]);
  });

  it('returns the whole journal against an empty ledger', () => {
    expect(planMigrationRun(ENTRIES, [])).toEqual(ENTRIES);
  });

  it('REFUSES rather than reporting a clean run, and names the entry', () => {
    // The exact condition #114 is about: with the ledger at 2000, `pendingEntries`
    // alone returns [] and the migrator prints `No pending Postgres migrations`
    // and exits 0 over a migration that never ran.
    let thrown: unknown;
    try {
      planMigrationRun(ENTRIES, [1000, 2000, 3000]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnreachableMigrationError);
    // The tag is the operational payload: it is read by whoever is holding a
    // frozen deploy, and tells them WHICH migration to regenerate.
    expect((thrown as Error).message).toContain('0002_late_merge');
    expect((thrown as Error).message).toContain('1500');
    expect((thrown as UnreachableMigrationError).entries).toEqual([
      { tag: '0002_late_merge', when: 1500 },
    ]);
  });

  it('refuses on the SILENT path specifically — nothing else is pending', () => {
    // Stated separately because it is what makes the bug invisible today. The
    // refusal has to fire when the pending list is empty, which is the branch
    // that returns early with a success log.
    const ledger = [1000, 2000, 3000];
    expect(unreachableEntries(ENTRIES, ledger)).toHaveLength(1);
    expect(() => planMigrationRun(ENTRIES, ledger)).toThrow(UnreachableMigrationError);
  });

  it('names EVERY unreachable entry, not just the first', () => {
    const entries: JournalEntry[] = [
      { tag: '0000_a', when: 1000 },
      { tag: '0001_b', when: 1200 },
      { tag: '0002_c', when: 1400 },
      { tag: '0003_d', when: 5000 },
    ];
    const error = (() => {
      try {
        planMigrationRun(entries, [1000, 5000]);
        return null;
      } catch (caught) {
        return caught as UnreachableMigrationError;
      }
    })();
    expect(error?.entries.map((entry) => entry.tag)).toEqual(['0001_b', '0002_c']);
  });
});

/**
 * Every entry the real journal strands on an INCREMENTAL walk — apply the
 * entries in journal order and ask, after each one, what has become unreachable.
 *
 * This is a MEASUREMENT of the shipped journal, not a target. Both entries were
 * generated on branches cut before their neighbours landed:
 *
 *   0005_post_trend_terms                 when=1785675946096, below 0003's
 *   0006_trend_labels_and_bridged_identity when=1785678555752, below 0004's
 *
 * A database created from empty applies both — drizzle reads the ledger ONCE
 * before its loop, so `!lastDbMigration` holds for the whole run — which is why
 * production and every per-run test database are unaffected. A database that
 * stopped between them never applies them, and never will.
 */
const KNOWN_STRANDED_TAGS = ['0005_post_trend_terms', '0006_trend_labels_and_bridged_identity'];

describe('the journal shipped in this image', () => {
  it('strands nothing when applied from empty', () => {
    // The case that matters for the cutover: the target database is created by
    // one run of the whole journal.
    const entries = readJournal();
    expect(entries.length).toBeGreaterThanOrEqual(19); // vacuity floor
    expect(unreachableEntries(entries, [])).toEqual([]);
    expect(planMigrationRun(entries, [])).toHaveLength(entries.length);
  });

  it('strands EXACTLY the two known entries on an incremental walk — no more', () => {
    /**
     * The gate, and the reason it is worth a test rather than a note.
     *
     * A migration generated on a branch that has been open a while lands with a
     * `when` below whatever else merged meanwhile, and NOTHING says so today:
     * `db:generate` is happy, CI is happy, the migrator is happy, and the
     * failure surfaces only on a database that stopped in the gap. Pinning the
     * set means the next one to land makes THIS fail, in CI, naming the tag —
     * before it can reach a deploy.
     *
     * Pinned as an exact set rather than a count: a regeneration that fixed
     * `0005` while introducing a new offender would keep the count at two.
     */
    const entries = readJournal();
    const stranded = new Set<string>();
    const applied: number[] = [];
    for (const entry of entries) {
      applied.push(entry.when);
      for (const skipped of unreachableEntries(entries, applied)) stranded.add(skipped.tag);
    }
    const found = [...stranded].sort();
    const appeared = found.filter((tag) => !KNOWN_STRANDED_TAGS.includes(tag));
    const gone = KNOWN_STRANDED_TAGS.filter((tag) => !found.includes(tag));
    const newest = Math.max(...entries.map((entry) => entry.when));

    // The message IS the fix instruction. A gate that reports a changed set
    // without saying what to do about it gets its expected value bumped by
    // whoever hits it next, which converts the gate into a record of the bug.
    expect(
      found,
      [
        appeared.length > 0 &&
          `NEW out-of-order migration(s): ${appeared.join(', ')}.\n` +
          'Each was generated on a branch cut before another branch\'s migration ' +
          'merged, so its journal `when` is below the ledger high-water and it ' +
          'will NEVER be applied to a database already past that point.\n' +
          'FIX IT NOW, while it is free: regenerate so the `when` is newer than ' +
          `every other entry (above ${newest}) — rename drizzle/<tag>.sql AND its ` +
          'record in drizzle/meta/_journal.json.\n' +
          'Do NOT edit the ledger, and do NOT add the tag to KNOWN_STRANDED_TAGS ' +
          'to make this pass — that hides a migration that will never run.',
        gone.length > 0 &&
          `${gone.join(', ')} no longer strand — the hazard is gone. Remove them ` +
          'from KNOWN_STRANDED_TAGS so this test keeps meaning something.',
      ]
        .filter(Boolean)
        .join('\n\n') || 'the stranded set changed'
    ).toEqual(KNOWN_STRANDED_TAGS);
  });

  it('names the step at which the first stranding becomes irreversible', () => {
    // Not decoration: it is what tells whoever hits the refusal whether their
    // database is in the gap. `0005` is lost the moment `0003` is applied —
    // TWO entries before it in journal order, which is exactly why reading the
    // journal top to bottom does not reveal the hazard.
    const entries = readJournal();
    const upToThird = entries
      .filter((entry) => entry.tag.localeCompare('0003') <= 0 || entry.tag.startsWith('0003'))
      .map((entry) => entry.when);
    expect(unreachableEntries(entries, upToThird).map((entry) => entry.tag)).toEqual([
      '0005_post_trend_terms',
    ]);
  });

  it('refuses a run against a database sitting in that gap', () => {
    // End to end on the real journal: the plan for a database that stopped at
    // `0004` is a refusal naming `0005` and `0006`, not a list of pending work.
    const entries = readJournal();
    const upToFourth = entries
      .filter((entry) => entry.tag.localeCompare('0005') < 0)
      .map((entry) => entry.when);
    expect(() => planMigrationRun(entries, upToFourth)).toThrow(UnreachableMigrationError);
    expect(() => planMigrationRun(entries, upToFourth)).toThrow(/0005_post_trend_terms/);
    expect(() => planMigrationRun(entries, upToFourth)).toThrow(
      /0006_trend_labels_and_bridged_identity/
    );
  });
});
