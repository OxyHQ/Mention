import { describe, expect, it } from 'vitest';
import { decodeChronoCursor, encodeChronoCursor } from '../utils/chronoCursor';

/**
 * The id half of this token accepts exactly the two shapes `posts.id` holds —
 * a 24-char ObjectId hex for pre-cutover rows, a uuid v7 for everything after —
 * because that is what `db/ids.ts` says the database can mint.
 *
 * Both directions are pinned below and both are load-bearing. Narrower than the
 * live shapes (the ObjectId-only pattern this used to carry) is a 500 on every
 * paginated search, since the encoder THROWS on an id it does not recognise.
 * Wider — "any non-empty string" — passes the round-trip cases and fails
 * nothing, while turning a malformed cursor from a clean 400 into a query with
 * a garbage keyset bound.
 */
describe('chrono cursor', () => {
  const objectId = '65fdc8c8c8c8c8c8c8c8c8c8';
  const uuidV7 = '019616a0-0000-7000-8000-00000000000a';
  const createdAt = new Date('2026-01-02T03:04:05.678Z');

  it.each([
    ['a pre-cutover ObjectId', objectId],
    ['a post-cutover uuid v7', uuidV7],
  ])('round-trips the chronological axis for %s', (_label, id) => {
    const cursor = encodeChronoCursor(createdAt, id);

    expect(cursor).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain(id);
    expect(decodeChronoCursor(cursor)).toEqual({ createdAt, id });
  });

  it('rejects legacy raw ObjectId cursors', () => {
    expect(decodeChronoCursor(objectId)).toBeUndefined();
  });

  it('rejects malformed and unknown-version tokens', () => {
    expect(decodeChronoCursor('v1.not*base64')).toBeUndefined();
    expect(decodeChronoCursor('v2.eyJ2IjoyfQ')).toBeUndefined();
    expect(decodeChronoCursor(`v1.${'a'.repeat(600)}`)).toBeUndefined();
  });

  it('refuses to encode an invalid axis', () => {
    expect(() => encodeChronoCursor('not-a-date', objectId)).toThrow('invalid createdAt');
    expect(() => encodeChronoCursor(createdAt, 'not-an-id')).toThrow('invalid id');
  });

  it('refuses an id of a shape this database never mints', () => {
    // The other direction, and the reason it needs its own case: a pattern
    // widened to accept anything passes every round-trip above and rejects
    // `'not-an-id'` only by accident of length. A uuid **v4** is well-formed,
    // plausible, and not something `uuidv7()` can produce — so it names a row
    // that cannot exist, and belongs in a 400 rather than in a keyset bound.
    const uuidV4 = '9b2ee2f4-4a1e-4c2e-9a2b-2f1c0d3e4f5a';
    expect(() => encodeChronoCursor(createdAt, uuidV4)).toThrow('invalid id');
    expect(() => encodeChronoCursor(createdAt, `${objectId}extra`)).toThrow('invalid id');
  });

  it('rejects a well-formed token whose id is not a live shape', () => {
    // A cursor is client-supplied, so the DECODER has to enforce the same rule
    // as the encoder — this token is one this server would never mint.
    const forged = `v1.${Buffer.from(
      JSON.stringify({ v: 1, t: createdAt.getTime(), i: 'not-an-id' }),
    ).toString('base64url')}`;

    expect(decodeChronoCursor(forged)).toBeUndefined();
  });
});
