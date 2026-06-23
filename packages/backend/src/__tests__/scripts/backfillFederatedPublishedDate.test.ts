import { describe, it, expect, vi } from 'vitest';

/**
 * Unit coverage for the pure env-flag parsing of the federated-published-date
 * backfill one-shot. No DB and no federation I/O are touched — the `Post` model
 * and the federation helpers (whose imports pull in mongoose + the media cache
 * graph) are mocked so importing the script never opens a connection. Only the
 * deterministic `parseDryRun` / `parseLimit` / `parseSinceDays` /
 * `parseConcurrency` helpers are exercised.
 */

vi.mock('../../models/Post', () => ({ Post: {} }));
vi.mock('../../services/federation/sharedFederationHelpers', () => ({
  signedFetch: vi.fn(),
  parseApPublished: vi.fn(),
}));

import { parseDryRun, parseLimit, parseSinceDays, parseConcurrency } from '../../scripts/backfillFederatedPublishedDate';

describe('backfillFederatedPublishedDate — parseDryRun', () => {
  it('treats unset / undefined as a live (writing) run', () => {
    expect(parseDryRun(undefined)).toBe(false);
  });

  it('accepts "true" and "1" (case-insensitive, trimmed) as dry-run', () => {
    expect(parseDryRun('true')).toBe(true);
    expect(parseDryRun('TRUE')).toBe(true);
    expect(parseDryRun('  True  ')).toBe(true);
    expect(parseDryRun('1')).toBe(true);
    expect(parseDryRun(' 1 ')).toBe(true);
  });

  it('treats any other value as a live run', () => {
    expect(parseDryRun('false')).toBe(false);
    expect(parseDryRun('0')).toBe(false);
    expect(parseDryRun('')).toBe(false);
    expect(parseDryRun('yes')).toBe(false);
    expect(parseDryRun('2')).toBe(false);
  });
});

describe('backfillFederatedPublishedDate — parseLimit', () => {
  it('returns null (no limit) for unset / empty / whitespace', () => {
    expect(parseLimit(undefined)).toBeNull();
    expect(parseLimit('')).toBeNull();
    expect(parseLimit('   ')).toBeNull();
  });

  it('parses a positive integer scan cap', () => {
    expect(parseLimit('1')).toBe(1);
    expect(parseLimit('500')).toBe(500);
    expect(parseLimit('  250  ')).toBe(250);
  });

  it('ignores non-numeric, ≤0, and non-integer values (treated as no limit)', () => {
    expect(parseLimit('abc')).toBeNull();
    expect(parseLimit('0')).toBeNull();
    expect(parseLimit('-5')).toBeNull();
    expect(parseLimit('12.5')).toBeNull();
    expect(parseLimit('NaN')).toBeNull();
  });
});

describe('backfillFederatedPublishedDate — parseSinceDays', () => {
  // Fixed reference instant so the computed cutoff is deterministic.
  const NOW = Date.parse('2026-06-23T00:00:00.000Z');
  const MS_PER_DAY = 86_400_000;

  it('returns null (no date filter) for unset / empty / whitespace', () => {
    expect(parseSinceDays(undefined, NOW)).toBeNull();
    expect(parseSinceDays('', NOW)).toBeNull();
    expect(parseSinceDays('   ', NOW)).toBeNull();
  });

  it('computes the cutoff `now - days` for a positive integer window', () => {
    const oneDay = parseSinceDays('1', NOW);
    expect(oneDay).toBeInstanceOf(Date);
    expect(oneDay?.getTime()).toBe(NOW - MS_PER_DAY);

    const twoMonths = parseSinceDays('60', NOW);
    expect(twoMonths?.getTime()).toBe(NOW - 60 * MS_PER_DAY);

    const trimmed = parseSinceDays('  7  ', NOW);
    expect(trimmed?.getTime()).toBe(NOW - 7 * MS_PER_DAY);
  });

  it('returns null for non-numeric, ≤0, and non-integer values (no date filter)', () => {
    expect(parseSinceDays('abc', NOW)).toBeNull();
    expect(parseSinceDays('0', NOW)).toBeNull();
    expect(parseSinceDays('-30', NOW)).toBeNull();
    expect(parseSinceDays('1.5', NOW)).toBeNull();
    expect(parseSinceDays('NaN', NOW)).toBeNull();
  });
});

describe('backfillFederatedPublishedDate — parseConcurrency', () => {
  const DEFAULT = 4;
  const MAX = 50;

  it('returns the default (4) for unset / empty / whitespace', () => {
    expect(parseConcurrency(undefined)).toBe(DEFAULT);
    expect(parseConcurrency('')).toBe(DEFAULT);
    expect(parseConcurrency('   ')).toBe(DEFAULT);
  });

  it('uses a valid positive integer within range', () => {
    expect(parseConcurrency('1')).toBe(1);
    expect(parseConcurrency('8')).toBe(8);
    expect(parseConcurrency('  20  ')).toBe(20);
    expect(parseConcurrency('50')).toBe(MAX);
  });

  it('clamps values above the safe max (50) down to 50', () => {
    expect(parseConcurrency('51')).toBe(MAX);
    expect(parseConcurrency('100')).toBe(MAX);
    expect(parseConcurrency('1000')).toBe(MAX);
  });

  it('falls back to the default (4) for non-numeric, ≤0, and non-integer values', () => {
    expect(parseConcurrency('abc')).toBe(DEFAULT);
    expect(parseConcurrency('0')).toBe(DEFAULT);
    expect(parseConcurrency('-5')).toBe(DEFAULT);
    expect(parseConcurrency('1.5')).toBe(DEFAULT);
    expect(parseConcurrency('NaN')).toBe(DEFAULT);
  });
});
