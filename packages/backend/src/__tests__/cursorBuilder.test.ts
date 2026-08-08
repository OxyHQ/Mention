import { describe, expect, it } from 'vitest';
import { ScoreCursor } from '../mtn/feed/CursorBuilder';

/**
 * A 24-hex id, the shape every post id in this schema still has. Spelled out
 * rather than built through a driver: `ScoreCursor` only ever treats these as
 * opaque strings, so a Mongo ObjectId was never anything but a hex generator.
 */
const oid = (n: number) => `5f${n.toString().padStart(22, '0')}`;

describe('ScoreCursor', () => {
  it('round-trips a versioned snapshot cursor without truncating score precision', () => {
    const score = 1.2345678901234567;
    const asOf = Date.now();
    const cursor = ScoreCursor.build(score, oid(2), {
      asOf,
      excludeIds: [oid(1), oid(2)],
    });

    expect(cursor).toContain('~v1~');
    expect(cursor.endsWith(`:${oid(2)}`)).toBe(true);
    expect(ScoreCursor.parse(cursor)).toEqual({
      score,
      id: oid(2),
      asOf,
      excludeIds: [oid(2), oid(1)],
    });

    // Rollback safety: the previous parser used parseFloat before the first
    // colon and treated everything after it as the ObjectId.
    const colonIdx = cursor.indexOf(':');
    expect(parseFloat(cursor.slice(0, colonIdx))).toBe(score);
    expect(cursor.slice(colonIdx + 1)).toBe(oid(2));
  });

  it('keeps legacy score and ObjectId cursors readable', () => {
    const score = 0.12345678901234568;

    expect(ScoreCursor.parse(`${score}:${oid(1)}`)).toEqual({
      score,
      id: oid(1),
      excludeIds: [oid(1)],
    });
    expect(ScoreCursor.parse(oid(2))).toEqual({
      score: Infinity,
      id: oid(2),
      excludeIds: [oid(2)],
    });
  });

  it('bounds the previous-page exclusion set carried by the cursor', () => {
    const ids = Array.from({ length: 130 }, (_, index) =>
      (index + 1).toString(16).padStart(24, '0'),
    );
    const parsed = ScoreCursor.parse(ScoreCursor.build(1, ids[0], {
      asOf: Date.now(),
      excludeIds: ids,
    }));

    expect(parsed?.excludeIds).toHaveLength(100);
    expect(parsed?.excludeIds?.[0]).toBe(ids[0]);
  });

  it('rejects malformed, future, and out-of-range snapshot metadata without expiring old snapshots', () => {
    const id = oid(1);
    const encode = (metadata: Record<string, unknown>) =>
      Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64url');

    expect(ScoreCursor.parse(`1~v1~not-json:${id}`)).toBeUndefined();
    expect(ScoreCursor.parse(`1~v1~${'a'.repeat(8193)}:${id}`)).toBeUndefined();
    expect(ScoreCursor.parse(`1~v1~${encode({ a: Date.now() - 30 * 24 * 60 * 60 * 1000 })}:${id}`)?.asOf)
      .toBeLessThan(Date.now());
    expect(ScoreCursor.parse(`1~v1~${encode({ a: Date.now() + 6 * 60 * 1000 })}:${id}`)).toBeUndefined();
    expect(ScoreCursor.parse(`1~v1~${encode({ a: 8_640_000_000_000_001 })}:${id}`)).toBeUndefined();
  });
});
