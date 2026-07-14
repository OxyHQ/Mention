import { describe, expect, it } from 'vitest';
import { queryInt, queryString } from '../utils/queryParams';

/**
 * Regression guard for CodeQL `js/type-confusion-through-parameter-tampering`.
 *
 * `?descriptor[]=for_you` reaches Express as `['for_you']`, not `'for_you'`. The
 * feed controller used to cast it, so a tampered parameter could flow into code
 * that reads it as a string — the interstitial planner hashes the cursor CHARACTER
 * BY CHARACTER, so an array meant an unhandled TypeError and a 500 from a URL
 * anyone could craft.
 */
describe('queryString', () => {
  it('passes a real string through untouched', () => {
    expect(queryString('for_you')).toBe('for_you');
    expect(queryString('')).toBe('');
  });

  it('treats a tampered ARRAY parameter as absent — never coerces it', () => {
    // The coercion trap: String(['for_you']) === 'for_you', so a cast would let
    // this sail through validation and reach the planner as an array.
    expect(queryString(['for_you'])).toBeUndefined();
    expect(queryString(['for_you', 'following'])).toBeUndefined();
  });

  it('treats a tampered OBJECT parameter as absent', () => {
    expect(queryString({ evil: 'for_you' })).toBeUndefined();
    expect(queryString({ 0: 'f', 1: 'o' })).toBeUndefined();
  });

  it('treats an absent parameter as absent', () => {
    expect(queryString(undefined)).toBeUndefined();
    expect(queryString(null)).toBeUndefined();
  });

  it('does not accept non-string primitives', () => {
    expect(queryString(30)).toBeUndefined();
    expect(queryString(true)).toBeUndefined();
  });

  it('never returns a value that lacks string methods', () => {
    // The exact shape of the crash: the planner calls .charCodeAt on the cursor.
    const tampered: unknown[] = [['a', 'b'], { a: 'b' }, 7, true, null, undefined];
    for (const value of tampered) {
      const result = queryString(value);
      expect(result === undefined || typeof result.charCodeAt === 'function').toBe(true);
    }
  });
});

describe('queryInt', () => {
  it('parses a base-10 integer', () => {
    expect(queryInt('25')).toBe(25);
    expect(queryInt('-5')).toBe(-5);
    expect(queryInt(' 25 ')).toBe(25);
  });

  it('preserves parseInt semantics for a trailing-garbage string', () => {
    expect(queryInt('25abc')).toBe(25);
  });

  it('returns 0 for "0" so callers keep their own `|| DEFAULT` fallback', () => {
    expect(queryInt('0')).toBe(0);
  });

  it('treats an unparseable value as absent', () => {
    expect(queryInt('abc')).toBeUndefined();
    expect(queryInt('')).toBeUndefined();
    expect(queryInt(undefined)).toBeUndefined();
  });

  it('treats a tampered ARRAY parameter as absent — parseInt would have coerced it', () => {
    // parseInt(['5']) is 5: the array silently stringifies, so the cast this
    // replaces hid the tampering instead of rejecting it.
    expect(Number.parseInt(['5'] as unknown as string, 10)).toBe(5);
    expect(queryInt(['5'])).toBeUndefined();
  });

  it('treats a multi-value ARRAY as absent — the shape that produced NaN pagination', () => {
    // `?limit=1&limit=2` reached the likes/boosts handlers as Number(['1','2']) ===
    // NaN, which indexed the result set at NaN and threw on the missing document.
    expect(Number(['1', '2'])).toBeNaN();
    expect(queryInt(['1', '2'])).toBeUndefined();
  });

  it('treats a tampered OBJECT parameter as absent', () => {
    expect(queryInt({ $ne: '1' })).toBeUndefined();
  });
});
