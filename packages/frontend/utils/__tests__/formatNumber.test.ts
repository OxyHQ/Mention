/**
 * Tests run under either jest (frontend `jest-expo` preset) or vitest (workspace
 * runner). Both provide the same describe/it/expect globals.
 *
 * The cases below are the contract the module's own docstring publishes, plus
 * the boundaries where a rounding implementation would over-claim: 9,999 must
 * never read as "10K", because a count that has not reached a threshold must
 * not be shown as having reached it.
 */

import { formatCompactNumber } from '../formatNumber';

describe('formatCompactNumber', () => {
  it('returns numbers below 1,000 unchanged', () => {
    expect(formatCompactNumber(0)).toBe('0');
    expect(formatCompactNumber(1)).toBe('1');
    expect(formatCompactNumber(999)).toBe('999');
  });

  it('renders the docstring examples exactly', () => {
    expect(formatCompactNumber(999)).toBe('999');
    expect(formatCompactNumber(1000)).toBe('1K');
    expect(formatCompactNumber(1500)).toBe('1.5K');
    expect(formatCompactNumber(9999)).toBe('9.9K');
    expect(formatCompactNumber(10000)).toBe('10K');
    expect(formatCompactNumber(12500)).toBe('12.5K');
    expect(formatCompactNumber(1000000)).toBe('1M');
    expect(formatCompactNumber(1200000)).toBe('1.2M');
    expect(formatCompactNumber(1000000000)).toBe('1B');
  });

  it('shows one decimal below 10K, where the old gate suppressed it', () => {
    expect(formatCompactNumber(1100)).toBe('1.1K');
    expect(formatCompactNumber(1999)).toBe('1.9K');
    expect(formatCompactNumber(2900)).toBe('2.9K');
    expect(formatCompactNumber(5050)).toBe('5K');
  });

  it('truncates rather than rounds, so a suffix never over-claims', () => {
    expect(formatCompactNumber(9999)).toBe('9.9K');
    expect(formatCompactNumber(999999)).toBe('999.9K');
    expect(formatCompactNumber(999999999)).toBe('999.9M');
  });

  it('keeps whole multiples bare', () => {
    expect(formatCompactNumber(2000)).toBe('2K');
    expect(formatCompactNumber(100000)).toBe('100K');
    expect(formatCompactNumber(5000000)).toBe('5M');
    expect(formatCompactNumber(3000000000)).toBe('3B');
  });

  it('shows a decimal above 10 units, where the old branches suppressed it', () => {
    expect(formatCompactNumber(12500000)).toBe('12.5M');
    expect(formatCompactNumber(45600000000)).toBe('45.6B');
  });

  it('formats negatives with the same magnitude rules', () => {
    expect(formatCompactNumber(-1500)).toBe('-1.5K');
    expect(formatCompactNumber(-999)).toBe('-999');
    expect(formatCompactNumber(-1200000)).toBe('-1.2M');
  });

  it('falls back to "0" for non-finite input', () => {
    expect(formatCompactNumber(Number.NaN)).toBe('0');
    expect(formatCompactNumber(Number.POSITIVE_INFINITY)).toBe('0');
  });
});
