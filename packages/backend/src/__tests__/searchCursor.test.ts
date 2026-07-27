import { describe, expect, it } from 'vitest';
import { decodeSearchCursor, encodeSearchCursor } from '../utils/searchCursor';

describe('search cursor', () => {
  const id = '65fdc8c8c8c8c8c8c8c8c8c8';
  const createdAt = new Date('2026-01-02T03:04:05.678Z');

  it('round-trips the chronological axis through an opaque v1 token', () => {
    const cursor = encodeSearchCursor(createdAt, id);

    expect(cursor).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain(id);
    expect(decodeSearchCursor(cursor)).toEqual({ createdAt, id });
  });

  it('rejects legacy raw ObjectId cursors', () => {
    expect(decodeSearchCursor(id)).toBeUndefined();
  });

  it('rejects malformed and unknown-version tokens', () => {
    expect(decodeSearchCursor('v1.not*base64')).toBeUndefined();
    expect(decodeSearchCursor('v2.eyJ2IjoyfQ')).toBeUndefined();
    expect(decodeSearchCursor(`v1.${'a'.repeat(600)}`)).toBeUndefined();
  });

  it('refuses to encode an invalid axis', () => {
    expect(() => encodeSearchCursor('not-a-date', id)).toThrow('invalid createdAt');
    expect(() => encodeSearchCursor(createdAt, 'not-an-id')).toThrow('invalid id');
  });
});
