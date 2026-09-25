import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable, pgTable, text } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxy.so/db';
import * as schema from '../../db/schema';
import { isOxyAccountColumn } from '../../db/schema/deferredForeignKeys';
import {
  ACCOUNT_ERASURE_MAP,
  ACCOUNT_REFERENCE_EXTRAS,
  NOT_AN_ACCOUNT_COLUMN,
  erasureKey,
} from '../../services/accountErasure/erasureMap';
import { ERASURE_STEPS, STEPS_PERFORMED_ELSEWHERE } from '../../services/accountErasure/erasureSteps';

/**
 * THE ERASURE GATE (OxyHQ/Mention#1169): a new table carrying an Oxy account id
 * must say what erasing that account does to it, or this file fails on the commit
 * that adds it.
 *
 * It reads the drizzle schema OBJECT (`is(value, PgTable)` over the barrel), the
 * same object that generates the migrations and the queries, so it cannot desync
 * from what the database holds. No database is needed.
 *
 * Three nets, because each misses something the others catch:
 *  1. `isOxyAccountColumn`: the schema's own predicate for account id columns.
 *  2. `ACCOUNT_REFERENCE_EXTRAS`: account ids under other names (arrays,
 *     polymorphic ids, `owner_id`).
 *  3. A deliberately greedy NAME heuristic over SQL names. Anything it flags is
 *     either in the map or dismissed in `NOT_AN_ACCOUNT_COLUMN` with a reason.
 *     This is the net that catches a column named `approved_by` that nobody added
 *     to the predicate.
 */

const ACCOUNT_SHAPED =
  /(^|_)(user|users|owner|author|authors|actor|actors|creator|reporter|reviewer|subscriber|recipient|applicant|poker|poked|muted|blocked|viewer|host|operator)(_id|_ids)?$|_by$|_by_|oxy_user_id/;

interface CensusTable {
  name: string;
  columns: Array<{ key: string; sqlName: string; predicate: boolean }>;
}

function census(tables: readonly PgTable[]): CensusTable[] {
  return tables
    .map((table) => ({
      name: getTableName(table),
      columns: Object.entries(getTableColumns(table)).map(([property, column]) => ({
        key: `${getTableName(table)}.${property}`,
        sqlName: sqlColumnName(column),
        predicate: isOxyAccountColumn(column),
      })),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

const schemaTables: PgTable[] = Object.values(schema).filter((value): value is PgTable => is(value, PgTable));
const tables = census(schemaTables);
const allKeys = new Set(tables.flatMap((table) => table.columns.map((column) => column.key)));
const mapKeys = new Set(ACCOUNT_ERASURE_MAP.map(erasureKey));

/** Columns that MUST have a map entry. */
function requiredKeys(input: readonly CensusTable[]): string[] {
  return input.flatMap((table) =>
    table.columns
      .filter((column) => column.predicate || ACCOUNT_REFERENCE_EXTRAS.has(column.key))
      .map((column) => column.key),
  );
}

/** Columns the heuristic flags. */
function flaggedKeys(input: readonly CensusTable[]): string[] {
  return input.flatMap((table) =>
    table.columns.filter((column) => ACCOUNT_SHAPED.test(column.sqlName)).map((column) => column.key),
  );
}

/** Everything that fails the gate for a set of tables. */
function uncovered(input: readonly CensusTable[]): string[] {
  const missing = requiredKeys(input).filter((key) => !mapKeys.has(key));
  const unexplained = flaggedKeys(input).filter((key) => !mapKeys.has(key) && !NOT_AN_ACCOUNT_COLUMN.has(key));
  return [...new Set([...missing, ...unexplained])].sort();
}

describe('account erasure covers every account column in the schema', () => {
  it('scans a plausible schema (vacuity floor)', () => {
    // Measured on this tree: 104 tables, 82 required account columns, 91
    // flagged by the heuristic, 82 map entries. A traversal that stopped
    // finding anything would pass every check below, so the floors sit just
    // under the real counts.
    expect(tables.length).toBeGreaterThanOrEqual(100);
    expect(requiredKeys(tables).length).toBeGreaterThanOrEqual(78);
    expect(flaggedKeys(tables).length).toBeGreaterThanOrEqual(85);
    expect(ACCOUNT_ERASURE_MAP.length).toBeGreaterThanOrEqual(78);
  });

  it('maps every account column', () => {
    expect(
      uncovered(tables),
      'These columns can hold an Oxy account id but the erasure map does not say what happens to them.\n' +
        'Add an entry to ACCOUNT_ERASURE_MAP (services/accountErasure/erasureMap.ts) with its disposition\n' +
        'and reason, and a step in erasureSteps.ts; or, if the column does not hold an account id, add it\n' +
        'to NOT_AN_ACCOUNT_COLUMN with what it does hold.',
    ).toEqual([]);
  });

  it('fails on a new table with an account column (positive control)', () => {
    // A throwaway table that is never exported or migrated. If the census stops
    // seeing a predicate column, or the heuristic stops seeing an `_by` column,
    // this goes red before the real check above can pass vacuously.
    const probe = pgTable('erasure_gate_probe', {
      id: text().primaryKey(),
      ownerOxyUserId: text(),
      approvedBy: text(),
      title: text(),
    });
    expect(uncovered(census([probe]))).toEqual([
      'erasure_gate_probe.approvedBy',
      'erasure_gate_probe.ownerOxyUserId',
    ]);
  });

  it('names only columns that exist (no stale entries)', () => {
    const stale = [
      ...[...mapKeys].filter((key) => !allKeys.has(key)),
      ...[...ACCOUNT_REFERENCE_EXTRAS.keys()].filter((key) => !allKeys.has(key)),
      ...[...NOT_AN_ACCOUNT_COLUMN.keys()].filter((key) => !allKeys.has(key)),
    ];
    expect(stale).toEqual([]);
  });

  it('dismisses only columns the heuristic actually flags, and never one it maps', () => {
    const flagged = new Set(flaggedKeys(tables));
    const needless = [...NOT_AN_ACCOUNT_COLUMN.keys()].filter((key) => !flagged.has(key));
    expect(needless, 'NOT_AN_ACCOUNT_COLUMN entries the heuristic no longer flags').toEqual([]);
    const both = [...NOT_AN_ACCOUNT_COLUMN.keys()].filter((key) => mapKeys.has(key));
    expect(both, 'a column is either mapped or dismissed, not both').toEqual([]);
  });

  it('has one entry per column', () => {
    const keys = ACCOUNT_ERASURE_MAP.map(erasureKey);
    expect(keys.length).toBe(new Set(keys).size);
  });
});

describe('the erasure map is the program', () => {
  const executable = ACCOUNT_ERASURE_MAP.filter(
    (entry) => entry.disposition !== 'database' && entry.disposition !== 'retain',
  );

  it('binds every executable entry to exactly one step, and every step to an entry', () => {
    const unbound = executable
      .map(erasureKey)
      .filter((key) => !(key in ERASURE_STEPS) && !STEPS_PERFORMED_ELSEWHERE.has(key));
    expect(unbound, 'map entries with no step').toEqual([]);

    const executableKeys = new Set(executable.map(erasureKey));
    const orphaned = [...Object.keys(ERASURE_STEPS), ...STEPS_PERFORMED_ELSEWHERE.keys()].filter(
      (key) => !executableKeys.has(key),
    );
    expect(orphaned, 'steps with no executable map entry').toEqual([]);
  });

  it('gives database and retain entries no step and no phase', () => {
    for (const entry of ACCOUNT_ERASURE_MAP) {
      if (entry.disposition !== 'database' && entry.disposition !== 'retain') continue;
      expect(ERASURE_STEPS[erasureKey(entry)], erasureKey(entry)).toBeUndefined();
      expect(entry.phase, erasureKey(entry)).toBeUndefined();
    }
  });

  it("runs each step in its entry's phase", () => {
    for (const entry of executable) {
      const step = ERASURE_STEPS[erasureKey(entry)];
      if (!step) continue;
      expect(step.phase, erasureKey(entry)).toBe(entry.phase);
    }
  });

  it('gives every entry a reason', () => {
    for (const entry of ACCOUNT_ERASURE_MAP) {
      expect(entry.why.length, erasureKey(entry)).toBeGreaterThan(10);
    }
  });
});
