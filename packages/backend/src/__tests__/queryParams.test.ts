import { describe, expect, it } from 'vitest';
import { queryString } from '../utils/queryParams';

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
