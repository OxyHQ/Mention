/**
 * The tied-id helper, and the fact it exists because of.
 *
 * Five ranking/pagination suites now state their id ties through
 * `sameMillisecondIds` instead of assuming `uuidv7()` orders two back-to-back
 * inserts. If this helper silently stopped producing TIED ids, or stopped
 * ascending, those suites would keep passing while no longer pinning the case
 * they are written for — so the properties they lean on are asserted here, once.
 */

import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@oxyhq/db';
import { sameMillisecondIds } from './tiedIds';

/** The 48-bit timestamp is the first 12 hex characters, i.e. `xxxxxxxx-xxxx`. */
const timestampOf = (id: string): string => id.slice(0, 13);

describe('sameMillisecondIds', () => {
  it('returns ids that are strictly ascending, so the caller names the winner', () => {
    const ids = sameMillisecondIds(6);

    expect(ids).toHaveLength(6);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(6);
  });

  it('ties every id to ONE millisecond — the case the production tiebreak is for', () => {
    // The vacuity floor. Ids spread across milliseconds would order correctly
    // for the wrong reason, and the suites consuming this would no longer be
    // exercising a tie at all.
    const stamps = new Set(sameMillisecondIds(8).map(timestampOf));

    expect(stamps.size).toBe(1);
  });

  it('mints real uuid v7 values, so post-cutover id checks still classify them', () => {
    for (const id of sameMillisecondIds(4)) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('keeps the random tail random, so parallel suites cannot collide', () => {
    // `rand_b` is the last 12 hex characters. Two calls asking for the same
    // ordinals must not produce the same ids: vitest runs these files in
    // parallel against ONE database.
    const first = sameMillisecondIds(4);
    const second = sameMillisecondIds(4);

    expect(new Set([...first, ...second]).size).toBe(8);
  });

  it('refuses a count it cannot represent rather than silently repeating an id', () => {
    expect(() => sameMillisecondIds(1)).toThrow(RangeError);
    expect(() => sameMillisecondIds(4097)).toThrow(RangeError);
    expect(() => sameMillisecondIds(2.5)).toThrow(RangeError);
  });
});

describe('uuidv7 — the property the fixtures used to assume', () => {
  it('does NOT order two ids minted in the same millisecond by mint order', () => {
    /*
     * This is the claim four suites carried in comments ("uuid v7 is monotonic,
     * so the later insert leads") and it is false: `uuidv7()` is a millisecond
     * timestamp plus `randomFillSync`, with none of RFC 9562's optional
     * monotonic counter. Same-millisecond pairs therefore order on randomness.
     *
     * Asserted as "at least one inversion in a large sample" rather than a rate,
     * so it cannot flake: the measured inversion rate is ~49.3%, so a run of
     * PAIRS same-millisecond comparisons all landing the same way has
     * probability about 2^-PAIRS. The sample is verified to be genuinely tied
     * first, so a future implementation that spaced ids across milliseconds
     * would fail the floor rather than read as "monotonic".
     */
    const SAMPLES = 500;
    let tied = 0;
    let inverted = 0;

    for (let i = 0; i < SAMPLES; i += 1) {
      const earlier = uuidv7();
      const later = uuidv7();
      if (timestampOf(earlier) !== timestampOf(later)) continue;
      tied += 1;
      if (later < earlier) inverted += 1;
    }

    expect(tied).toBeGreaterThan(100);
    expect(inverted).toBeGreaterThan(0);
  });
});
