import { describe, expect, it } from 'bun:test';
import { decodeChronoCursor, encodeChronoCursor, parseChronoCursor } from '../utils/chronoCursor';

/**
 * The one chronological cursor. Two things are pinned:
 *
 *  - every spelling a list ever MINTED still decodes, because clients hold them
 *    across a deploy and a cursor that stops decoding resets them to page one
 *    (or a 400) mid-scroll;
 *  - the id half accepts exactly the two shapes `@oxy.so/db` mints — a 24-char
 *    ObjectId hex and a uuid v7. Narrower is a client pinned to page one; wider
 *    turns a malformed cursor into a query with a garbage keyset bound.
 */
describe('chrono cursor', () => {
  const objectId = '65fdc8c8c8c8c8c8c8c8c8c8';
  const uuidV7 = '019616a0-0000-7000-8000-00000000000a';
  const createdAt = new Date('2026-01-02T03:04:05.678Z');

  it.each([
    ['a pre-cutover ObjectId', objectId],
    ['a post-cutover uuid v7', uuidV7],
  ])('round-trips the chronological axis for %s', (_label, id) => {
    expect(decodeChronoCursor(encodeChronoCursor(createdAt, id))).toEqual({ createdAt, id });
  });

  it.each([
    ['the feed form', `${createdAt.getTime()}:${uuidV7}`],
    [
      'the v1 token (notifications, search, bookmarks, memberships)',
      `v1.${Buffer.from(JSON.stringify({ v: 1, t: createdAt.getTime(), i: uuidV7 })).toString('base64url')}`,
    ],
    ['the ISO form (follows, reports, applications)', `${createdAt.toISOString()}|${uuidV7}`],
    ['the underscore form (subscriptions, writers)', `${createdAt.getTime()}_${uuidV7}`],
  ])('decodes %s', (_label, cursor) => {
    expect(decodeChronoCursor(cursor)).toEqual({ createdAt, id: uuidV7 });
  });

  it('parses a legacy id-only feed cursor without an instant, which the strict decoder refuses', () => {
    // Only `posts` can recover the instant (`chronoCursorBoundary`).
    expect(parseChronoCursor(objectId)).toEqual({ id: objectId });
    expect(decodeChronoCursor(objectId)).toBeUndefined();
  });

  it('rejects malformed tokens and ids of a shape this database never mints', () => {
    const uuidV4 = '9b2ee2f4-4a1e-4c2e-9a2b-2f1c0d3e4f5a';
    const forgedV1 = `v1.${Buffer.from(JSON.stringify({ v: 1, t: 1, i: 'not-an-id' })).toString('base64url')}`;
    for (const cursor of [
      undefined,
      '',
      'not-an-id',
      uuidV4,
      `${createdAt.getTime()}:not-an-id`,
      `nonsense:${uuidV7}`,
      `not-a-date|${uuidV7}`,
      'v1.not*base64',
      'v2.eyJ2IjoyfQ',
      forgedV1,
      `${createdAt.getTime()}:${'a'.repeat(600)}`,
    ]) {
      expect(parseChronoCursor(cursor)).toBeUndefined();
    }
  });

  it('refuses to encode an invalid axis', () => {
    expect(() => encodeChronoCursor('not-a-date', objectId)).toThrow('invalid createdAt');
    expect(() => encodeChronoCursor(createdAt, 'not-an-id')).toThrow('invalid id');
  });
});
