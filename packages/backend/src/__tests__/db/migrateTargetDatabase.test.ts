/**
 * The migration guard, tested REFUSAL-FIRST.
 *
 * A guard is only worth what its refusal is worth, and a refusal that cannot be
 * shown to fire is indistinguishable from no guard at all. So every test here
 * asserts the negative case — and the acceptance cases exist mainly to prove
 * the refusals are not firing unconditionally, which is the way a guard passes
 * its own tests while rejecting everything in production.
 *
 * `assertMigrationTarget` is exercised against a REAL database rather than a
 * stubbed client: the whole claim is "`current_database()` disagrees with the
 * flag", and a mock that returns whatever the test tells it to would assert
 * nothing about the query actually being right.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import {
  assertMigrationTarget,
  MissingMigrationTargetError,
  readTargetDatabase,
  WrongMigrationTargetError,
} from '../../db/targetDatabase';

describe('readTargetDatabase', () => {
  it('REFUSES an argv with no --target-database at all', () => {
    expect(() => readTargetDatabase([])).toThrow(MissingMigrationTargetError);
    expect(() => readTargetDatabase(['--dry-run'])).toThrow(MissingMigrationTargetError);
  });

  it('REFUSES a flag present but empty, rather than accepting an empty target', () => {
    // `--target-database=` reads as "I named one" to a `startsWith` check and is
    // the shape a shell produces from an unset variable: `--target-database=$DB`
    // with `DB` unset expands to exactly this.
    expect(() => readTargetDatabase(['--target-database='])).toThrow(MissingMigrationTargetError);
    expect(() => readTargetDatabase(['--target-database=   '])).toThrow(MissingMigrationTargetError);
  });

  it('accepts a named target, so the refusals above are not unconditional', () => {
    expect(readTargetDatabase(['--target-database=mention'])).toBe('mention');
    expect(readTargetDatabase(['--other', '--target-database=mention_audit_probe'])).toBe(
      'mention_audit_probe'
    );
  });

  it('trims, so a trailing newline from a shell substitution is not a different database', () => {
    expect(readTargetDatabase(['--target-database=mention\n'])).toBe('mention');
  });
});

describe('assertMigrationTarget against a real connection', () => {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  let client: postgres.Sql;
  let actualName: string;

  beforeAll(async () => {
    if (!url) throw new Error('TEST_DATABASE_URL or DATABASE_URL must be set');
    client = postgres(url, { max: 1, onnotice: () => {} });
    const rows = await client<{ current_database: string }[]>`select current_database()`;
    actualName = rows[0].current_database;
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
  });

  it('REFUSES when the named target is not the connected database', async () => {
    const wrong = `${actualName}_definitely_not_this_one`;
    await expect(assertMigrationTarget(client, wrong)).rejects.toThrow(WrongMigrationTargetError);
  });

  it('names BOTH sides in the refusal, so an operator knows which end to fix', async () => {
    const wrong = 'mention_audit_probe_wrong';
    await expect(assertMigrationTarget(client, wrong)).rejects.toThrow(
      new RegExp(`${wrong}[\\s\\S]*${actualName}`)
    );
  });

  it('accepts the real name — the positive control for the refusals above', async () => {
    await expect(assertMigrationTarget(client, actualName)).resolves.toBeUndefined();
  });

  it('is case-sensitive and exact, not a prefix match', async () => {
    // `mention` must not satisfy a run aimed at `mention_audit_probe`, nor the
    // reverse. A `startsWith`/`includes` comparison would pass one of these.
    await expect(assertMigrationTarget(client, actualName.slice(0, -1))).rejects.toThrow(
      WrongMigrationTargetError
    );
    await expect(assertMigrationTarget(client, `${actualName}_extra`)).rejects.toThrow(
      WrongMigrationTargetError
    );
    await expect(assertMigrationTarget(client, actualName.toUpperCase())).rejects.toThrow(
      WrongMigrationTargetError
    );
  });
});
