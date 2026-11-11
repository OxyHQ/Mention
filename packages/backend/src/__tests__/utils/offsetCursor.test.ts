import { describe, expect, it } from 'vitest';
import { decodeOffsetCursor, encodeOffsetCursor } from '../../utils/offsetCursor';

const token = (payload: unknown) =>
  `v1.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;

describe('offset cursor codec', () => {
  it('round-trips an offset and its continuation fields', () => {
    expect(decodeOffsetCursor(encodeOffsetCursor({ offset: 250 }))).toEqual({ offset: 250 });
    expect(
      decodeOffsetCursor(encodeOffsetCursor({ offset: 0, phase: 'mirror', after: 'u1' })),
    ).toEqual({ offset: 0, phase: 'mirror', after: 'u1' });
  });

  it('decodes anything it did not mint to undefined', () => {
    for (const bad of [
      undefined,
      '',
      'o:20',
      'm:abc',
      '20',
      'v1.',
      'v1.!!',
      'v1.bm90LWpzb24',
      token({ offset: -1 }),
      token({ offset: 1.5 }),
      token({ offset: '3' }),
      token({ offset: 1, phase: 2 }),
      `v1.${'a'.repeat(600)}`,
    ]) {
      expect(decodeOffsetCursor(bad)).toBeUndefined();
    }
  });
});
