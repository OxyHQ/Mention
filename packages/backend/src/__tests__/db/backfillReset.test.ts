/**
 * The refusal that keeps `--start-from-empty` away from the read-only modes.
 *
 * `--audit-only` and `--verify-only` promise to write nothing, and the value of
 * that promise is that an operator can rely on it without reading the code.
 * `--start-from-empty` truncates every target table. Combining them asks for
 * two incompatible things, and the failure mode of guessing is the worst one
 * this tool has: rows destroyed by a command whose whole point was that it
 * destroys nothing.
 *
 * These cases assert the refusal FIRES, and — just as importantly — that it
 * does NOT fire for the three combinations that are legitimate. A guard that
 * refused a normal run would be discovered immediately; one that refused
 * nothing would be discovered by an operator who had already lost the data.
 */

import { describe, expect, it } from 'vitest';
import { assertResetIsAllowed, ResetNotAllowedError, targetTables } from '../../db/backfill/reset';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import { planTables, tableName } from '../../db/backfill/plan';

describe('assertResetIsAllowed', () => {
  it('refuses --start-from-empty alongside --audit-only', () => {
    expect(() =>
      assertResetIsAllowed({ startFromEmpty: true, auditOnly: true, verifyOnly: false })
    ).toThrow(ResetNotAllowedError);
  });

  it('refuses --start-from-empty alongside --verify-only', () => {
    expect(() =>
      assertResetIsAllowed({ startFromEmpty: true, auditOnly: false, verifyOnly: true })
    ).toThrow(ResetNotAllowedError);
  });

  it('names the mode it refused, so the message is actionable', () => {
    let thrown: unknown;
    try {
      assertResetIsAllowed({ startFromEmpty: true, auditOnly: true, verifyOnly: false });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ResetNotAllowedError);
    expect((thrown as ResetNotAllowedError).mode).toBe('--audit-only');
    expect((thrown as Error).message).toContain('--audit-only');
  });

  it('allows a destructive run that asked for nothing else', () => {
    expect(() =>
      assertResetIsAllowed({ startFromEmpty: true, auditOnly: false, verifyOnly: false })
    ).not.toThrow();
  });

  it('allows the read-only modes when nothing destructive was asked for', () => {
    expect(() =>
      assertResetIsAllowed({ startFromEmpty: false, auditOnly: true, verifyOnly: false })
    ).not.toThrow();
    expect(() =>
      assertResetIsAllowed({ startFromEmpty: false, auditOnly: false, verifyOnly: true })
    ).not.toThrow();
  });
});

describe('targetTables', () => {
  /**
   * The truncate list is DERIVED from the plans, so a new plan is covered
   * without anyone remembering to extend a literal — and a table a plan writes
   * that this list missed would survive a `--start-from-empty`, leaving exactly
   * the mixture of two points in time the flag exists to remove.
   */
  it('covers every table every plan writes, and nothing else', () => {
    const fromPlans = new Set<string>();
    for (const plan of COLLECTION_PLANS) {
      for (const table of planTables(plan)) fromPlans.add(tableName(table));
    }
    expect(new Set(targetTables())).toEqual(fromPlans);
  });

  it('is not vacuous — there is at least one table to truncate', () => {
    expect(targetTables().length).toBeGreaterThan(0);
  });

  it('is sorted and deduplicated', () => {
    const tables = targetTables();
    expect(tables).toEqual([...new Set(tables)].sort());
  });
});
