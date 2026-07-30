import { describe, expect, it } from 'vitest';
import { clampFutureDate } from '../../utils/ingestTimestamp';

const HOUR_MS = 60 * 60 * 1000;

describe('clampFutureDate', () => {
  it('accepts a past ISO timestamp verbatim', () => {
    const iso = '2024-01-02T03:04:05.000Z';
    expect(clampFutureDate(iso, HOUR_MS)?.toISOString()).toBe(iso);
  });

  it('accepts a value inside the skew window', () => {
    const soon = new Date(Date.now() + HOUR_MS / 2).toISOString();
    expect(clampFutureDate(soon, HOUR_MS)).toBeInstanceOf(Date);
  });

  it('rejects a value past the skew window', () => {
    const late = new Date(Date.now() + HOUR_MS * 2).toISOString();
    expect(clampFutureDate(late, HOUR_MS)).toBeUndefined();
  });

  it('honours the caller window rather than one shared tolerance', () => {
    const ahead = new Date(Date.now() + 2 * HOUR_MS).toISOString();
    // The same value is bogus under the atproto/MTN window and fine under the
    // wider ActivityPub one — the tolerance is a per-protocol decision.
    expect(clampFutureDate(ahead, HOUR_MS)).toBeUndefined();
    expect(clampFutureDate(ahead, 24 * HOUR_MS)).toBeInstanceOf(Date);
  });

  it('REJECTS rather than re-dating to the clamp edge', () => {
    // A post silently re-dated to `now + window` is the same pin, one window long.
    // Callers need `undefined` so they can fall back to their own default.
    expect(clampFutureDate(new Date(Date.now() + 400 * 24 * HOUR_MS).toISOString(), HOUR_MS)).toBeUndefined();
  });

  it('rejects an unparseable, blank, or non-string value', () => {
    expect(clampFutureDate('banana', HOUR_MS)).toBeUndefined();
    expect(clampFutureDate('', HOUR_MS)).toBeUndefined();
    expect(clampFutureDate('   ', HOUR_MS)).toBeUndefined();
    expect(clampFutureDate(undefined, HOUR_MS)).toBeUndefined();
    expect(clampFutureDate(1735689600000, HOUR_MS)).toBeUndefined();
    expect(clampFutureDate(new Date(), HOUR_MS)).toBeUndefined();
  });

  it('tolerates surrounding whitespace on an otherwise valid value', () => {
    expect(clampFutureDate('  2024-01-02T03:04:05.000Z  ', HOUR_MS)?.toISOString())
      .toBe('2024-01-02T03:04:05.000Z');
  });
});
