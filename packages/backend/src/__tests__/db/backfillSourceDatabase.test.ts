/**
 * The SOURCE-side guards — the mirror of `targetDatabase.ts`.
 *
 * The gap they close: `assertTargetsEmpty` refuses a target that holds rows and
 * `assertTargetDatabase` refuses a target the operator did not predict, while
 * nothing did either for the source. A copy pointed at an empty or wrong Mongo
 * database discovers zeros, writes nothing, prints `0 row(s) written` and exits
 * 0 — which the runbook reads as success. `--verify-only` cannot catch it
 * because it reads the same `MONGODB_URI`, so a wrong-but-empty source and an
 * empty target agree.
 */

import { describe, expect, it } from 'vitest';
import {
  assertSourceDatabase,
  assertSourceDeclared,
  assertSourceNotEmpty,
  EmptySourceError,
  MissingSourceDatabaseError,
  WrongSourceDatabaseError,
} from '../../db/backfill/sourceDatabase';

describe('the source database identity guard', () => {
  it('accepts the database the operator named', () => {
    expect(() => assertSourceDatabase('mention-production', 'mention-production')).not.toThrow();
  });

  it('REFUSES a different database and names BOTH sides', () => {
    // "Wrong database" tells an operator they are wrong. Naming both ends tells
    // them WHICH of the two is misconfigured, which is the difference between
    // fixing it and re-running it hopefully.
    let raised: unknown;
    try {
      assertSourceDatabase('mention-staging', 'mention-production');
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(WrongSourceDatabaseError);
    const message = (raised as Error).message;
    expect(message).toContain('"mention-production"');
    expect(message).toContain('"mention-staging"');
    expect(message).toContain('MONGODB_URI');
  });

  it('has no opinion about how much data is present, so it cannot cry wolf', () => {
    // The whole reason this is an identity check and not a population floor: a
    // false refusal in the cutover window costs the window. A name match is
    // exact and says nothing about row counts.
    expect(() => assertSourceDatabase('mention-production', 'mention-production')).not.toThrow();
  });

  it('REFUSES a run that never said which source it believes it reads', () => {
    for (const sourceDatabase of [undefined, '', '   ']) {
      expect(() => assertSourceDeclared({ sourceDatabase })).toThrow(MissingSourceDatabaseError);
    }
  });

  it('returns the declared name, trimmed', () => {
    expect(assertSourceDeclared({ sourceDatabase: ' mention-production ' })).toBe(
      'mention-production'
    );
  });
});

describe('the empty-source guard', () => {
  it('REFUSES when every migrated collection is empty', () => {
    let raised: unknown;
    try {
      assertSourceNotEmpty([0, 0, 0]);
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(EmptySourceError);
    // It must not read as "wrong database": the name already matched, so this
    // is the right name on an empty one, and that sends an operator somewhere
    // different.
    expect((raised as Error).message).toContain('correctly named');
    expect((raised as Error).message).toContain('3 migrated collection(s)');
  });

  it('accepts a source where ONE collection holds documents and the rest are empty', () => {
    // The coarsest granularity on purpose. A per-collection floor would refuse
    // this, and a collection that legitimately empties out is exactly how such
    // a floor rots into a false refusal mid-window.
    expect(() => assertSourceNotEmpty([0, 0, 1])).not.toThrow();
  });

  it('accepts a real production shape', () => {
    expect(() => assertSourceNotEmpty([4_989_522, 64_156, 0, 118])).not.toThrow();
  });

  it('REFUSES an empty LIST, rather than passing because there was nothing to add up', () => {
    // `[].reduce(sum, 0)` is 0, so this falls out of the same comparison — but
    // it is a different failure (the discovery pass found no migrated
    // collections at all) and it must not be the one case that slips through.
    expect(() => assertSourceNotEmpty([])).toThrow(EmptySourceError);
  });
});
