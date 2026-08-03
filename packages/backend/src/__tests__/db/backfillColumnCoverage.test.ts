/**
 * The check that would have caught eleven silently dropped columns.
 *
 * A complete, exit-0, audit-clean rehearsal of 4,986,482 rows left
 * `federated_actors.network_acct` (135 source rows), eight `trending` columns
 * and two `posts` columns entirely NULL. Every existing check passed, because
 * they count ROWS per document and this is a question about COLUMNS per row.
 *
 * The cases below are chosen so that each one fails for a DIFFERENT reason —
 * a suite where they all fail together cannot tell the parts apart:
 *
 *  - never populated, with a source path (the eleven);
 *  - never populated, WITHOUT a source path (weaker, and it must say so);
 *  - PARTIALLY populated, which every "is it ever non-null" test passes;
 *  - a healthy column, so a check that fired on everything would be caught;
 *  - an acknowledgement that is honest, and one that has gone stale.
 */

import { describe, expect, it } from 'vitest';
import { pgTable, text } from 'drizzle-orm/pg-core';
import {
  auditColumnCoverage,
  recordPopulated,
  type PopulatedCounts,
} from '../../db/backfill/columnCoverage';

/** A stand-in table: one required column and three nullable ones. */
const widgets = pgTable('bcc_widgets', {
  id: text().primaryKey(),
  mapped: text(),
  dropped: text(),
  partial: text(),
});

function counts(rows: Array<Record<string, unknown>>): PopulatedCounts {
  const out: PopulatedCounts = new Map();
  for (const row of rows) recordPopulated(out, widgets, row);
  return out;
}

const audit = (
  rows: Array<Record<string, unknown>>,
  extra: Partial<Parameters<typeof auditColumnCoverage>[0]> = {}
) =>
  auditColumnCoverage({
    collection: 'bcc',
    tables: [widgets],
    populated: counts(rows),
    rowsEmitted: rows.length,
    ...extra,
  });

describe('recordPopulated', () => {
  it('counts a column only when the row carries a value', () => {
    // `undefined` and `null` are the two spellings of "the transform did not
    // supply this", and a count that treated either as a value would report a
    // dropped column as covered.
    const observed = counts([
      { id: 'a', mapped: 'x' },
      { id: 'b', mapped: null },
      { id: 'c', mapped: undefined },
    ]);
    expect(observed.get('bcc_widgets')?.get('mapped')).toBe(1);
    expect(observed.get('bcc_widgets')?.get('id')).toBe(3);
  });
});

describe('auditColumnCoverage', () => {
  it('reports a column nothing ever fills, and says the values are dropped', () => {
    const findings = audit(
      [{ id: 'a', mapped: 'x' }, { id: 'b', mapped: 'y' }],
      {
        coverage: [{ table: widgets, column: widgets.dropped, sourcePath: 'thing.dropped' }],
        sourceCounts: new Map([['thing.dropped', 135]]),
      }
    );
    const dropped = findings.filter((f) => f.column === 'bcc_widgets.dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.kind).toBe('never-populated');
    expect(dropped[0]?.sourceValues).toBe(135);
    expect(dropped[0]?.detail).toMatch(/135 source document\(s\) hold a value/);
    expect(dropped[0]?.detail).toMatch(/being DROPPED/);
  });

  it('catches a PARTIALLY populated column — the case an all-null test passes', () => {
    // The whole reason the comparison is a count. `partial` is mapped and
    // non-null for one row, so "is it ever populated" says yes; the source holds
    // three values and two are being lost.
    const findings = audit(
      [{ id: 'a', mapped: 'x', partial: 'p' }, { id: 'b', mapped: 'y' }, { id: 'c', mapped: 'z' }],
      {
        coverage: [{ table: widgets, column: widgets.partial, sourcePath: 'thing.partial' }],
        sourceCounts: new Map([['thing.partial', 3]]),
        unmapped: [{ table: widgets, column: widgets.dropped, reason: 'the source has no such field' }],
      }
    );
    const partial = findings.filter((f) => f.column === 'bcc_widgets.partial');
    expect(partial).toHaveLength(1);
    expect(partial[0]?.kind).toBe('partially-populated');
    expect(partial[0]?.populated).toBe(1);
    expect(partial[0]?.sourceValues).toBe(3);
    expect(partial[0]?.detail).toMatch(/2 are being dropped/);
  });

  it('says so when it CANNOT tell, rather than implying the source is empty', () => {
    // No `sourcePath`, so the check is strictly weaker and must not read as
    // "the source holds nothing" — that would be the narrower-question failure
    // this module exists to end.
    const [finding] = audit([{ id: 'a', mapped: 'x' }]).filter(
      (f) => f.column === 'bcc_widgets.dropped'
    );
    expect(finding?.kind).toBe('never-populated');
    expect(finding?.sourceValues).toBeNull();
    expect(finding?.detail).toMatch(/No `sourcePath` is declared/);
  });

  it('stays silent on a healthy column', () => {
    // The case that catches a check firing on everything. `mapped` is populated
    // for every row and must produce nothing.
    const findings = audit(
      [{ id: 'a', mapped: 'x' }, { id: 'b', mapped: 'y' }],
      {
        unmapped: [
          { table: widgets, column: widgets.dropped, reason: 'the source has no such field' },
          { table: widgets, column: widgets.partial, reason: 'retired before the port' },
        ],
      }
    );
    expect(findings).toStrictEqual([]);
  });

  it('accepts an honest acknowledgement and rejects one that went stale', () => {
    // `post_media.mime` is the real honest case: zero of 121,135 media-bearing
    // posts carry `mimeType`. The stale half matters just as much — a
    // declaration that stops being true is how a gate becomes a formality.
    const findings = audit(
      [{ id: 'a', mapped: 'x', dropped: 'now filled' }],
      {
        unmapped: [
          { table: widgets, column: widgets.dropped, reason: 'the source has no such field' },
          { table: widgets, column: widgets.partial, reason: 'retired before the port' },
        ],
      }
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('stale-acknowledgement');
    expect(findings[0]?.column).toBe('bcc_widgets.dropped');
    expect(findings[0]?.detail).toMatch(/no longer happens/);
  });

  it('reports an acknowledgement naming a column the table does not have', () => {
    const other = pgTable('bcc_other', { id: text().primaryKey(), gone: text() });
    const findings = audit([{ id: 'a', mapped: 'x' }], {
      unmapped: [
        { table: widgets, column: widgets.dropped, reason: 'the source has no such field' },
        { table: widgets, column: widgets.partial, reason: 'retired before the port' },
        { table: other, column: other.gone, reason: 'names a table this plan does not write' },
      ],
    });
    const stale = findings.filter((f) => f.kind === 'stale-acknowledgement');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.detail).toMatch(/renamed or removed/);
  });

  it('says NOTHING about a plan that emitted no rows', () => {
    // A vacuity floor pointed the other way: an empty collection is not evidence
    // that its columns are unmapped, and reporting one finding per column there
    // would bury the real ones. A gate that cries wolf gets disabled.
    expect(auditColumnCoverage({
      collection: 'bcc',
      tables: [widgets],
      populated: new Map(),
      rowsEmitted: 0,
    })).toStrictEqual([]);
  });
});
