import { describe, it, expect, vi } from 'vitest';

/**
 * Unit coverage for the pure env-flag parsing of the federated-published-date
 * backfill one-shot. No DB and no federation I/O are touched — the `Post` model
 * and the federation helpers (whose imports pull in mongoose + the media cache
 * graph) are mocked so importing the script never opens a connection. Only the
 * deterministic `parseDryRun` / `parseLimit` helpers are exercised.
 */

vi.mock('../../models/Post', () => ({ Post: {} }));
vi.mock('../../services/federation/sharedFederationHelpers', () => ({
  signedFetch: vi.fn(),
  parseApPublished: vi.fn(),
}));

import { parseDryRun, parseLimit } from '../../scripts/backfillFederatedPublishedDate';

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
