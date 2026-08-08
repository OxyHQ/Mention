import { describe, it, expect } from 'vitest';
import { parseApPublished } from '../../connectors/activitypub/helpers';

/**
 * Federated posts MUST preserve their ORIGINAL ActivityPub `published` date as
 * the post's `createdAt`, not the time our server synced them. This guards the
 * two ingredients of that contract:
 *
 *  1. `parseApPublished` correctly maps a valid AP `published` string to a Date
 *     and rejects missing / unparseable / implausibly-future values (so callers
 *     fall back to the schema default — now).
 *
 *  2. (retired) The second half asserted that the Mongoose `Post` schema HONORED
 *     a `createdAt` supplied on a new document rather than overwriting it with
 *     `now` — a Mongoose-9 save-time detail (`timestamps` fills the path only
 *     when it is absent) that the federated insert had to depend on. Postgres
 *     has no such plugin: `created_at` is a column the writer sets outright, and
 *     what it is set to is asserted end-to-end against real rows in
 *     `services/postCreationBaseline.test.ts`. Only the parser is left to unit
 *     test here.
 */

describe('parseApPublished', () => {
  it('maps a valid ISO 8601 published string to a Date', () => {
    const result = parseApPublished('2023-04-01T12:00:00Z');
    expect(result).toBeInstanceOf(Date);
    expect(result?.toISOString()).toBe('2023-04-01T12:00:00.000Z');
  });

  it('trims surrounding whitespace before parsing', () => {
    const result = parseApPublished('  2020-01-15T08:30:00.000Z  ');
    expect(result?.toISOString()).toBe('2020-01-15T08:30:00.000Z');
  });

  it('returns undefined for a missing/non-string value (falls back to now)', () => {
    expect(parseApPublished(undefined)).toBeUndefined();
    expect(parseApPublished(null)).toBeUndefined();
    expect(parseApPublished(1680350400000)).toBeUndefined();
    expect(parseApPublished('')).toBeUndefined();
    expect(parseApPublished('   ')).toBeUndefined();
  });

  it('returns undefined for an unparseable date string', () => {
    expect(parseApPublished('not-a-date')).toBeUndefined();
    expect(parseApPublished('2023-13-99T99:99:99Z')).toBeUndefined();
  });

  it('rejects an implausibly-future date (beyond the 24h skew window)', () => {
    const farFuture = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
    expect(parseApPublished(farFuture)).toBeUndefined();
  });

  it('accepts a slightly-future date within the skew window', () => {
    const nearFuture = new Date(Date.now() + 1000 * 60 * 60).toISOString(); // +1h
    expect(parseApPublished(nearFuture)).toBeInstanceOf(Date);
  });
});
