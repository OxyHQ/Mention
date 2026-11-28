import { describe, expect, it } from 'bun:test';
import { isRecord } from '../src/common';

describe('isRecord', () => {
  it('accepts objects and rejects null, arrays and primitives', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    for (const value of [null, undefined, [], [1], 'x', 1, true]) {
      expect(isRecord(value)).toBe(false);
    }
  });
});
